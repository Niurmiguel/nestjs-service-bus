import { EventPattern } from '@nestjs/microservices';

import {
  SB_INTERCEPTORS_METADATA,
  SB_SERVER_SUBSCRIBER_METADATA,
} from '../constants';
import { SbSubscriberMetadata } from '../metadata';
import {
  MetaOrMetaFactory,
  SbInterceptor,
  SbSubscriptionMetadataOptions,
} from '../interfaces';
import { Type } from '@nestjs/common';
import { OperatorFunction } from 'rxjs';
import { SbContext } from '../service-bus.context';

export type SubscriberMetadataForTarget = Array<{
  key: string | symbol;
  metadata: SbSubscriberMetadata;
}>;

export type SbInterceptorMetadataForTarget = Map<
  string | symbol,
  Array<SbInterceptor | Type<SbInterceptor>>
>;

function storeMetadata(
  target: object,
  key: string | symbol,
  metadata: SbSubscriberMetadata,
): void {
  const col: SubscriberMetadataForTarget =
    Reflect.getMetadata(SB_SERVER_SUBSCRIBER_METADATA, target) || [];
  if (col.push({ key, metadata }) === 1) {
    Reflect.defineMetadata(SB_SERVER_SUBSCRIBER_METADATA, col, target);
  }
}

export function Subscription(
  metadata: MetaOrMetaFactory<SbSubscriptionMetadataOptions>,
) {
  return (
    target: object,
    key: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    const sbSubscriberMetadata = new SbSubscriberMetadata(
      'subscription',
      metadata,
    );

    storeMetadata(target, key, sbSubscriberMetadata);

    if (descriptor) {
      return EventPattern(sbSubscriberMetadata)(target, key, descriptor);
    }
  };
}

export function SbIntercept(
  ...interceptors: Array<SbInterceptor | Type<SbInterceptor>>
) {
  return <
    T extends Record<K, OperatorFunction<SbContext, any>>,
    K extends string,
  >(
    target: T,
    key: K,
  ): void => {
    const ctrlInterceptors: SbInterceptorMetadataForTarget =
      Reflect.getMetadata(SB_INTERCEPTORS_METADATA, target) ||
      new Map<string | symbol, Array<SbInterceptor | Type<SbInterceptor>>>();

    if (ctrlInterceptors.size === 0) {
      Reflect.defineMetadata(
        SB_INTERCEPTORS_METADATA,
        ctrlInterceptors,
        target,
      );
    }

    if (!ctrlInterceptors.has(key)) {
      ctrlInterceptors.set(key, []);
    }
    ctrlInterceptors.get(key).push(...interceptors);
  };
}
