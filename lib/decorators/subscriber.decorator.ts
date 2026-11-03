import { EventPattern } from "@nestjs/microservices";

import { SB_SUBSCRIBER_METADATA } from "../azure-service-bus.constants";
import { SbSubscriberMetadata } from "../metadata";
import {
  MetaOrMetaFactory,
  SbQueueMetadataOptions,
  SbSubscriberTypeMap,
  SbSubscriptionMetadataOptions,
} from "../interfaces";

export type SubscriberMetadataForTarget = Array<{
  key: string | symbol;
  metadata: SbSubscriberMetadata;
}>;

function storeMetadata(
  target: object,
  key: string | symbol,
  metadata: SbSubscriberMetadata
): void {
  const col: SubscriberMetadataForTarget =
    Reflect.getMetadata(SB_SUBSCRIBER_METADATA, target) || [];
  if (col.push({ key, metadata }) === 1) {
    Reflect.defineMetadata(SB_SUBSCRIBER_METADATA, col, target);
  }
}

function subscriber<T extends keyof SbSubscriberTypeMap>(
  type: T,
  metadata: MetaOrMetaFactory<SbSubscriberTypeMap[T]>
) {
  return (
    target: object,
    key: string | symbol,
    descriptor?: PropertyDescriptor
  ) => {
    const sbSubscriberMetadata = new SbSubscriberMetadata(type, metadata);

    storeMetadata(target, key, sbSubscriberMetadata);

    if (descriptor) {
      return EventPattern(sbSubscriberMetadata)(target, key, descriptor);
    }
  };
}

/**
 * Receives the messages of a topic subscription.
 */
export function Subscription(
  metadata: MetaOrMetaFactory<SbSubscriptionMetadataOptions>
) {
  return subscriber("subscription", metadata);
}

/**
 * Receives the messages of a queue.
 */
export function Queue(metadata: MetaOrMetaFactory<SbQueueMetadataOptions>) {
  return subscriber("queue", metadata);
}
