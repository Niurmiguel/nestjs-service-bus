import { EventPattern } from "@nestjs/microservices";

import {
  AZURE_SERVICE_BUS_TRANSPORT,
  SB_SUBSCRIBER_EXTRA,
  SB_SUBSCRIBER_METADATA,
} from "../azure-service-bus.constants";
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
      // Declared for this transport only: in a hybrid application NestJS does
      // not register the handler on the other transports' servers.
      return EventPattern(sbSubscriberMetadata, AZURE_SERVICE_BUS_TRANSPORT, {
        [SB_SUBSCRIBER_EXTRA]: true,
      })(target, key, descriptor);
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
