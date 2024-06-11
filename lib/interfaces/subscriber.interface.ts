import { SubscribeOptions } from "@azure/service-bus";

export interface SbSubscriberMetadataOptions {
  /**
   * Name of the subscription (under the `topic`) that we want to receive from.
   */
  subscription: string;
  /**
   * Represents the receive mode for the receiver.
   *
   * In receiveAndDelete mode, messages are deleted from Service Bus as they are received.
   *
   * In peekLock mode, the receiver has a lock on the message for the duration specified on the
   * queue/subscription.
   *
   * Messages that are not settled within the lock duration will be redelivered as many times as
   * the max delivery count set on the queue/subscription, after which they get sent to a separate
   * dead letter queue.
   *
   * You can settle a message by calling complete(), abandon(), defer() or deadletter() methods on
   * the message.
   *
   * More information about how peekLock and message settlement works here:
   * https://docs.microsoft.com/azure/service-bus-messaging/message-transfers-locks-settlement#peeklock
   *
   */
  receiveMode: "peekLock" | "receiveAndDelete";
  /**
   * Represents the sub queue that is applicable for any queue or subscription.
   * Valid values are "deadLetter" and "transferDeadLetter". To learn more about dead letter queues,
   * see https://docs.microsoft.com/azure/service-bus-messaging/service-bus-dead-letter-queues
   */
  subQueueType?: "deadLetter" | "transferDeadLetter";
  /**
   * The maximum duration in milliseconds until which the lock on the message will be renewed
   * by the sdk automatically. This auto renewal stops once the message is settled.
   *
   * - **Default**: `300 * 1000` milliseconds (5 minutes).
   * - **To disable autolock renewal**, set this to `0`.
   */
  maxAutoLockRenewalDurationInMs?: number;
  /**
   * Option to disable the client from running JSON.parse() on the message body when receiving the message.
   * Not applicable if the message was sent with AMQP body type value or sequence. Use this option when you
   * prefer to work directly with the bytes present in the message body than have the client attempt to parse it.
   */
  skipParsingBodyAsJson?: boolean;
  /**
   * Options used when subscribing to a Service Bus queue or subscription.
   */
  options?: SubscribeOptions;
}

export interface SbSubscriptionMetadataOptions
  extends SbSubscriberMetadataOptions {
  /**
   * Name of the topic for the subscription we want to receive from.
   */
  topic: string;
}

export interface SbSubscriberTypeMap {
  subscription: SbSubscriptionMetadataOptions;
}


export interface SbQueueMetadataOptions
  extends Omit<SbSubscriberMetadataOptions,"subscription"> {
  /**
   * Name of the topic for the subscription we want to receive from.
   */
  queueName: string;
}