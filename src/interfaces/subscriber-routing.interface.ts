import { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { MessageHandler } from '@nestjs/microservices';
import { OperatorFunction } from 'rxjs';

import { SbSubscriberTypeMap } from './subscriber.interface';
import { SbContext } from '../service-bus.context';
import { SbSubscriberMetadata } from '../metadata';

export interface RouteToCommit<
  T extends 'method' | 'pipe' = 'method' | 'pipe',
  TSub extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap,
> {
  type: T;
  key: string | symbol;
  subscriber: SbSubscriberMetadata<TSub>;
  instanceWrapper: InstanceWrapper<any>;
  handler: T extends 'method'
    ? MessageHandler
    : OperatorFunction<SbContext, SbContext>;
}
