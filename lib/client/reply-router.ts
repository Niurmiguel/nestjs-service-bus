import {
  isServiceBusError,
  MessageHandlers,
  ProcessErrorArgs,
  ServiceBusClient,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from "@azure/service-bus";
import { LoggerService } from "@nestjs/common";
import { inspect } from "util";

import { quote, RateLimitedWarning } from "../utils";

/** A request waiting for its reply. */
export interface ReplyWaiter {
  /** A reply whose `correlationId` is this request's id. */
  reply(message: ServiceBusReceivedMessage): void;
  /** Replies can no longer be received (e.g. the reply queue does not exist). */
  fail(err: unknown): void;
}

/**
 * Receive errors that retrying does not fix, besides those the SDK marks as
 * not retryable. The requests waiting on that receiver fail instead of
 * waiting forever (the SDK would retry them forever).
 */
const FATAL_RECEIVE_ERRORS = new Set([
  "MessagingEntityNotFound",
  "SessionCannotBeLocked",
  "SessionLockLost",
]);

/**
 * The shape of a request id: a UUID (clients since 1.2.0, and NestJS 11.2.8+)
 * or the 21 hexadecimal characters of NestJS 10's ids (clients 1.1.0). A reply
 * whose `correlationId` has neither shape belongs to no client.
 */
const REQUEST_ID_SHAPE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{21})$/i;

/** How often the warning about replies that are not this client's is logged. */
const FOREIGN_REPLY_WARNING_INTERVAL_MS = 60_000;

/**
 * How long the SDK keeps renewing the lock of a reply session. The receiver is
 * closed as soon as no request waits on it, so this only has to outlast the
 * longest wait. (Not `Infinity`: the SDK turns it into an invalid date and
 * then never renews.)
 */
const SESSION_LOCK_RENEWAL_MS = 2 ** 31 - 1;

/** How many finished request ids are remembered to recognise late replies. */
const FINISHED_IDS_LIMIT = 1000;

/** One receiver on a reply queue, shared by the requests waiting on it. */
interface ReplyListener {
  readonly replyTo: string;
  readonly waiters: Map<string, ReplyWaiter>;
  /** Aborted when the listener closes: stops the SDK's retries. */
  readonly abortController: AbortController;
  receiver?: ServiceBusReceiver;
  subscription?: { close(): Promise<void> };
  /** Settles once the receiver is subscribed or could not be. Never rejects. */
  opened?: Promise<void>;
}

/** Remembers the last `limit` ids added. */
class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly limit: number) {}

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > this.limit) {
      this.ids.delete(this.ids.values().next().value);
    }
  }

  has(id: string | undefined): boolean {
    return id !== undefined && this.ids.has(id);
  }
}

/**
 * Receives the replies of a client's `send()` calls and hands each one to the
 * request whose id is its `correlationId`.
 *
 * There is one receiver per reply queue, shared by all the requests of the
 * client that wait on it, opened with the first one and closed when the last
 * one stops waiting.
 *
 * - Without a session id, the reply queue may be shared with other clients
 *   (other processes). A reply for a request this client did not send is
 *   abandoned, so it goes back to the queue for its client; it is never handed
 *   to another request. Replies to this client's own finished requests (late,
 *   or after a timeout) are completed and dropped.
 * - With a session id, the reply queue has sessions enabled and this client
 *   only receives its own session: every reply it gets is its own.
 */
export class ReplyRouter {
  private readonly listeners = new Map<string, ReplyListener>();
  /** Receivers being closed, by queue: a new one on the same session waits. */
  private readonly closing = new Map<string, Promise<void>>();
  private readonly finished = new RecentIds(FINISHED_IDS_LIMIT);
  private readonly foreignReplyWarning = new RateLimitedWarning(
    FOREIGN_REPLY_WARNING_INTERVAL_MS
  );

