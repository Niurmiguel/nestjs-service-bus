import { CustomTransportStrategy, Server } from '@nestjs/microservices';
import { ServiceBusClient } from '@azure/service-bus';
import { Injectable } from '@nestjs/common';

import { SbSubscriberRouteHandler } from '../routing/subscriber-route-handler';
import { RouteToCommit, SbOptions } from '../interfaces';
import { SbSubscriberMetadata } from '../metadata';

@Injectable()
export class SbServer extends Server implements CustomTransportStrategy {
  protected server: ServiceBusClient = null;

  constructor(protected readonly options: SbOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  /**
   * This method is triggered when you run "app.listen()".
   */
  public async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void,
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
    this.logger?.debug('Listening for Service Bus messages...');
    this.server = this.createClient();

    const routeInstructions: RouteToCommit<
      'pipe' | 'method',
      'subscription'
    >[] = [];

    this.messageHandlers.forEach((v, k) => {
      const metadata: SbSubscriberMetadata = JSON.parse(k);
      if (metadata.type === 'subscription') {
        routeInstructions.push({
          type: 'method',
          key: 'echo',
          subscriber: JSON.parse(k),
          handler: v,
          instanceWrapper: null,
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
          },
        );

        await new SbSubscriberRouteHandler('subscription').verifyAndCreate(
          routeInstruction,
          receiver,
        );
      }
    }

    callback();
  }

  public createClient(): ServiceBusClient {
    const connectionString = this.getOptionsProp(
      this.options,
      'connectionString',
    );
    const options = this.getOptionsProp(this.options, 'options');
    return new ServiceBusClient(connectionString, options);
  }
}
