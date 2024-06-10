import {
  Server,
  WritePacket,
  CustomTransportStrategy,
} from "@nestjs/microservices";
import {
  MessageHandlers,
  ProcessErrorArgs,
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from "@azure/service-bus";

import { AzureServiceBusContext } from "../azure-service-bus.context";
import { AzureServiceBusOptions } from "../interfaces";
import { SbSubscriberMetadata } from "../metadata";

export class AzureServiceBusServer
  extends Server
  implements CustomTransportStrategy
{
  private sbClient: ServiceBusClient;
  private readonly sbReceivers = new Map<string, ServiceBusReceiver>();
  constructor(protected readonly options: AzureServiceBusOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  async listen(callback: (...optionalParams: unknown[]) => any) {
    try {
      this.sbClient = this.createServiceBusClient();
      await this.start(callback);
    } catch (err) {
      callback(err);
    }
  }

  async start(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void
  ): Promise<void> {
    await this.bindEvents();
    callback();
  }

  async bindEvents(): Promise<void> {
    const subscribe = async (pattern: string) => {
      const {
        metaOptions: {
          topic,
          subscription: name,
          subQueueType,
          skipParsingBodyAsJson,
          receiveMode,
          options,
        },
      }: SbSubscriberMetadata = JSON.parse(pattern);

      const receiver = this.sbClient.createReceiver(topic, name, {
        receiveMode,
        subQueueType,
        skipParsingBodyAsJson,
      });

      await receiver.subscribe(this.createMessageHandlers(pattern), options);
      this.sbReceivers.set(pattern,receiver);
    };

    const registeredPatterns = [...this.messageHandlers.keys()];
    await Promise.all(registeredPatterns.map(subscribe));
  }

  public createMessageHandlers = (pattern: string): MessageHandlers => ({
    processMessage: async (receivedMessage: ServiceBusReceivedMessage) =>
      await this.handleMessage(receivedMessage, pattern),
    processError: async (args: ProcessErrorArgs): Promise<void> => {
      return new Promise<void>(() => {
        console.error(`Error processing message: ${args.error}`);
      });
    },
  });

  public async handleMessage(
    receivedMessage: ServiceBusReceivedMessage,
    pattern: string
  ): Promise<void> {
    const partialPacket = { data: receivedMessage, pattern };
    const packet = await this.deserializer.deserialize(partialPacket);
    if (!receivedMessage.replyTo) {
      const sbContext = new AzureServiceBusContext([this.sbReceivers.get(packet.pattern)]);
      return this.handleEvent(packet.pattern, packet, sbContext);
    }

    const publish = this.getPublisher(
      receivedMessage.replyTo,
      receivedMessage.messageId as string
    );

    const handler = this.getHandlerByPattern(pattern);
    const response$ = this.transformToObservable(
      await handler(receivedMessage)
    );
    response$ && this.send(response$, publish);
  }

  public getPublisher(replyTo: string, correlationId: string) {
    return async (data: WritePacket) => {
      const sender = this.sbClient.createSender(replyTo);
      const responseMessage = {
        correlationId,
        body: data.response,
      } as ServiceBusMessage;
      await sender.sendMessages([responseMessage]);
      await sender.close();
    };
  }

  createServiceBusClient(): ServiceBusClient {
    const { connectionString, options } = this.options;
    return new ServiceBusClient(connectionString, options);
  }

  async close(): Promise<void> {
    const registeredReceivers= [...this.sbReceivers.keys()]
    await Promise.all(registeredReceivers.map(async key=>{
      await this.sbReceivers.get(key).close();
    }))
    await this.sbClient?.close();
  }
}
