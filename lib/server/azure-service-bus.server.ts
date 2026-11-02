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
import { finalize, isObservable, lastValueFrom, Observable, throwError } from "rxjs";

import {
  SB_REPLY_DISPOSED_PROPERTY,
  SB_REPLY_TYPE_PROPERTY,
  SB_REQUEST_ID_PROPERTY,
} from "../azure-service-bus.constants";
import { AzureServiceBusContext } from "../azure-service-bus.context";
import {
  AzureServiceBusOptions,
  SbQueueMetadataOptions,
  SbSubscriberTypeMap,
  SbSubscriptionMetadataOptions,
} from "../interfaces";

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

/** What Nest's own exception filter sends for an unknown error. */
const UNKNOWN_EXCEPTION = { status: "error", message: "Internal server error" };

/** A short description of what a handler failed with, for the logs. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
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
  private closing: Promise<void> | undefined;

  constructor(protected readonly options: AzureServiceBusOptions) {
    super();

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
        `Azure Service Bus ${args.errorSource} error on "${args.entityPath}": ${
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
        `Could not complete message ${receivedMessage.messageId} on "${active.receiver.entityPath}": ${
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
    const where = `message ${message.messageId} on "${active?.receiver.entityPath}"`;
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
        `There is no matching event handler defined in the remote service. Event pattern: ${pattern}`
      );
    }
    // Processing hooks exist since NestJS 11.
    const hooks = this as unknown as ProcessingHooks;
    const end = () => hooks.onProcessingEndHook?.(hooks.transportId, context);
    const run = async () => {
      const resultOrStream = await handler(packet.data, context);
      if (isObservable(resultOrStream)) {
        await lastValueFrom(resultOrStream.pipe(finalize(end)), { defaultValue: undefined });
      } else {
        end();
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
    const partialPacket = { data: receivedMessage, pattern };
    const packet = await this.deserializer.deserialize(partialPacket);
    const receiver = this.receivers.get(pattern)?.receiver;
    const sbContext = new AzureServiceBusContext([receiver, receivedMessage]);

    if (!receivedMessage.replyTo) {
      return this.handleEvent(packet.pattern, packet, sbContext);
    }

    // Whatever goes wrong, the client gets a reply: an error, not silence.
    let response$: Observable<unknown>;
    try {
      const handler = this.getHandlerByPattern(pattern);
      if (!handler) {
        throw new Error(`There is no handler for the request pattern ${pattern}`);
      }
      response$ = this.transformToObservable(await handler(receivedMessage, sbContext));
    } catch (err) {
      response$ = throwError(() => err);
    }
    await this.sendReply(response$, receivedMessage);
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
   * Stops receiving, waits for the messages being handled, then closes the
   * receivers and the client. Calls made while closing share the same work.
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

    // 1. No new messages, and no more reconnect attempts. The links stay
    //    open, so the messages being handled can still be settled.
    for (const { abortController } of active) {
      abortController.abort();
    }
    await Promise.all(active.map(({ subscription }) => settled(subscription.close())));

    // 2. Let the handlers in flight finish (a drain can still deliver one).
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight].map(settled));
    }

    // 3. Close the links, then the connection.
    const failures = (
      await Promise.all(active.map(({ receiver }) => settled(receiver.close())))
    ).filter((err) => err !== undefined);
    for (const err of failures) {
      this.logger.error(`Could not close an Azure Service Bus receiver: ${err}`);
    }
    this.receivers.clear();

    const client = this.sbClient;
    this.sbClient = undefined;
    await client?.close();
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

  /**
   * Publishes the handler's response, one reply per value, and resolves once
   * it has been sent, so the request is not settled (nor the server closed)
   * before the replies leave. The end of the response travels on the last
   * value (one message for the usual single-value response).
   */
  private async sendReply(
    response$: Observable<unknown>,
    request: ServiceBusReceivedMessage
  ): Promise<void> {
    const { replyTo } = request;
    // Clients since 1.2.0 send their request id in a property, so that a
    // messageId of their own (e.g. for duplicate detection) does not get in
    // the way; older clients match on the messageId.
    const requestId = request.applicationProperties?.[SB_REQUEST_ID_PROPERTY];
    const correlationId =
      typeof requestId === "string" ? requestId : (request.messageId as string);
    const publish = this.getPublisher(replyTo, correlationId, request.replyToSessionId);

    // Replies go out one after another. After a failure the rest are skipped
    // (the client could not make sense of them), and the chain never rejects:
    // a rejection waiting for the end of a long response would be unhandled.
    let publishing: Promise<void> = Promise.resolve();
    let failure: { err: unknown } | undefined;
    const respond = (packet: WritePacket) => {
      publishing = publishing.then(async () => {
        if (failure) return;
        try {
          await publish(packet);
        } catch (err) {
          failure = { err };
        }
      });
    };
    await new Promise<void>((resolve) => {
      let last: WritePacket | undefined;
      response$.subscribe({
        next: (response) => {
          if (last) respond(last);
          last = { response };
        },
        error: (err) => {
          if (last) respond(last);
          respond({ err: this.toReplyError(err, request), isDisposed: true });
          resolve();
        },
        complete: () => {
          respond(last ? { ...last, isDisposed: true } : { isDisposed: true });
          resolve();
        },
      });
    });
    await publishing;
    if (failure) {
      // Nothing else can be done with a reply that cannot be sent.
      const err = failure.err as Error;
      this.logger.error(
        `Could not send the reply to "${replyTo}": ${err?.message ?? err}`,
        err?.stack
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
        `The request ${request.messageId} on "${request.replyTo}" failed: ${describeError(err)}`,
        (err as Error)?.stack
      );
      return { ...UNKNOWN_EXCEPTION };
    }
    return err;
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
