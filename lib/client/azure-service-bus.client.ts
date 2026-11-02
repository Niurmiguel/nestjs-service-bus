import {
  MessageHandlers,
  ProcessErrorArgs,
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusSender,
} from "@azure/service-bus";

import { PacketId, ReadPacket, WritePacket } from "@nestjs/microservices";
import { Injectable } from "@nestjs/common";

import { AzureServiceBusClientProxy } from ".";
import {
  AzureServiceBusOptions,
  AzureServiceBusSenderOptions,
} from "../interfaces";

/**
 * Reads the entity name and the send options from the pattern object the
 * caller passed. Not from its string form (`normalizePattern()`): that loses
 * values such as an `AbortSignal` and is not valid JSON when an option is
 * `undefined`.
 */
function readSenderOptions(pattern: unknown): AzureServiceBusSenderOptions {
  const candidate = pattern as Partial<AzureServiceBusSenderOptions> | null;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0
  ) {
    throw new TypeError(
      'The pattern must be an object like { name: "<queue or topic>", options?: {...} }.'
    );
  }
  return { name: candidate.name, options: candidate.options };
}

@Injectable()
export class AzureServiceBusClient extends AzureServiceBusClientProxy {
  private sbClient: ServiceBusClient;
  /** Sends and receiver closes in progress, which `close()` waits for. */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(protected readonly options: AzureServiceBusOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  connect(): Promise<any> {
    if (!this.sbClient) {
      this.sbClient = this.createServiceBusClient();
    }

    return Promise.resolve();
  }

  protected async dispatchEvent<T = any>(
    packet: ReadPacket<any>
  ): Promise<any> {
    const { name, options } = readSenderOptions(packet.pattern);
    const messages = this.serializer.serialize(packet.data);
    await this.sendTo(name, messages, options);
  }

  protected publish(
    partialPacket: ReadPacket<any>,
    callback: (packet: WritePacket<any>) => void
  ): () => void {
    try {
      const packet = this.assignPacketId(partialPacket);
      const { name, options } = readSenderOptions(packet.pattern);
      const serializedPacket = this.serializer.serialize(packet.data);
      const replyTo = this.getReplyTo(name);
      const receiver = this.sbClient.createReceiver(replyTo);

      let messages = [
        {
          messageId: packet.id,
          ...serializedPacket,
          replyTo,
        },
      ];

      if (Array.isArray(serializedPacket)) {
        messages = serializedPacket.map((msg) => ({
          messageId: packet.id,
          ...msg,
          replyTo,
        }));
      }

      this.routingMap.set(packet.id, callback);

      // Without an abort signal, subscribe() keeps retrying after close().
      const abortController = new AbortController();
      const subscription = receiver.subscribe(this.createMessageHandlers(packet, receiver), {
        abortSignal: abortController.signal,
        // Settled before the callback runs (see createMessageHandlers()): the
        // callback can end the request and close this receiver, which would
        // leave the SDK's own completion hanging on a closed link.
        autoCompleteMessages: false,
      });

      // A failed send (e.g. the entity does not exist) errors the Observable.
      this.sendTo(name, messages, options).catch((err) => callback({ err }));

      return () => {
        this.routingMap.delete(packet.id);
        abortController.abort();
        this.track(subscription.close().then(() => receiver.close())).catch((err) =>
          this.logger.error(
            `Could not close the reply receiver for "${replyTo}": ${err?.message ?? err}`,
            err?.stack
          )
        );
      };
    } catch (err) {
      callback({ err });
    }
  }

  /**
   * Sends through a short-lived sender. `close()` waits for it, and a failure
   * to close the sender is logged rather than left as an unhandled rejection.
   */
  private sendTo(
    name: string,
    messages: Parameters<ServiceBusSender["sendMessages"]>[0],
    options: AzureServiceBusSenderOptions["options"]
  ): Promise<void> {
    const sending = (async () => {
      const sender = this.sbClient.createSender(name);
      try {
        await sender.sendMessages(messages, options);
      } finally {
        await sender.close().catch((err) =>
          this.logger.error(
            `Could not close the sender for "${name}": ${err?.message ?? err}`,
            err?.stack
          )
        );
      }
    })();
    return this.track(sending);
  }

  /** Remembers `work` until it settles, so that `close()` can wait for it. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const forget = () => {
      this.inFlight.delete(work);
    };
    work.then(forget, forget);
    return work;
  }

  public createMessageHandlers = (
    packet: ReadPacket<any> & PacketId,
    receiver?: ServiceBusReceiver
  ): MessageHandlers => ({
    processMessage: async (receivedMessage: ServiceBusReceivedMessage) => {
      await receiver?.completeMessage(receivedMessage);
      await this.handleMessage(receivedMessage, packet);
    },
    processError: async (args: ProcessErrorArgs): Promise<void> => {
      return new Promise<void>(() => {
        throw new Error(`Error processing message: ${args.error}`);
      });
    },
  });

  public async handleMessage(
    receivedMessage: ServiceBusReceivedMessage,
    packet: ReadPacket<any> & PacketId
  ): Promise<void> {
    const { id, isDisposed } = await this.deserializer.deserialize(packet);
    const { body, correlationId, replyTo } = receivedMessage;

    if (replyTo && id !== correlationId) {
      return undefined;
    }

    const callback = this.routingMap.get(id);
    if (!callback) {
      return undefined;
    }

    if (isDisposed) {
      callback({
        response: body,
        isDisposed: true,
      });
    }
    callback({
      response: body,
    });
  }

  public getReplyTo = (pattern: string): string => {
    return `${pattern}.reply`;
  };

  createServiceBusClient(): ServiceBusClient {
    const { connectionString, options } = this.options;
    return new ServiceBusClient(connectionString, options);
  }

  /**
   * Returns the underlying `ServiceBusClient` (NestJS 11+ API).
   */
  unwrap<T = ServiceBusClient>(): T {
    if (!this.sbClient) {
      throw new Error('Not initialized. Please call the "connect" method first.');
    }
    return this.sbClient as T;
  }

  /**
   * Waits for the sends in flight (and for the reply receivers being closed),
   * then closes the connection. A later `send()`/`emit()` connects again.
   */
  async close(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    const client = this.sbClient;
    this.sbClient = undefined;
    await client?.close();
  }
}
