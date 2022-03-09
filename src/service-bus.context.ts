import { ServiceBusMessage } from "@azure/service-bus";
import { BaseRpcContext } from "@nestjs/microservices/ctx-host/base-rpc.context";
import { SbSubscriberTypeMap } from "./interfaces";
import { SbSubscriberMetadata } from "./metadata";

export type SbContextArgs<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap
> = [SbSubscriberMetadata<T>, ServiceBusMessage];

export class ServiceBusContext<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap
> extends BaseRpcContext<SbContextArgs<T>> {
  constructor(args: SbContextArgs<T>) {
    super(args);
  }

  /**
   * Returns the original message (with properties, fields, and content).
   */
  getMessage(): ServiceBusMessage {
    return this.args[1];
  }

  /**
   * Returns the body of message.
   */
  getBody<TBody = any>(): TBody {
    return this.args[1].body;
  }

  getMetadata(): SbSubscriberMetadata<T> {
    return this.args[0];
  }
}
