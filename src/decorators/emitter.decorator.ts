import { SB_EMITTER_METADATA } from "../constants";
import { SbEmitterMetadata } from "../metadata";

export type EmitterMetadataForTarget = Array<{
  key: string | symbol;
  metadata: SbEmitterMetadata;
}>;

function storeMetadata(
  target: object,
  key: string | symbol,
  metadata: SbEmitterMetadata
): void {
  const col: EmitterMetadataForTarget =
    Reflect.getMetadata(SB_EMITTER_METADATA, target) || [];
  if (col.push({ key, metadata }) === 1) {
    Reflect.defineMetadata(SB_EMITTER_METADATA, col, target);
  }
}

export const TopicEmitter =
  (metadata: any): PropertyDecorator =>
  (target: object, key: string | symbol, descriptor?: PropertyDescriptor) =>
    storeMetadata(target, key, new SbEmitterMetadata("topic", metadata));