  constructor(
    private readonly getClient: () => ServiceBusClient,
    /** Read on each use: the client's logger can be replaced. */
    private readonly logger: () => LoggerService,
    /** Remembers work that `close()` of the client must wait for. */
    private readonly track: <T>(work: Promise<T>) => Promise<T>,
    /** The session replies are sent to, when the reply queues use sessions. */
    readonly sessionId?: string
  ) {}

  /**
   * Starts waiting for the replies to request `id` on `replyTo`. Returns the
   * function that stops waiting (idempotent).
   */
  wait(replyTo: string, id: string, waiter: ReplyWaiter): () => void {
    let listener = this.listeners.get(replyTo);
    if (!listener) {
      listener = this.open(replyTo);
    }
    listener.waiters.set(id, waiter);
    return () => this.stopWaiting(listener, id);
  }

  /** A summary for `util.inspect()`: no SDK objects (they hold the credentials). */
  [inspect.custom](): string {
    const waiting = [...this.listeners.values()].map(
      ({ replyTo, waiters }) => `${quote(replyTo)}: ${waiters.size}`
    );
    return `ReplyRouter { waiting: { ${waiting.join(", ")} }${
      this.sessionId ? `, sessionId: ${quote(this.sessionId)}` : ""
    } }`;
  }

  /** Fails every request still waiting with `reason` and closes the receivers. */
  async close(reason: Error): Promise<void> {
    for (const listener of [...this.listeners.values()]) {
      this.failAll(listener, reason);
    }
    await Promise.allSettled([...this.closing.values()]);
  }

  private stopWaiting(listener: ReplyListener, id: string): void {
    if (!listener.waiters.delete(id)) {
      return;
    }
    this.finished.add(id);
    if (listener.waiters.size === 0) {
      this.closeListener(listener);
    }
  }

  private open(replyTo: string): ReplyListener {
    const listener: ReplyListener = {
      replyTo,
      waiters: new Map(),
      abortController: new AbortController(),
    };
    this.listeners.set(replyTo, listener);
    // A session can only be locked once the previous receiver released it.
    const previous = this.sessionId ? this.closing.get(replyTo) : undefined;
    const { signal } = listener.abortController;

    listener.opened = (async () => {
      await previous;
      if (signal.aborted) {
        return;
      }
      const client = this.getClient();
      const receiver = this.sessionId
        ? await client.acceptSession(replyTo, this.sessionId, {
            receiveMode: "peekLock",
            maxAutoLockRenewalDurationInMs: SESSION_LOCK_RENEWAL_MS,
            abortSignal: signal,
          })
        : client.createReceiver(replyTo, { receiveMode: "peekLock" });
      listener.receiver = receiver;
      if (signal.aborted) {
        return; // closeListener() closes it.
      }
      listener.subscription = receiver.subscribe(this.createHandlers(listener, receiver), {
        // Settled here, before the request is told: telling it can end it and
        // close this receiver, which would strand the SDK's own completion.
        autoCompleteMessages: false,
        abortSignal: signal,
      });
    })().catch((err) => {
      if (signal.aborted) {
        return; // Closed while opening.
      }
      this.logger().error(
        `Could not receive the replies on ${quote(replyTo)}${
          this.sessionId ? " (with replySessions the reply queue must have sessions enabled)" : ""
        }: ${err?.message ?? err}`,
        err?.stack
      );
      this.failAll(listener, err);
    });
    return listener;
  }

