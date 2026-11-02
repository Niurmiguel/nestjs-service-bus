import {
  OperationOptionsBase,
  ServiceBusClientOptions,
} from "@azure/service-bus";

export interface AzureServiceBusOptions {
  connectionString: string;
  options?: ServiceBusClientOptions;
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
   * - **Default**: not set, `send()` waits indefinitely (as in 1.1.0).
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
