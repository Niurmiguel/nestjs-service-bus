import { EventPattern } from "@nestjs/microservices";
import { SB_SUBSCRIBER_METADATA } from "../azure-service-bus.constants";
import { SbSubscriberMetadata } from "../metadata";
import {
  MetaOrMetaFactory,
  SbQueueMetadataOptions,
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

export function Subscription(
  metadata: MetaOrMetaFactory<SbSubscriptionMetadataOptions>
) {
  return (
    target: object,
    key: string | symbol,
    descriptor?: PropertyDescriptor
  ) => {
    const sbSubscriberMetadata = new SbSubscriberMetadata(
      "subscription",
      metadata
    );

    storeMetadata(target, key, sbSubscriberMetadata);

    if (descriptor) {
      return EventPattern(sbSubscriberMetadata)(target, key, descriptor);
    }
  };
}

export const Queue = (metadata: SbQueueMetadataOptions) => {
  const data = { ...metadata, topic: metadata.queueName };
  delete data.queueName;
  return Subscription({
    ...data,
    subscription: null,
  });
};

export const Topic = Subscription;
