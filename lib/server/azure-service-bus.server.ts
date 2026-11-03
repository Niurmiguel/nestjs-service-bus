import {
  Server,
  WritePacket,
  CustomTransportStrategy,
  ReadPacket,
} from "@nestjs/microservices";
import { BaseRpcContext } from "@nestjs/microservices/ctx-host/base-rpc.context";
import {
  MessageHandlers,
  ProcessErrorArgs,
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusReceiverOptions,
} from "@azure/service-bus";
import {
  finalize,
  isObservable,
  Observable,
  Observer,
  Subscription,
  take,
  throwError,
} from "rxjs";
import { inspect, InspectOptionsStylized } from "util";

import {
  SB_REPLY_DISPOSED_PROPERTY,
  SB_REPLY_TYPE_PROPERTY,
  SB_REQUEST_ID_PROPERTY,
} from "../azure-service-bus.constants";
import { AzureServiceBusContext } from "../azure-service-bus.context";
import {
  AzureServiceBusServerOptions,
  SbQueueMetadataOptions,
  SbSubscriberTypeMap,
  SbSubscriptionMetadataOptions,
} from "../interfaces";
import {
  describeError,
  quote,
  readDurationOption,
  readTimerOption,
  redactOptions,
} from "../utils";

/** A receiver opened by `bindEvents()` and the subscription it is running. */
interface ActiveReceiver {
  receiver: ServiceBusReceiver;
  subscription: { close(): Promise<void> };
  /** Cancels the SDK's (infinite) reconnect retries when closing. */
  abortController: AbortController;
  /** `options.autoCompleteMessages`, which the server applies itself. */
  autoComplete: boolean;
}

/** What a handler pattern holds once parsed back from Nest's string key. */
interface SubscriberPattern {
  type?: keyof SbSubscriberTypeMap;
  metaOptions: Partial<SbSubscriptionMetadataOptions & SbQueueMetadataOptions>;
}

/** The NestJS 11 processing hooks, read without requiring their types. */
interface ProcessingHooks {
  transportId?: unknown;
  onProcessingStartHook?: (
    transportId: unknown,
    context: unknown,
    done: () => Promise<void>
  ) => unknown;
  onProcessingEndHook?: (transportId: unknown, context: unknown) => void;
}

/**
 * How long `close()` waits for running handlers when not configured: less than
 * the 30 s a platform such as Kubernetes gives a process to stop by default,
 * so that close() can finish before the process is killed.
 */
const DEFAULT_CLOSE_TIMEOUT_MS = 25_000;

/**
 * How long `close()` waits for the subscriptions to stop before it waits for
 * the handlers. Stopping drains the link's credits, which the SDK gives up on
 * after 200 ms; what can take longer is a first subscribe() still retrying to
 * connect (it ends when the retries are cancelled, at the end of close()), and
 * such a receiver has no messages to drain.
 */
const STOP_RECEIVING_WAIT_MS = 1_000;

/** Dead-letter reason of a request whose `replyTo` is not allowed. */
const REPLY_TO_NOT_ALLOWED = "ReplyToNotAllowed";

/** Turns `allowedReplyTo` into a check, copying a list (the caller keeps it). */
function readAllowedReplyTo(
  value: AzureServiceBusServerOptions["allowedReplyTo"]
): ((replyTo: string, message: ServiceBusReceivedMessage) => boolean) | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "function") {
    return value;
  }
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) {
    // Service Bus entity names are not case-sensitive.
    const allowed = new Set(value.map((name) => name.toLowerCase()));
    return (replyTo) => allowed.has(replyTo.toLowerCase());
  }
  throw new TypeError(
    "allowedReplyTo must be a list of entity names or a function (replyTo, message) => boolean"
  );
}

/** What Nest's own exception filter sends for an unknown error. */
const UNKNOWN_EXCEPTION = { status: "error", message: "Internal server error" };

/**
 * Why a handler's Observable stopped being followed: `close()` gave up waiting
 * for it (see `waitForInFlight()`). The message of that handler is left
 * unsettled; nothing else is done with it.
 */
class CancelledByClose extends Error {
  constructor() {
    super("close() cancelled the handler after closeTimeoutInMs");
    this.name = "CancelledByClose";
  }
}

