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
    const pattern = this.normalizePattern(packet.pattern);
    const { name, options } = JSON.parse(
      pattern
    ) as AzureServiceBusSenderOptions;
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
      const pattern = this.normalizePattern(packet.pattern);
      const { name, options } = JSON.parse(
        pattern
      ) as AzureServiceBusSenderOptions;
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

  async close(): Promise<void> {
    await this.sbClient?.close();
  }
}
