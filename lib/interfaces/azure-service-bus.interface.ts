import {
  OperationOptionsBase,
  ServiceBusClientOptions,
  ServiceBusReceivedMessage,
} from "@azure/service-bus";

export interface AzureServiceBusOptions {
  connectionString: string;
  options?: ServiceBusClientOptions;
}

/**
 * Decides whether the server may send the replies of a request to `replyTo`
 * (the request's `replyTo`; the session it asks for is
 * `message.replyToSessionId`).
 */
export type AllowedReplyTo =
  | readonly string[]
  | ((replyTo: string, message: ServiceBusReceivedMessage) => boolean);

/**
 * Options of `AzureServiceBusServer`: the connection plus what only the server
 * side uses.
 */
export interface AzureServiceBusServerOptions extends AzureServiceBusOptions {
  /**
   * Where the server may send replies. A request names its reply queue
   * (`replyTo`), and anyone who can send to a request entity can name any
   * entity the server can send to. With this option, a request whose
   * `replyTo` is not allowed gets no reply and its handler does not run: the
   * message is dead-lettered (`peekLock`) with the reason
   * `"ReplyToNotAllowed"`, and a warning is logged.
   *
   * - A list of entity names (compared ignoring case, as Service Bus does),
   *   e.g. `["orders.reply"]`.
   * - Or a function `(replyTo, message) => boolean`. If it throws, the reply
   *   is not allowed.
   * - **Default**: not set, any `replyTo` is answered (as in 1.1.0). Limit
   *   the server's credentials too: see "Security" in the README.
   */
  allowedReplyTo?: AllowedReplyTo;
  /**
   * How long `close()` waits for the handlers that are running, and for the
   * rest of the streamed responses they are sending. When it runs out, the
   * Observables of those handlers are unsubscribed, the receivers and the
   * connection are closed anyway, and a warning is logged: the messages of
   * the handlers still running are not settled, so in `peekLock` mode Service
   * Bus delivers them again once their lock expires; a streamed response whose
   * request was already completed just ends without further replies.
   *
   * - **Default**: `25000` (25 seconds, under the 30 seconds Kubernetes gives
   *   a pod to stop by default). `Infinity` waits for as long as the handlers
   *   take; `0` does not wait.
   */
  closeTimeoutInMs?: number;
  /**
   * Time to live of the reply messages, so that a reply nobody receives (its
   * client gave up or is gone) does not stay in the reply queue.
   *
   * At least 1 (millisecond); a smaller value throws a `RangeError` when the
   * server is created. `Infinity` means not set. The SDK caps the time to
   * live it sends at 2^32 - 1 ms (about 49.7 days), and Service Bus at the
   * reply queue's default message time to live.
   *
   * - **Default**: not set, the reply queue's default message time to live
   *   applies (as in 1.1.0). Set it longer than the `replyTimeoutInMs` of the
   *   clients, or a client still waiting can lose its reply.
   */
  replyTimeToLiveInMs?: number;
}

/**
 * Options of `AzureServiceBusClient` (and of `AzureServiceBusModule.forRoot()`
 * entries): the connection plus what only the client side uses.
 */
export interface AzureServiceBusClientOptions extends AzureServiceBusOptions {
  /**
   * How long a `send()` waits for its reply to complete. When it runs out, the
   * Observable fails with a `ReplyTimeoutError` and the reply, if it still
   * arrives, is dropped.
   *
   * From 0 to 2147483647 (2^31 - 1, the longest a Node.js timer can wait);
   * `0` and `Infinity` mean no limit. Another value throws a `RangeError`
   * when the client is created.
   *
   * - **Default**: not set, `send()` waits indefinitely (as in 1.1.0). Setting
   *   it is recommended: without it, a request nobody answers waits forever.
   */
  replyTimeoutInMs?: number;
  /**
   * Receive the replies of `send()` in a session of their own (one per client
   * instance), so that several clients (e.g. several replicas of a service)
   * can send to the same entity and each gets only its replies.
   *
   * Requires the reply queues (`<entity>.reply`) to have sessions enabled, and
   * the servers that answer to run 1.2.0 or later (they reply to the session
   * named in the request's `replyToSessionId`).
   *
   * - **Default**: `false`. The reply queue is not session-enabled; a reply
   *   this client did not ask for is abandoned so that its client can get it.
   */
  replySessions?: boolean;
}

export interface AzureServiceBusSenderOptions {
  name: string;
  options?: OperationOptionsBase;
}
