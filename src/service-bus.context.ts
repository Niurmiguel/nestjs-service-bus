import { ServiceBusMessage } from "@azure/service-bus";
import { BaseRpcContext } from "@nestjs/microservices/ctx-host/base-rpc.context";
import { SubscriberTypeMap } from "./interfaces";
import { SubscriberMetadata } from "./metadata";

export type ServiceBusContextArgs<
  T extends keyof SubscriberTypeMap = keyof SubscriberTypeMap
> = [SubscriberMetadata<T>, ServiceBusMessage];

export class ServiceBusContext<
  T extends keyof SubscriberTypeMap = keyof SubscriberTypeMap
> extends BaseRpcContext<ServiceBusContextArgs<T>> {
  constructor(args: ServiceBusContextArgs<T>) {
    super(args);
    console.log(args);
  }
}
