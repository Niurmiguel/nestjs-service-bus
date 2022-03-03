import {
  CustomTransportStrategy,
  MessageHandler,
  Server,
} from "@nestjs/microservices";
import { ServiceBusClient } from "@azure/service-bus";
import { Injectable } from "@nestjs/common";

import { SbSubscriberRouteHandler } from "../routing/subscriber-route-handler";
import { RouteToCommit, SbOptions } from "../interfaces";
import { SbSubscriberMetadata } from "../metadata";
import { SbDiscoveryService } from "../discovery";
import { ModulesContainer } from "@nestjs/core";

@Injectable()
export class ServiceBusServer
  extends Server
  implements CustomTransportStrategy
{
  protected server: ServiceBusClient = null;

  constructor(
    private readonly modulesContainer: ModulesContainer,
    protected readonly options: SbOptions
  ) {
    super();

    console.log(modulesContainer);

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  registerRoute(
    type: "method",
    subscriber: SbSubscriberMetadata,
    handler: MessageHandler
  ) {
    console.log({ type, subscriber, handler });

    // this.appendRoute({ type, key, subscriber, instanceWrapper, handler });
  }

  /**
   * This method is triggered when you run "app.listen()".
   */
  public async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void
  ): Promise<void> {
    try {
      await this.start(callback);
    } catch (err) {
      callback(err);
    }
  }

  /**
   * This method is triggered on application shutdown.
   */
  close() {
    this.server?.close();
  }

  public async start(callback?: () => void) {
    this.server = this.createClient();

    await new SbDiscoveryService(
      this.messageHandlers,
      this.registerRoute
    ).discover();

    const routeInstructions: RouteToCommit<"method", "subscription">[] = [];

    this.messageHandlers.forEach((v, k) => {
      const metadata: SbSubscriberMetadata = JSON.parse(k);
      if (metadata.type === "subscription") {
        routeInstructions.push({
          type: "method",
          subscriber: JSON.parse(k),
          handler: v,
        });
      }
    });

    if (routeInstructions.length) {
      for (const routeInstruction of routeInstructions) {
        const { subscriber } = routeInstruction;

        const receiver = this.server.createReceiver(
          subscriber.metaOptions.topic,
          subscriber.metaOptions.subscription,
          {
            receiveMode: subscriber.metaOptions.receiveMode,
          }
        );

        new SbSubscriberRouteHandler(
          "subscription",
          this.logger
        ).verifyAndCreate(routeInstruction, receiver);
      }
    }

    callback();
  }

  public createClient(): ServiceBusClient {
    const { connectionString, options } = this.getOptionsProp(
      this.options,
      "client"
    );
    return new ServiceBusClient(connectionString, options);
  }
}
