import { ServiceBusMessage } from '@azure/service-bus';
import { BaseRpcContext } from '@nestjs/microservices/ctx-host/base-rpc.context';
import { SbSubscriberTypeMap } from './interfaces';
import { SbSubscriberMetadata } from './metadata';

export type SbContextArgs<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap,
> = [SbSubscriberMetadata<T>, ServiceBusMessage];

export class SbContext<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap,
> extends BaseRpcContext<SbContextArgs<T>> {
  private message: ServiceBusMessage;
  private metadata: SbSubscriberMetadata<T>;

  constructor(args: SbContextArgs<T>) {
    super(args);
    this.metadata = args[0];
    this.message = args[1];
  }
}
