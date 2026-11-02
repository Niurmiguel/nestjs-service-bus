import {
  MessageHandlers,
  ProcessErrorArgs,
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
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

    const sender = this.sbClient.createSender(name);
    await sender.sendMessages(messages, options);
    await sender.close();
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
      const sender = this.sbClient.createSender(name);
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

      sender.sendMessages(messages, options);

      if (replyTo) {
        receiver.subscribe(this.createMessageHandlers(packet));
      }

      return () => {
        sender.close();
        receiver.close();
        this.routingMap.delete(packet.id);
      };
    } catch (err) {
      callback({ err });
    }
  }

  public createMessageHandlers = (
    packet: ReadPacket<any> & PacketId
  ): MessageHandlers => ({
    processMessage: async (receivedMessage: ServiceBusReceivedMessage) => {
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

  async close(): Promise<void> {
    await this.sbClient?.close();
  }
}
