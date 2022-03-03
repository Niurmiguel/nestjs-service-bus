import { MessageHandler } from "@nestjs/microservices";
import { OperatorFunction } from "rxjs";

import { SbSubscriberTypeMap } from "./subscriber.interface";
import { ServiceBusContext } from "../service-bus.context";
import { SbSubscriberMetadata } from "../metadata";

export interface RouteToCommit<
  T extends "method" = "method",
  TSub extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap
> {
  type: T;
  subscriber: SbSubscriberMetadata<TSub>;
  handler: T extends "method"
    ? MessageHandler
    : OperatorFunction<ServiceBusContext, ServiceBusContext>;
}
