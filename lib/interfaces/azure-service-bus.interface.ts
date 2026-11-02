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
}

export interface AzureServiceBusSenderOptions {
  name: string;
  options?: OperationOptionsBase;
}
