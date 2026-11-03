import {
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusSender,
} from "@azure/service-bus";

import { PacketId, ReadPacket, WritePacket } from "@nestjs/microservices";
import { Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { inspect, InspectOptionsStylized } from "util";

import { AzureServiceBusClientProxy } from "./azure-service-bus-client-proxy";
import { ReplyRouter } from "./reply-router";
import {
  SB_REPLY_DISPOSED_PROPERTY,
  SB_REPLY_TYPE_PROPERTY,
  SB_REQUEST_ID_PROPERTY,
} from "../azure-service-bus.constants";
import { ReplyTimeoutError } from "../errors";
import {
  AzureServiceBusClientOptions,
  AzureServiceBusSenderOptions,
} from "../interfaces";
import { describeError, quote, readTimerOption, redactOptions, waitUpTo } from "../utils";

/** What `sendMessages()` accepts. */
type SendableMessages = Parameters<ServiceBusSender["sendMessages"]>[0];

/** `closeTimeoutInMs` when it is not set. */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * How long `close()` waits, once it has cancelled the sends still in flight,
 * for the SDK to give them up before it closes the connection anyway.
 */
const SEND_CANCEL_WAIT_MS = 1_000;

/** What happens to the links `close()` goes on without (see the warnings). */
const STUCK_LINKS_NOTE =
  "the connection is closed once the SDK gives them up (up to a minute), and the process " +
  "stays alive until then";

/** A send in progress, and what cancels it. */
interface Sending {
  readonly cancel: AbortController;
  /** Set when `close()` is the one that cancels it. */
  byClose: boolean;
}

/** The error of a reply that says it is one but carries no body. */
const UNKNOWN_REPLY_ERROR = { status: "error", message: "Internal server error" };

/**
 * Reads the entity name and the send options from the pattern object the
 * caller passed. Not from its string form (`normalizePattern()`): that loses
 * values such as an `AbortSignal` and is not valid JSON when an option is
 * `undefined`.
 */
function readSenderOptions(pattern: unknown): AzureServiceBusSenderOptions {
  const candidate = pattern as Partial<AzureServiceBusSenderOptions> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0
  ) {
    throw new TypeError(
      'The pattern must be an object like { name: "<queue or topic>", options?: {...} }.'
    );
  }
  return { name: candidate.name, options: candidate.options };
}

/** What the SDK reads as an `AmqpAnnotatedMessage` (its own check). */
function isAnnotated(message: object): boolean {
  return "body" in message && "bodyType" in message;
}

/** Turns a reply message into the packet Nest's observer understands. */
function readReply(message: ServiceBusReceivedMessage): WritePacket & { id: string } {
  const id = message.correlationId as string;
  const properties = message.applicationProperties ?? {};
  switch (properties[SB_REPLY_TYPE_PROPERTY]) {
    case "error":
      return { id, err: message.body ?? UNKNOWN_REPLY_ERROR, isDisposed: true };
    case "none":
      return { id, isDisposed: true };
    case "response":
      return {
        id,
        response: message.body,
        isDisposed: properties[SB_REPLY_DISPOSED_PROPERTY] === true,
      };
    default:
      // Servers before 1.2.0: one reply, the whole response.
      return { id, response: message.body, isDisposed: true };
  }
}

@Injectable()
export class AzureServiceBusClient extends AzureServiceBusClientProxy {
  private sbClient: ServiceBusClient;
  /**
   * Sends in progress. `close()` waits for them for up to `closeTimeoutInMs`,
   * then cancels them: closing the connection under a send would leave the
   * SDK's timers of that send (up to 60 s) keeping the process alive.
   */
  private readonly sending = new Map<Promise<unknown>, Sending>();
  /** Reply receivers being closed, which `close()` waits for. */
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly replies: ReplyRouter;
  /** `options.replyTimeoutInMs`, checked; `undefined` when there is no limit. */
  private readonly replyTimeoutInMs: number | undefined;
  /** `options.closeTimeoutInMs`, checked; `Infinity` waits for ever. */
  private readonly closeTimeoutInMs: number;

