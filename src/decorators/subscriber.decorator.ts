import { EventPattern } from "@nestjs/microservices";

import { SubscriberMetadata } from "../metadata";

export type SubscriberMetadataForTarget = Array<{
  key: string | symbol;
  metadata: any;
}>;

function storeMetadata(
  target: object,
  key: string | symbol,
  metadata: any
): void {
  const col: SubscriberMetadataForTarget =
    Reflect.getMetadata(
      "SERVICE_BUS_SERVER_SUBSCRIBER_CONFIGURATION_METADATA",
      target
    ) || [];
  if (col.push({ key, metadata }) === 1) {
    Reflect.defineMetadata(
      "SERVICE_BUS_SERVER_SUBSCRIBER_CONFIGURATION_METADATA",
      col,
      target
    );
  }
}

/**
 * Subscribes to incoming events from a topic
 */
export function Subscription<T = false>(metadata: any): any {
  return ((
    target: object,
    key: string | symbol,
    descriptor?: PropertyDescriptor
  ) => {
    const sbSubscriberMetadata = new SubscriberMetadata(
      "subscription",
      metadata
    );
    storeMetadata(target, key, sbSubscriberMetadata);
    if (descriptor) {
      return EventPattern(sbSubscriberMetadata)(target, key, descriptor);
    }
  }) as any;
}
