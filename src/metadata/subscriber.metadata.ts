import {
  MetaOrMetaFactory,
  SbSubscriberMetadataOptions,
  SbSubscriberTypeMap,
} from '../interfaces';

export class SbSubscriberMetadata<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap,
> {
  metaOptions: SbSubscriberTypeMap[T] extends SbSubscriberMetadataOptions
    ? SbSubscriberTypeMap[T]
    : SbSubscriberMetadataOptions;
  private metaFactory?: (
    helper?: any,
  ) => SbSubscriberTypeMap[T] | Promise<SbSubscriberTypeMap[T]>;

  constructor(
    public readonly type: T,
    metaOptions: SbSubscriberTypeMap[T] extends SbSubscriberMetadataOptions
      ? MetaOrMetaFactory<SbSubscriberTypeMap[T]>
      : never,
  ) {
    if (typeof metaOptions === 'function') {
      this.metaFactory = metaOptions as any;
    } else {
      this.metaOptions = { ...(metaOptions as any) };
    }
  }
}
