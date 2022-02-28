import {
  MetaOrMetaFactory,
  SubscriberMetadataOptions,
  SubscriberTypeMap,
} from "../interfaces";

export class SubscriberMetadata<
  T extends keyof SubscriberTypeMap = keyof SubscriberTypeMap
> {
  metaOptions: SubscriberTypeMap[T] extends SubscriberMetadataOptions
    ? SubscriberTypeMap[T]
    : SubscriberMetadataOptions;

  private metaFactory?: (
    helper?: any
  ) => SubscriberTypeMap[T] | Promise<SubscriberTypeMap[T]>;

  constructor(
    type: T,
    metaOptions: SubscriberTypeMap[T] extends SubscriberMetadataOptions
      ? MetaOrMetaFactory<SubscriberTypeMap[T]>
      : never
  ) {
    if (typeof metaOptions === "function") {
      this.metaFactory = metaOptions as any;
    } else {
      this.metaOptions = { ...(metaOptions as any) };
    }
  }
}