/**
 * A subscription to a handler's Observable (a response, or the result of an
 * event handler) that the server can stop: when a reply cannot be sent, and
 * when `close()` gives up waiting for it.
 */
class FollowedObservable {
  /** Whether its request had its first reply (or gave up on it). */
  replied = false;
  /** Whether `close()` stopped it. */
  cancelledByClose = false;
  private subscription: Subscription | undefined;
  private stopped = false;

  constructor(private readonly onStop: (byClose: boolean) => void) {}

  start(source: Observable<unknown>, observer: Partial<Observer<unknown>>): void {
    const subscription = source.subscribe(observer);
    if (this.stopped) {
      subscription.unsubscribe(); // stopped while subscribing
    } else {
      this.subscription = subscription;
    }
  }

  stop(byClose = false): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.cancelledByClose = byClose;
    this.subscription?.unsubscribe();
    this.subscription = undefined;
    this.onStop(byClose);
  }
}

/** Resolves when `promise` settles, whatever the outcome. */
const settled = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (err) => err
  );

export class AzureServiceBusServer
  extends Server
  implements CustomTransportStrategy
{
  private sbClient: ServiceBusClient;
  /** Receivers kept open while listening, by handler pattern. */
  private readonly receivers = new Map<string, ActiveReceiver>();
  /** Messages being handled right now, so `close()` can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * Handlers' Observables being followed, with what settles once each is
   * over (a response: once its last reply is sent). `close()` waits for them
   * and, when it gives up, unsubscribes them.
   */
  private readonly following = new Map<FollowedObservable, Promise<unknown>>();
  /**
   * Bumped when `close()` gives up on the handlers still running: an
   * Observable that one of them returns later is not subscribed (nothing
   * would cancel it).
   */
  private generation = 0;
  /** `allowedReplyTo`'s verdict per request, so it is asked once. */
  private readonly replyToRejected = new WeakMap<ServiceBusReceivedMessage, boolean>();
  private closing: Promise<void> | undefined;
  /** `options.closeTimeoutInMs`, checked. */
  private readonly closeTimeoutInMs: number;
  /** `options.replyTimeToLiveInMs`, checked. */
  private readonly replyTimeToLiveInMs: number | undefined;
  /** `options.allowedReplyTo` as a check; `undefined` allows every `replyTo`. */
  private readonly isReplyToAllowed:
    | ((replyTo: string, message: ServiceBusReceivedMessage) => boolean)
    | undefined;

  constructor(protected readonly options: AzureServiceBusServerOptions) {
    super();

    this.closeTimeoutInMs =
      readTimerOption("closeTimeoutInMs", options?.closeTimeoutInMs) ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.replyTimeToLiveInMs = readDurationOption(
      "replyTimeToLiveInMs",
      options?.replyTimeToLiveInMs
    );
    this.isReplyToAllowed = readAllowedReplyTo(options?.allowedReplyTo);
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  async listen(callback: (...optionalParams: unknown[]) => any) {
    try {
      await this.closing;
      // A second listen() reuses the client and the receivers already open.
      if (!this.sbClient) {
        this.sbClient = this.createServiceBusClient();
      }
      await this.start(callback);
    } catch (err) {
      // Do not leave half the receivers (and the AMQP connection) open: they
      // would keep the process alive after a failed start.
      await this.close().catch((closeErr) =>
        this.logger.error(
          `Could not close Azure Service Bus after a failed start: ${closeErr}`
        )
      );
      callback(err);
    }
  }

  async start(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void
  ): Promise<void> {
    await this.bindEvents();
    callback();
  }

  /**
   * Opens one receiver per registered handler and keeps it open until
   * `close()`. Handlers that already have a receiver are skipped.
   */
  async bindEvents(): Promise<void> {
    for (const pattern of this.messageHandlers.keys()) {
      if (this.receivers.has(pattern)) {
        continue;
      }
      const { metaOptions } = this.parsePattern(pattern);
      const receiver = this.createReceiver(metaOptions, pattern);
      const abortController = new AbortController();
      const subscription = receiver.subscribe(this.createMessageHandlers(pattern), {
        ...metaOptions.options,
        // Completed by the server after the handler (see processMessage()), so
        // that close() can wait for it instead of racing the SDK.
        autoCompleteMessages: false,
        abortSignal: abortController.signal,
      });
      this.receivers.set(pattern, {
        receiver,
        subscription,
        abortController,
        autoComplete: metaOptions.options?.autoCompleteMessages ?? true,
      });
    }
  }

  public createMessageHandlers = (pattern: string): MessageHandlers => ({
    processMessage: (receivedMessage: ServiceBusReceivedMessage) =>
      this.track(this.processMessage(receivedMessage, pattern)),
    processError: async (args: ProcessErrorArgs): Promise<void> => {
      // The SDK keeps retrying on its own; this is for visibility only. It
      // must resolve: the SDK awaits it before giving up on a subscribe().
      const error = args.error as Error | undefined;
      if (this.closing && error?.name === "AbortError") {
        return; // close() cancelled the SDK's retries on purpose.
      }
      this.logger.error(
        `Azure Service Bus ${args.errorSource} error on ${quote(args.entityPath)}: ${
          error?.message ?? error
        }`,
        error?.stack
      );
    },
  });

  /**
   * Runs the handler. In peekLock mode, unless the handler already settled the
   * message, it then completes it (when `autoCompleteMessages` is not false)
   * or, if the handler failed, abandons it so that it is delivered again.
   */
  private async processMessage(
    receivedMessage: ServiceBusReceivedMessage,
    pattern: string
  ): Promise<void> {
    const active = this.receivers.get(pattern);
    const peekLock = active?.receiver.receiveMode === "peekLock";
    if (this.rejectsReplyTo(receivedMessage)) {
      await this.deadLetterRejected(receivedMessage, active, peekLock);
      return;
    }
    let failure: { err: unknown } | undefined;
    try {
      await this.handleMessage(receivedMessage, pattern);
    } catch (err) {
      failure = { err };
    }

    // Same check the SDK's own settlement uses.
    const delivery = (receivedMessage as { delivery?: { remote_settled?: boolean } })
      .delivery;
    const settled = delivery?.remote_settled === true;

    if (failure?.err instanceof CancelledByClose) {
      // close() gave up on it and is closing the receiver: left unsettled,
      // the message is delivered again once its lock expires.
      return;
    }
    if (failure) {
      await this.abandonAfterFailure(receivedMessage, active, peekLock && !settled, failure.err);
      return;
    }
    if (!active?.autoComplete || !peekLock || settled) {
      return;
    }
    try {
      await active.receiver.completeMessage(receivedMessage);
    } catch (err) {
      // As with the SDK's auto-completion: report it, the lock will expire
      // and the message will be redelivered.
      this.logger.error(
        `Could not complete message ${quote(receivedMessage.messageId)} on ${quote(
          active.receiver.entityPath
        )}: ${
          (err as Error)?.message ?? err
        }`,
        (err as Error)?.stack
      );
    }
  }

  private async abandonAfterFailure(
    message: ServiceBusReceivedMessage,
    active: ActiveReceiver | undefined,
    abandon: boolean,
    err: unknown
  ): Promise<void> {
    const where = `message ${quote(message.messageId)} on ${quote(active?.receiver.entityPath)}`;
    if (!abandon) {
      // receiveAndDelete (the message is gone), or the handler settled it.
      this.logger.error(`The handler of ${where} failed: ${describeError(err)}`);
      return;
    }
    try {
      await active.receiver.abandonMessage(message);
      this.logger.warn(
        `The handler of ${where} failed; the message was abandoned and will be delivered ` +
          `again (and dead-lettered after the max delivery count): ${describeError(err)}`
      );
    } catch (abandonErr) {
      this.logger.error(
        `The handler of ${where} failed (${describeError(err)}) and the message could not be ` +
          `abandoned; it is delivered again when its lock expires: ${describeError(abandonErr)}`
      );
    }
  }

  /**
   * Whether `message` is a request whose `replyTo` the `allowedReplyTo`
   * option does not allow. Logs a warning when it is. `allowedReplyTo` is
   * asked once per message: `processMessage()` and `handleMessage()` both
   * check, and a function that answered differently the second time would
   * get a request completed with no reply.
   */
  private rejectsReplyTo(message: ServiceBusReceivedMessage): boolean {
    const { replyTo } = message;
    if (!replyTo || !this.isReplyToAllowed) {
      return false;
    }
    const known = this.replyToRejected.get(message);
    if (known !== undefined) {
      return known;
    }
    const rejected = !this.isReplyToAllowedFor(message, replyTo);
    this.replyToRejected.set(message, rejected);
    return rejected;
  }

  /** Asks `allowedReplyTo`; logs a warning when it denies. */
  private isReplyToAllowedFor(message: ServiceBusReceivedMessage, replyTo: string): boolean {
    let allowed = false;
    try {
      allowed = this.isReplyToAllowed(replyTo, message) === true;
    } catch (err) {
      this.logger.error(`allowedReplyTo threw for replyTo ${quote(replyTo)}: ${describeError(err)}`);
    }
    if (!allowed) {
      this.logger.warn(
        `Ignored the request ${quote(message.messageId)}: its replyTo ${quote(replyTo)}` +
          `${
            message.replyToSessionId ? ` (session ${quote(message.replyToSessionId)})` : ""
          } is not allowed by allowedReplyTo. The handler did not run and no reply was sent.`
      );
    }
    return allowed;
  }

  /** Settles a request that `rejectsReplyTo()`: it is never valid, so no retry. */
  private async deadLetterRejected(
    message: ServiceBusReceivedMessage,
    active: ActiveReceiver | undefined,
    peekLock: boolean
  ): Promise<void> {
    if (!peekLock || !active) {
      return; // receiveAndDelete: the message is gone already.
    }
    try {
      await active.receiver.deadLetterMessage(message, {
        deadLetterReason: REPLY_TO_NOT_ALLOWED,
        deadLetterErrorDescription: "The replyTo of this request is not allowed by the server.",
      });
    } catch (err) {
      this.logger.error(
        `Could not dead-letter the request ${quote(message.messageId)}; it is delivered again ` +
          `when its lock expires: ${describeError(err)}`
      );
    }
  }

  /**
   * Nest's `handleEvent()` neither waits for an Observable returned by the
   * handler nor reports its error, and an error thrown by a handler reaches
   * it as exactly that: an Observable that errors (Nest's exception filter).
   * This one waits for the handler, Observable included, and rejects when it
   * fails, so that the message can be abandoned rather than completed.
   */
  public async handleEvent(
    pattern: string,
    packet: ReadPacket,
    context: BaseRpcContext
  ): Promise<any> {
    const handler = this.getHandlerByPattern(pattern);
    if (!handler) {
      return this.logger.error(
        `There is no matching event handler defined in the remote service. Event pattern: ${quote(pattern)}`
      );
    }
    // Processing hooks exist since NestJS 11.
    const hooks = this as unknown as ProcessingHooks;
    const end = () => hooks.onProcessingEndHook?.(hooks.transportId, context);
    const generation = this.generation;
    const run = async () => {
      const resultOrStream = await handler(packet.data, context);
      if (!isObservable(resultOrStream)) {
        end();
      } else if (generation !== this.generation) {
        end();
        throw new CancelledByClose(); // returned after close() gave up on it
      } else {
        await this.followToEnd(resultOrStream.pipe(finalize(end)));
      }
    };
    if (!hooks.onProcessingStartHook) {
      return run();
    }
    // The hook decides when (and whether) the handler runs; it may not return
    // what `done` returns, so the outcome is kept here.
    let outcome: Promise<void> | undefined;
    await hooks.onProcessingStartHook(hooks.transportId, context, () => {
      outcome = run();
      outcome.catch(() => undefined); // awaited below
      return outcome;
    });
    await outcome;
  }

  public async handleMessage(
    receivedMessage: ServiceBusReceivedMessage,
    pattern: string
  ): Promise<void> {
    const generation = this.generation;
    const partialPacket = { data: receivedMessage, pattern };
    const packet = await this.deserializer.deserialize(partialPacket);
    const receiver = this.receivers.get(pattern)?.receiver;
    const sbContext = new AzureServiceBusContext([receiver, receivedMessage]);

    if (!receivedMessage.replyTo) {
      return this.handleEvent(packet.pattern, packet, sbContext);
    }
    if (this.rejectsReplyTo(receivedMessage)) {
      return; // processMessage() settles it; a direct call only gets no reply.
    }

    // Whatever goes wrong, the client gets a reply: an error, not silence.
    let response$: Observable<unknown>;
    try {
      const handler = this.getHandlerByPattern(pattern);
      if (!handler) {
        throw new Error(`There is no handler for the request pattern ${quote(pattern)}`);
      }
      response$ = this.transformToObservable(await handler(receivedMessage, sbContext));
    } catch (err) {
      response$ = throwError(() => err);
    }
    await this.sendReply(response$, receivedMessage, generation);
  }

  /**
   * Returns the function that publishes one reply packet to `replyTo`. The
   * reply carries `correlationId` and, when the request asked for one
   * (`replyToSessionId`), the reply session.
   */
  public getPublisher(replyTo: string, correlationId: string, sessionId?: string) {
    return async (data: WritePacket) => {
      const sender = this.sbClient.createSender(replyTo);
      const type = data.err ? "error" : "response" in data ? "response" : "none";
      const responseMessage: ServiceBusMessage = {
        correlationId,
        body: data.err ?? data.response,
        applicationProperties: {
          [SB_REPLY_TYPE_PROPERTY]: type,
          [SB_REPLY_DISPOSED_PROPERTY]: data.isDisposed === true,
        },
        ...(sessionId && { sessionId }),
        ...(this.replyTimeToLiveInMs !== undefined && { timeToLive: this.replyTimeToLiveInMs }),
      };
      try {
        await sender.sendMessages([responseMessage]);
      } finally {
        await sender.close();
      }
    };
  }

  createServiceBusClient(): ServiceBusClient {
    const { connectionString, options } = this.options;
    return new ServiceBusClient(connectionString, options);
  }

  /**
   * Returns the underlying `ServiceBusClient` (NestJS 11+ API).
   */
  unwrap<T = ServiceBusClient>(): T {
    if (!this.sbClient) {
      throw new Error(
        'Not initialized. Please call the "listen"/"startAllMicroservices" method before accessing the server.'
      );
    }
    return this.sbClient as T;
  }

  /**
   * Status/event listeners (NestJS 11+ API) are not supported by this transport.
   */
  on(_event: string, _callback: unknown): never {
    throw new Error("Method not implemented.");
  }

  /**
   * Stops receiving, waits for the messages being handled and the responses
   * still being sent (up to `closeTimeoutInMs`, then unsubscribes them), then
   * closes the receivers and the client. Calls made while closing share the
   * same work.
   */
  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = this.closeAll().finally(() => {
        this.closing = undefined;
      });
    }
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    // The map is kept until the end: messages still in flight need their
    // receiver to be settled.
    const active = [...this.receivers.values()];

    // 1. No new messages. The links stay open, so the messages being handled
    //    can still be settled.
    const stopping = active.map(({ subscription }) => settled(subscription.close()));
    await this.waitUpTo(STOP_RECEIVING_WAIT_MS, Promise.all(stopping));

    // 2. Let the handlers in flight finish (a drain can still deliver one),
    //    for up to closeTimeoutInMs; then their Observables are unsubscribed.
    await this.waitForInFlight();

    // 3. Close the links, and only then cancel the SDK's reconnect retries.
    //    In that order on purpose: aborting while the SDK is attaching a link
    //    made @azure/service-bus 7.9.x close that link without handling its
    //    error, an unhandled rejection that ends the process when the entity
    //    rejects the link (e.g. it does not exist). receiver.close() waits for
    //    an attach in progress, and afterwards the SDK starts no other.
    const failures = (
      await Promise.all(active.map(({ receiver }) => settled(receiver.close())))
    ).filter((err) => err !== undefined);
    for (const { abortController } of active) {
      abortController.abort();
    }
    for (const err of failures) {
      this.logger.error(`Could not close an Azure Service Bus receiver: ${describeError(err)}`);
    }
    await Promise.all(stopping);
    this.receivers.clear();

    // 4. The connection. A failure is logged, not thrown: Nest stops its own
    //    shutdown (the other servers, the onApplicationShutdown hooks) at the
    //    first close() that rejects, and there is nothing left to retry here.
    const client = this.sbClient;
    this.sbClient = undefined;
    const closeErr = client ? await settled(client.close()) : undefined;
    if (closeErr !== undefined) {
      this.logger.error(
        `Could not close the Azure Service Bus connection: ${describeError(closeErr)}`,
        closeErr instanceof Error ? closeErr.stack : undefined
      );
    }
  }

  /** Waits for `work` to settle, for at most `ms`. */
  private async waitUpTo(ms: number, work: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    try {
      await Promise.race([work, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Waits for the handlers in flight, and the responses they are still
   * sending, for up to `closeTimeoutInMs`. When that runs out it unsubscribes
   * their Observables, stops tracking them (a later close() does not wait for
   * them again), logs a warning and returns: closing the receivers then leaves
   * the messages of the handlers still running unsettled, and Service Bus
   * delivers them again once their lock expires.
   */
  private async waitForInFlight(): Promise<void> {
    const pending = () => [...this.inFlight, ...this.following.values()];
    const allDone = (async () => {
      for (let work = pending(); work.length > 0; work = pending()) {
        await Promise.all(work.map(settled));
      }
    })();
    const limit = this.closeTimeoutInMs;
    if (limit === Infinity) {
      return allDone;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), limit);
    });
    try {
      if (await Promise.race([allDone.then(() => false), timedOut])) {
        this.giveUpOnInFlight(limit);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** What `waitForInFlight()` does when `closeTimeoutInMs` runs out. */
  private giveUpOnInFlight(limit: number): void {
    const handlers = this.inFlight.size;
    const followed = [...this.following.keys()];
    // Responses whose request already had its reply: their message was
    // completed (the others belong to the handlers counted above).
    const streams = followed.filter((stream) => stream.replied).length;
    this.generation++;
    for (const stream of followed) {
      stream.stop(true);
    }
    this.following.clear();
    this.inFlight.clear();

    const outcome: string[] = [];
    if (handlers > 0) {
      outcome.push(
        `${handlers} message handler(s) still running: their messages are not settled and, ` +
          "in peekLock mode, Service Bus delivers them again once their lock expires"
      );
    }
    if (streams > 0) {
      outcome.push(
        `${streams} streamed response(s) cancelled whose request was already completed: ` +
          "their clients get no further replies (clients since 1.2.0 fail after their " +
          "replyTimeoutInMs, if set)"
      );
    }
    this.logger.warn(
      `close() waited ${limit} ms (closeTimeoutInMs) and closes the receivers anyway; the ` +
        `Observables of the handlers still running were unsubscribed. ${
          outcome.length > 0 ? `${outcome.join(". ")}.` : ""
        }`.trimEnd()
    );
  }

  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    const forget = () => {
      this.inFlight.delete(work);
    };
    work.then(forget, forget);
    // The SDK gets the original promise: a rejection abandons the message.
    return work;
  }

  /** Keeps `stream` for `close()` until `done` settles. */
  private watch(stream: FollowedObservable, done: Promise<unknown>): void {
    this.following.set(stream, done);
    const forget = () => {
      this.following.delete(stream);
    };
    done.then(forget, forget);
  }

  /**
   * Follows the Observable an event handler returned until it completes
   * (resolves) or errors (rejects). Rejects with `CancelledByClose` if
   * `close()` gives up on it first.
   */
  private followToEnd(source: Observable<unknown>): Promise<void> {
    let stream: FollowedObservable;
    const done = new Promise<void>((resolve, reject) => {
      stream = new FollowedObservable(() => reject(new CancelledByClose()));
      stream.start(source, { error: reject, complete: () => resolve() });
    });
    this.watch(stream, done);
    return done;
  }

  /**
   * Publishes the handler's response and resolves once its first reply has
   * been sent (or the response ended), so the request message is not settled
   * before the client hears back. The rest of a streamed response goes on in
   * the background; `close()` waits for it (up to `closeTimeoutInMs`, then it
   * unsubscribes it).
   *
   * Clients since 1.2.0 (the request carries `nestjs-sb-request-id`) get one
   * reply per value, each as soon as it is emitted. Values emitted together
   * (in the same tick) are sent together, and the end of the response travels
   * on the last of them when it comes in that same tick: one message for the
   * usual single-value response. An end that comes later is a reply of its
   * own, with no value (type `"none"`). This is how Nest's own transports
   * batch their replies.
   *
   * Older clients (1.1.0) take the first message on their reply queue as the
   * whole response, whatever its `correlationId`, so any further reply would
   * reach one of their later requests as its answer. They get exactly one
   * reply: the first value, the error, or the end of an empty response; the
   * response is unsubscribed after it.
   *
   * When a reply cannot be sent, the response is unsubscribed and, for a
   * client since 1.2.0, an error reply is sent in its place so that the
   * client does not wait for the rest.
   */
  private async sendReply(
    response$: Observable<unknown>,
    request: ServiceBusReceivedMessage,
    generation: number
  ): Promise<void> {
    if (generation !== this.generation) {
      throw new CancelledByClose(); // the handler returned after close() gave up on it
    }
    const { replyTo } = request;
    // Clients since 1.2.0 send their request id in a property, so that a
    // messageId of their own (e.g. for duplicate detection) does not get in
    // the way; older clients match on the messageId.
    const requestId = request.applicationProperties?.[SB_REQUEST_ID_PROPERTY];
    const singleReply = typeof requestId !== "string";
    const correlationId = singleReply ? (request.messageId as string) : requestId;
    const publish = this.getPublisher(replyTo, correlationId, request.replyToSessionId);

    let endResponse: () => void;
    const ended = new Promise<void>((resolve) => (endResponse = resolve));
    const stream = new FollowedObservable(() => endResponse());

    // Replies go out one after another. After a failure the rest are skipped
    // (the client could not make sense of them), and the chain never rejects:
    // a rejection waiting for the end of a long response would be unhandled.
    let publishing: Promise<void> = Promise.resolve();
    let failed = false;
    let firstSent: () => void;
    const first = new Promise<void>((resolve) => (firstSent = resolve));
    const respond = (packet: WritePacket) => {
      publishing = publishing.then(async () => {
        if (failed) return;
        try {
          await publish(packet);
        } catch (err) {
          failed = true;
          stream.stop();
          await this.replyFailed(err, replyTo, singleReply ? undefined : publish);
        }
      });
      publishing.then(() => {
        stream.replied = true;
        firstSent();
      });
    };

    // The replies of the current tick, sent when it ends.
    let batch: WritePacket[] | undefined;
    let replied = false;
    const schedule = (packet: WritePacket) => {
      if (singleReply) {
        if (!replied) {
          replied = true;
          respond({ ...packet, isDisposed: true });
        }
        return;
      }
      if (batch) {
        const last = batch[batch.length - 1];
        if (packet.isDisposed && !("err" in packet) && !last.err && !last.isDisposed) {
          // The end, in the same tick as the last value: on that value.
          batch[batch.length - 1] = { ...last, isDisposed: true };
        } else {
          batch.push(packet);
        }
        return;
      }
      batch = [packet];
      process.nextTick(() => {
        const replies = batch;
        batch = undefined;
        for (const reply of replies) respond(reply);
      });
    };

    const finished = (async () => {
      await ended;
      await publishing;
    })();
    this.watch(stream, finished);

    // Resolves after the tick that queues the last replies.
    const end = () => process.nextTick(endResponse);
    // A 1.1.0 client gets a single reply: stop the response after it, so that
    // nothing goes on running (or holds close()) for replies nobody gets.
    stream.start(singleReply ? response$.pipe(take(1)) : response$, {
      next: (response) => schedule({ response }),
      error: (err) => {
        schedule({ err: this.toReplyError(err, request), isDisposed: true });
        end();
      },
      complete: () => {
        schedule({ isDisposed: true });
        end();
      },
    });
    await Promise.race([first, finished]);
    if (stream.cancelledByClose && !stream.replied) {
      throw new CancelledByClose(); // no reply: the message must not be completed
    }
  }

  /**
   * Logs a reply that could not be sent and, when `publish` is given (a
   * client since 1.2.0), sends an error reply in its place: the response was
   * cut, and without an end the client would wait for the rest.
   */
  private async replyFailed(
    err: unknown,
    replyTo: string,
    publish?: (packet: WritePacket) => Promise<void>
  ): Promise<void> {
    const failure = `Could not send the reply to ${quote(replyTo)}: ${describeError(err)}.`;
    const stack = (err as Error)?.stack;
    if (!publish) {
      this.logger.error(`${failure} The client gets no reply.`, stack);
      return;
    }
    try {
      await publish({ err: { ...UNKNOWN_EXCEPTION }, isDisposed: true });
      this.logger.error(
        `${failure} The rest of the response was cancelled and the client was sent an error instead.`,
        stack
      );
    } catch (errorReplyErr) {
      this.logger.error(
        `${failure} The rest of the response was cancelled, and the error reply could not be sent ` +
          `either (${describeError(errorReplyErr)}): the client gets no further reply and fails ` +
          "after its replyTimeoutInMs, if set.",
        stack
      );
    }
  }

  /**
   * What the client gets when the handler of its request fails. Nest's
   * exception filter has already turned a handler's exception into a
   * client-safe value (`{ status: "error", message }`, or the payload of an
   * `RpcException`), which goes as is, as in Nest's other transports. An
   * `Error` that did not go through the filter (e.g. the handler could not be
   * found) is logged here and replaced, so no stack or internal message leaks.
   */
  private toReplyError(err: unknown, request: ServiceBusReceivedMessage): unknown {
    if (err instanceof Error || err === undefined || err === null) {
      this.logger.error(
        `The request ${quote(request.messageId)} on ${quote(request.replyTo)} failed: ${describeError(
          err
        )}`,
        (err as Error)?.stack
      );
      return { ...UNKNOWN_EXCEPTION };
    }
    return err;
  }

  /**
   * What `util.inspect()` (and so `console.log()`) shows: the options without
   * the connection string's key, and a summary of the connection and the
   * receivers (SDK objects hold the credentials).
   */
  [inspect.custom](depth: number, options: InspectOptionsStylized): string {
    const name = this.constructor.name;
    if (depth < 0) {
      return options.stylize(`[${name}]`, "special");
    }
    const view: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this)) {
      if (key === "options") {
        view[key] = redactOptions(value);
      } else if (key === "sbClient") {
        view[key] = value
          ? `[ServiceBusClient ${(value as ServiceBusClient).fullyQualifiedNamespace}]`
          : value;
      } else if (key === "receivers") {
        view[key] = [...(value as Map<string, ActiveReceiver>).values()].map(
          ({ receiver }) => `[ServiceBusReceiver ${receiver.entityPath}]`
        );
      } else {
        view[key] = value;
      }
    }
    return `${name} ${inspect(view, {
      ...options,
      depth: options.depth === null ? null : options.depth - 1,
    })}`;
  }

  private parsePattern(pattern: string): SubscriberPattern {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pattern);
    } catch (err) {
      throw new Error(
        `Cannot read the Azure Service Bus options of the handler pattern ${pattern}: ${err}. ` +
          "Handlers on this transport must use @Subscription() or @Queue() with plain JSON values."
      );
    }
    const metaOptions = (parsed as SubscriberPattern | null)?.metaOptions;
    if (typeof metaOptions !== "object" || metaOptions === null) {
      throw new Error(
        `The handler pattern ${pattern} has no Azure Service Bus options. ` +
          "Handlers on this transport must use @Subscription() or @Queue()."
      );
    }
    return parsed as SubscriberPattern;
  }

  private createReceiver(
    meta: SubscriberPattern["metaOptions"],
    pattern: string
  ): ServiceBusReceiver {
    const receiverOptions: ServiceBusReceiverOptions = {
      receiveMode: meta.receiveMode,
      subQueueType: meta.subQueueType,
      skipParsingBodyAsJson: meta.skipParsingBodyAsJson,
    };
    // Only when set: the SDK's default (5 minutes) applies otherwise, and 0
    // turns renewal off.
    if (meta.maxAutoLockRenewalDurationInMs !== undefined) {
      receiverOptions.maxAutoLockRenewalDurationInMs = meta.maxAutoLockRenewalDurationInMs;
    }
    const isName = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0;

    // The SDK tells the overloads apart by the type of the second argument:
    // only a string is a subscription name; anything else (null included) is
    // read as the options object.
    if (isName(meta.queueName)) {
      return this.sbClient.createReceiver(meta.queueName, receiverOptions);
    }
    if (isName(meta.topic) && isName(meta.subscription)) {
      return this.sbClient.createReceiver(meta.topic, meta.subscription, receiverOptions);
    }
    if (isName(meta.topic) && meta.subscription == null) {
      // @Subscription without a subscription name has always ended up reading
      // the `topic` entity as a queue; keep that, now with its options.
      return this.sbClient.createReceiver(meta.topic, receiverOptions);
    }
    throw new Error(
      `The handler pattern ${pattern} needs a "queueName", or a "topic" and a "subscription".`
    );
  }
}
