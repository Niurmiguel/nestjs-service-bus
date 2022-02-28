import {
  MessageHandlers,
  ServiceBusSessionReceiverOptions,
} from "@azure/service-bus";

export interface SubscriberMetadataOptions {
  name: string;
  receiveMode: "peekLock" | "receiveAndDelete";
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

export interface SubscriptionMetadataOptions extends SubscriberMetadataOptions {
  topicName: string;
  provision?: any;
  // filter etc...
}

export interface SubscriberTypeMap {
  subscription: SubscriptionMetadataOptions;
}
