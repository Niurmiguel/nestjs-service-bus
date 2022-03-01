import {
  MessageHandlers,
  ServiceBusSessionReceiverOptions,
} from '@azure/service-bus';

export interface SbSubscriberMetadataOptions {
  subscription: string;
  receiveMode: 'peekLock' | 'receiveAndDelete';
  handlerOptions?: MessageHandlers;
  sessionOptions?: ServiceBusSessionReceiverOptions;

  /**
   * The unique id of the server that this emitter should use as the underlying listener.
   * This should match the server name defined in `SgServerOptions.name`.
   *
   * By default `SgServerOptions.name` is not set, which is the identifier for the default server.
   * A multi-server environment is not required in most of the scenarios, if that is the case do not set this value.
   */
  serverId?: string;
}

export interface SbSubscriptionMetadataOptions
  extends SbSubscriberMetadataOptions {
  topic: string;
  provision?: any; // todo - types
  // filter etc...
}

export interface SbSubscriberTypeMap {
  subscription: SbSubscriptionMetadataOptions;
}