  private createHandlers(
    listener: ReplyListener,
    receiver: ServiceBusReceiver
  ): MessageHandlers {
    const { replyTo } = listener;
    return {
      processMessage: async (message: ServiceBusReceivedMessage) => {
        const id = typeof message.correlationId === "string" ? message.correlationId : undefined;
        const isOwn =
          this.sessionId !== undefined ||
          (id !== undefined && listener.waiters.has(id)) ||
          this.finished.has(id);
        if (!isOwn) {
          if (id === undefined || !REQUEST_ID_SHAPE.test(id)) {
            // No client sent that id: bouncing it would only delay the
            // dead-letter queue by the max delivery count.
            await receiver.deadLetterMessage(message, {
              deadLetterReason: "InvalidCorrelationId",
              deadLetterErrorDescription:
                "The correlationId of this reply is not the id of a request.",
            });
            this.foreignReplyWarning.emit(
              (text) => this.logger().warn(text),
              `Dead-lettered a reply on ${quote(replyTo)} whose correlationId ` +
                `${quote(message.correlationId)} is not a request id`
            );
            return;
          }
          // Another client's reply: give it back to the queue for that client.
          await receiver.abandonMessage(message);
          this.foreignReplyWarning.emit(
            (text) => this.logger().warn(text),
            `Abandoned a reply on ${quote(replyTo)} to a request this client did not send ` +
              `(correlationId ${quote(message.correlationId)}). If several clients ` +
              "send to the same entity, enable replySessions so each gets only its replies."
          );
          return;
        }
        // A rejection here (e.g. the lock was lost) makes the SDK abandon it,
        // and the reply is delivered again.
        await receiver.completeMessage(message);
        // The request may have stopped waiting (timeout, unsubscribe) meanwhile.
        const waiter = id === undefined ? undefined : listener.waiters.get(id);
        if (waiter) {
          waiter.reply(message);
        } else {
          this.logger().debug?.(
            `Dropped a reply on ${quote(replyTo)} to a request that no longer waits ` +
              `(correlationId ${quote(message.correlationId)})`
          );
        }
      },
      processError: async ({ error, errorSource, entityPath }: ProcessErrorArgs) => {
        // It must resolve: the SDK awaits it. Errors while closing (abort,
        // session released) are expected.
        if (listener.abortController.signal.aborted) {
          return;
        }
        const err = error as Error | undefined;
        // Only the receive link itself: an error of this router's own
        // callback (e.g. a lost message lock while completing a reply) is
        // retried by the SDK, and does not concern the other requests.
        const fatal =
          errorSource === "receive" &&
          isServiceBusError(err) &&
          (FATAL_RECEIVE_ERRORS.has(err.code) || err.retryable === false);
        this.logger().error(
          `Azure Service Bus ${errorSource} error on the reply queue ${quote(entityPath)}: ${
            err?.message ?? err
          }${
            fatal
              ? `. The requests waiting for a reply there fail${
                  this.sessionId
                    ? " (with replySessions the reply queue must have sessions enabled)"
                    : " (without replySessions the reply queue must not have sessions enabled)"
                }.`
              : ""
          }`,
          err?.stack
        );
        if (fatal) {
          this.failAll(listener, err);
        }
      },
    };
  }

  /** Fails the requests waiting on `listener` and closes it. */
  private failAll(listener: ReplyListener, err: unknown): void {
    const waiters = [...listener.waiters];
    listener.waiters.clear();
    for (const [id, waiter] of waiters) {
      this.finished.add(id);
      waiter.fail(err);
    }
    this.closeListener(listener);
  }

  private closeListener(listener: ReplyListener): void {
    const { replyTo, abortController } = listener;
    if (this.listeners.get(replyTo) === listener) {
      this.listeners.delete(replyTo);
    }
    if (abortController.signal.aborted) {
      return; // Already closing.
    }
    abortController.abort();
    const closing: Promise<void> = (async () => {
      await listener.opened;
      await listener.subscription?.close();
      await listener.receiver?.close();
    })()
      .catch((err) =>
        this.logger().error(
          `Could not close the reply receiver on ${quote(replyTo)}: ${err?.message ?? err}`,
          err?.stack
        )
      )
      .finally(() => {
        if (this.closing.get(replyTo) === closing) {
          this.closing.delete(replyTo);
        }
      });
    this.closing.set(replyTo, closing);
    this.track(closing);
  }
}
