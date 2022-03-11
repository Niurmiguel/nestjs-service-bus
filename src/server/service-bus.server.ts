import { CustomTransportStrategy, Server } from "@nestjs/microservices";
import { Injectable } from "@nestjs/common";
import {
  delay,
  isServiceBusError,
  ProcessErrorArgs,
  ServiceBusClient,
  ServiceBusReceivedMessage,
} from "@azure/service-bus";

import { ServiceBusContext } from "../service-bus.context";
import { SbSubscriberMetadata } from "../metadata";
import { SbOptions } from "../interfaces";

@Injectable()
export class ServiceBusServer
  extends Server
  implements CustomTransportStrategy
{
  protected client: ServiceBusClient = null;

  constructor(protected readonly options: SbOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  /**
   * This method is triggered when you run "app.listen()".
   */
  public async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void
  ): Promise<void> {
    try {
      this.client = this.createClient();
      await this.start(callback);
    } catch (err) {
      callback(err);
    }
  }

  /**
   * This method is triggered on application shutdown.
   */
  close() {
    this.client?.close();
  }

  public async start(callback?: () => void) {
    await this.bindEvents();
    callback();
  }

  public createClient(): ServiceBusClient {
    const { connectionString, options } = this.getOptionsProp(
      this.options,
      "credentials"
    );
    return new ServiceBusClient(connectionString, options);
  }

  public async bindEvents() {
    const registeredPatterns = [...this.messageHandlers.keys()];

    const subscribeToPattern = async (pattern: string) => {
      const {
        type,
        metaOptions: {
          topic,
          subscription: name,
          subQueueType,
          skipParsingBodyAsJson,
          receiveMode,
          options,
        },
      }: SbSubscriberMetadata = JSON.parse(pattern);
      if (type === "subscription") {
        const receiver = this.client.createReceiver(topic, name, {
          receiveMode,
          subQueueType,
          skipParsingBodyAsJson,
        });

        const subscription = receiver.subscribe(
          {
            processMessage: this.getMessageHandler(pattern),
            processError: async (args: ProcessErrorArgs) => {
              this.logger.error(
                `Error from source ${args.errorSource} occurred: `,
                args.error
              );

              if (isServiceBusError(args.error)) {
                switch (args.error.code) {
                  case "MessagingEntityDisabled":
                  case "MessagingEntityNotFound":
                  case "UnauthorizedAccess":
                    this.logger.error(
                      `An unrecoverable error occurred. Stopping processing. ${args.error.code}`,
                      args.error
                    );
                    await subscription.close();
                    break;
                  case "MessageLockLost":
                    this.logger.error(
                      `Message lock lost for message`,
                      args.error
                    );
                    break;
                  case "ServiceBusy":
                    await delay(1000);
                    break;
                }
              }
            },
          },
          options
        );
      }
    };
    await Promise.all(registeredPatterns.map(subscribeToPattern));
  }

  public getMessageHandler(pattern) {
    return async (payload) => this.handleMessage(payload, pattern);
  }

  public async handleMessage(
    payload: ServiceBusReceivedMessage,
    pattern: string
  ) {
    const handler = this.getHandlerByPattern(pattern);

    await handler(
      payload.body,
      new ServiceBusContext([JSON.parse(pattern), payload])
    );
  }
}
