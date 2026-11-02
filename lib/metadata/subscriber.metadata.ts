import { MetaOrMetaFactory, SbSubscriberTypeMap } from '../interfaces';

export class SbSubscriberMetadata<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap,
> {
  metaOptions: SbSubscriberTypeMap[T];
  private metaFactory?: (
    helper?: any,
  ) => SbSubscriberTypeMap[T] | Promise<SbSubscriberTypeMap[T]>;

  constructor(
    public readonly type: T,
    metaOptions: MetaOrMetaFactory<SbSubscriberTypeMap[T]>,
  ) {
    if (typeof metaOptions === 'function') {
      this.metaFactory = metaOptions as any;
    } else {
      this.metaOptions = { ...(metaOptions as any) };
    }
  }
}
