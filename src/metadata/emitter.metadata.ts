import {
  MetaOrMetaFactory,
  SbEmitterMetadataOptions,
  SbEmitterTypeMap,
} from "../interfaces";

export class SbEmitterMetadata<
  T extends keyof SbEmitterTypeMap = keyof SbEmitterTypeMap
> {
  metaOptions: SbEmitterTypeMap[T] extends SbEmitterMetadataOptions
    ? SbEmitterTypeMap[T]
    : SbEmitterMetadataOptions;
  private metaFactory?: (
    helper?: any
  ) => SbEmitterTypeMap[T] | Promise<SbEmitterTypeMap[T]>;

  constructor(
    public readonly type: T,
    metaOptions: SbEmitterTypeMap[T] extends SbEmitterMetadataOptions
      ? MetaOrMetaFactory<SbEmitterTypeMap[T]>
      : never
  ) {
    if (typeof metaOptions === "function") {
      this.metaFactory = metaOptions as any;
    } else {
      this.metaOptions = { ...(metaOptions as any) };
    }
  }
}
