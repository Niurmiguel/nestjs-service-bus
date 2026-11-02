import {
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from "@azure/service-bus";
import { BaseRpcContext } from "@nestjs/microservices/ctx-host/base-rpc.context";

/**
 * `[receiver, message]`. Both are optional so that `new
 * AzureServiceBusContext([])`, the only form before they were added, still
 * compiles.
 */
export type AzureServiceBusContextArgs = [ServiceBusReceiver?, ServiceBusReceivedMessage?];

export class AzureServiceBusContext extends BaseRpcContext<AzureServiceBusContextArgs> {
  constructor(args: AzureServiceBusContextArgs) {
    super(args);
  }

  /**
   * The receiver the message arrived on. In `peekLock` mode use it to settle
   * the message yourself (`completeMessage`, `abandonMessage`,
   * `deferMessage`, `deadLetterMessage`); set
   * `options.autoCompleteMessages: false` on the decorator when you do.
   */
  getReceiver(): ServiceBusReceiver {
    return this.args[0];
  }

  /**
   * The original message, the same object the handler gets as payload.
   */
  getMessage(): ServiceBusReceivedMessage {
    return this.args[1];
  }
}