  constructor(protected readonly options: AzureServiceBusClientOptions) {
    super();

    const replyTimeoutInMs = readTimerOption("replyTimeoutInMs", options?.replyTimeoutInMs);
    this.replyTimeoutInMs =
      replyTimeoutInMs > 0 && replyTimeoutInMs !== Infinity ? replyTimeoutInMs : undefined;
    this.closeTimeoutInMs =
      readTimerOption("closeTimeoutInMs", options?.closeTimeoutInMs) ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.initializeSerializer(options);
    this.initializeDeserializer(options);
    this.replies = new ReplyRouter(
      () => this.sbClient,
      () => this.logger,
      (work) => this.track(work),
      // One session per client instance: no other client can receive it.
      options?.replySessions ? randomUUID() : undefined
    );
  }

  connect(): Promise<any> {
    if (!this.sbClient) {
      this.sbClient = this.createServiceBusClient();
    }

    return Promise.resolve();
  }

  protected async dispatchEvent<T = any>(
    packet: ReadPacket<any>
  ): Promise<any> {
    const { name, options } = readSenderOptions(packet.pattern);
    const messages = this.serializer.serialize(packet.data);
    await this.sendTo(name, messages, options);
  }

  /**
   * Sends a request and waits for its replies on `<name>.reply`, matching them
   * by `correlationId` (see `ReplyRouter`).
   */
  protected publish(
    partialPacket: ReadPacket<any>,
    callback: (packet: WritePacket<any>) => void
  ): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWaiting: () => void = () => undefined;
    const teardown = () => {
      clearTimeout(timer);
      stopWaiting();
    };
    try {
      const packet = this.assignPacketId(partialPacket);
      const { name, options } = readSenderOptions(packet.pattern);
      const replyTo = this.getReplyTo(name);
      const messages = this.toRequests(this.serializer.serialize(packet.data), packet.id, replyTo);

      // Replies are handed over one after another even if the deserializer is
      // asynchronous, so a value never overtakes the end of the response.
      let delivering = Promise.resolve();
      stopWaiting = this.replies.wait(replyTo, packet.id, {
        reply: (message) => {
          delivering = delivering
            .then(() => this.deliverReply(message, callback))
            .catch((err) => callback({ err }));
        },
        fail: (err) => callback({ err }),
      });

      // A failed send (e.g. the entity does not exist) errors the Observable.
      this.sendTo(name, messages, options).catch((err) => callback({ err }));

      const { replyTimeoutInMs } = this;
      if (replyTimeoutInMs !== undefined) {
        timer = setTimeout(
          () => callback({ err: new ReplyTimeoutError(replyTo, replyTimeoutInMs) }),
          replyTimeoutInMs
        );
      }
    } catch (err) {
      teardown();
      callback({ err });
    }
    return teardown;
  }

  /**
   * The request id, which the replies carry as `correlationId`. A random UUID
   * whatever the NestJS version: NestJS 10 (and 11 before 11.2.8) derives it
   * from `Math.random()`, and each id there gives away most of the next one,
   * so a reply could be forged for a request that has not been sent yet.
   */
  protected assignPacketId(packet: ReadPacket): ReadPacket & PacketId {
    return Object.assign(packet, { id: randomUUID() });
  }

  public getReplyTo = (pattern: string): string => {
    return `${pattern}.reply`;
  };

  createServiceBusClient(): ServiceBusClient {
    const { connectionString, options } = this.options;
    return new ServiceBusClient(connectionString, options);
  }

  /**
   * Returns the underlying `ServiceBusClient` (NestJS 11+ API).
   */
  unwrap<T = ServiceBusClient>(): T {
    if (!this.sbClient) {
      throw new Error('Not initialized. Please call the "connect" method first.');
    }
    return this.sbClient as T;
  }

  /**
   * Waits for the sends in flight (for up to `closeTimeoutInMs`, then cancels
   * them), fails the `send()` calls still waiting for a reply, closes the
   * reply receivers and then the connection. A later `send()`/`emit()`
   * connects again. A failure to close is logged, not thrown (Nest would skip
   * the rest of its shutdown).
   */
  async close(): Promise<void> {
    const deadline = Date.now() + this.closeTimeoutInMs;
    await this.settleSends(deadline);
    await this.settleReceivers(
      deadline,
      this.replies.close(new Error("The client was closed before the reply arrived"))
    );
    // A send() or emit() made while this close() was waiting.
    await this.settleSends(deadline);
    const client = this.sbClient;
    this.sbClient = undefined;
    // Links the SDK is still attaching (see the warnings above): closing the
    // connection under them would leave the SDK's timer of each attach (up to
    // a minute) running. The connection is closed once they are done.
    const stuck = [...this.sending.keys(), ...this.inFlight];
    if (client && stuck.length > 0) {
      void Promise.allSettled(stuck).then(() => this.closeConnection(client));
      return;
    }
    await this.closeConnection(client);
  }

  /** Closes `client`; a failure is logged, never thrown. */
  private async closeConnection(client: ServiceBusClient | undefined): Promise<void> {
    try {
      await client?.close();
    } catch (err) {
      this.logger.error(
        `Could not close the Azure Service Bus connection: ${describeError(err)}`,
        err instanceof Error ? err.stack : undefined
      );
    }
  }

  /**
   * What `util.inspect()` (and so `console.log()`) shows: the options without
   * the connection string's key, and a summary of the connection.
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
      } else {
        view[key] = value;
      }
    }
    return `${name} ${inspect(view, {
      ...options,
      depth: options.depth === null ? null : options.depth - 1,
    })}`;
  }

  /**
   * The request messages: the payload with the reply queue, the request id
   * (and, with `replySessions`, the reply session) added.
   */
  private toRequests(serialized: unknown, id: string, replyTo: string): SendableMessages {
    if (typeof (serialized as { tryAddMessage?: unknown })?.tryAddMessage === "function") {
      throw new TypeError(
        "send() cannot add the reply queue to a ServiceBusMessageBatch: pass the messages instead."
      );
    }
    const sessionId = this.replies.sessionId;
    const list = (Array.isArray(serialized) ? serialized : [serialized]) as Array<
      Record<string, any>
    >;
    return list.map((message) => {
      const applicationProperties = {
        ...message.applicationProperties,
        [SB_REQUEST_ID_PROPERTY]: id,
      };
      if (isAnnotated(message)) {
        return {
          ...message,
          applicationProperties,
          properties: {
            messageId: id,
            ...message.properties,
            replyTo,
            ...(sessionId && { replyToGroupId: sessionId }),
          },
        };
      }
      return {
        messageId: id,
        ...message,
        applicationProperties,
        replyTo,
        ...(sessionId && { replyToSessionId: sessionId }),
      } as ServiceBusMessage;
    }) as SendableMessages;
  }

  private async deliverReply(
    message: ServiceBusReceivedMessage,
    callback: (packet: WritePacket<any>) => void
  ): Promise<void> {
    const packet: WritePacket = await this.deserializer.deserialize(readReply(message));
    if (packet.err) {
      callback({ err: packet.err });
    } else if (packet.isDisposed && "response" in packet && packet.response === undefined) {
      // Nest's observer reads `{ response: undefined, isDisposed: true }` as
      // "no value": emit the undefined value, then complete.
      callback({ response: undefined });
      callback({ isDisposed: true });
    } else {
      callback(packet);
    }
  }

  /**
   * Sends through a short-lived sender. The promise settles with the send;
   * `close()` waits for the send and for its sender to close (and may cancel
   * the send, see `settleSends()`). A failure to close the sender is logged
   * rather than left as an unhandled rejection.
   *
   * The SDK gets an `abortSignal` of this send's own, which the caller's
   * `abortSignal` (if any) and `close()` both abort.
   */
  private sendTo(
    name: string,
    messages: SendableMessages,
    options: AzureServiceBusSenderOptions["options"]
  ): Promise<void> {
    const sender = this.sbClient.createSender(name);
    const state: Sending = { cancel: new AbortController(), byClose: false };
    const callerSignal = options?.abortSignal;
    const forward = () => state.cancel.abort();
    if (callerSignal?.aborted) {
      forward();
    } else {
      callerSignal?.addEventListener("abort", forward);
    }
    // Settles as soon as the SDK gives the send up, even if the sender then
    // takes longer to close (it waits for a link still being attached).
    const sent = (async () => {
      try {
        await sender.sendMessages(messages, { ...options, abortSignal: state.cancel.signal });
      } catch (err) {
        throw state.byClose ? this.cancelledByClose(name, err) : err;
      } finally {
        callerSignal?.removeEventListener("abort", forward);
      }
    })();
    const sending = sent
      .catch(() => undefined) // the caller handles it
      .then(() => sender.close())
      .catch((err) =>
        this.logger.error(
          `Could not close the sender for ${quote(name)}: ${err?.message ?? err}`,
          err?.stack
        )
      );
    this.sending.set(sending, state);
    sending.then(() => {
      this.sending.delete(sending);
    });
    return sent;
  }

  /** The error a send cancelled by `close()` fails with (its cause: the SDK's). */
  private cancelledByClose(name: string, cause: unknown): Error {
    const err = new Error(
      `close() cancelled the send to ${quote(name)}: it was still in flight after ` +
        `closeTimeoutInMs (${this.closeTimeoutInMs} ms). The message may or may not have ` +
        "reached Service Bus."
    );
    Object.defineProperty(err, "cause", { value: cause, configurable: true, writable: true });
    return err;
  }

  /**
   * Waits for the sends in flight until `deadline`; then cancels the ones
   * left (with the `abortSignal` of `sendMessages()`) and gives the SDK up to
   * `SEND_CANCEL_WAIT_MS` to give them up. Sends it already cancelled are not
   * waited for again. Returns at once when nothing is being sent.
   */
  private async settleSends(deadline: number): Promise<void> {
    const live = () => [...this.sending].filter(([, state]) => !state.byClose);
    while (live().length > 0 && Date.now() < deadline) {
      await waitUpTo(
        deadline - Date.now(),
        Promise.allSettled(live().map(([sending]) => sending))
      );
    }
    const left = live();
    if (left.length === 0) {
      return;
    }
    for (const [, state] of left) {
      state.byClose = true;
      state.cancel.abort();
    }
    await waitUpTo(SEND_CANCEL_WAIT_MS, Promise.allSettled(left.map(([sending]) => sending)));
    const stuck = left.filter(([sending]) => this.sending.has(sending)).length;
    this.logger.warn(
      `close() cancelled ${left.length} send(s) still in flight after closeTimeoutInMs ` +
        `(${this.closeTimeoutInMs} ms)${
          stuck > 0
            ? `; ${stuck} did not stop (e.g. a link still being attached, which the SDK cannot ` +
              `cancel): ${STUCK_LINKS_NOTE}`
            : ""
        }.`
    );
  }

  /**
   * Waits for the reply receivers being closed until `deadline`, and at least
   * `SEND_CANCEL_WAIT_MS`. One whose link is still being attached cannot be
   * closed before the SDK gives the attach up (up to a minute): `close()`
   * then goes on without it, warns, and leaves the connection to be closed
   * after it.
   */
  private async settleReceivers(deadline: number, closing: Promise<void>): Promise<void> {
    const all = Promise.all([closing, this.settleInFlight()]);
    if (this.inFlight.size === 0) {
      await all; // nothing being closed: no timer
      return;
    }
    await waitUpTo(Math.max(deadline - Date.now(), SEND_CANCEL_WAIT_MS), all);
    if (this.inFlight.size > 0) {
      this.logger.warn(
        `close() did not wait for ${this.inFlight.size} reply receiver(s) still being closed ` +
          `after closeTimeoutInMs (${this.closeTimeoutInMs} ms) (e.g. a link still being ` +
          `attached, which the SDK cannot cancel): ${STUCK_LINKS_NOTE}.`
      );
    }
  }

  /** Remembers `work` until it settles, so that `close()` can wait for it. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const forget = () => {
      this.inFlight.delete(work);
    };
    work.then(forget, forget);
    return work;
  }

  private async settleInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}
