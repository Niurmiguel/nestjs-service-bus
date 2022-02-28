import { SubscriberMetadataForTarget } from "../decorators";

export class MetadataExplorer {
  *scanForSubscriberHooks(
    instance: object
  ): IterableIterator<SubscriberMetadataForTarget[0]> {
    const proto = Reflect.getPrototypeOf(instance);
    const subscribers: SubscriberMetadataForTarget = Reflect.getMetadata(
      "SERVICE_BUS_SERVER_SUBSCRIBER_CONFIGURATION_METADATA",
      proto
    );
    if (Array.isArray(subscribers)) {
      for (const subscriber of subscribers) {
        yield subscriber;
      }
    }
  }
}
