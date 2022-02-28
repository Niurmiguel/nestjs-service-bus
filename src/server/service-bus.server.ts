import { CustomTransportStrategy, Server } from "@nestjs/microservices";
import { ServiceBusClient } from "@azure/service-bus";
import { Inject, Injectable } from "@nestjs/common";

import {
  ServiceBusConnectionStringCredentials,
  ServiceBusModuleOptions,
} from "../interfaces";
import { SERVICE_BUS_MODULE_OPTIONS } from "../constants";
import { ModulesContainer } from "@nestjs/core";
import { MetadataExplorer } from "./metadata-explorer";

@Injectable()
export class ServerServiceBus
  extends Server
  implements CustomTransportStrategy
{
  protected client: ServiceBusClient = null;
  protected clientConfig: ServiceBusConnectionStringCredentials;

  constructor(
    readonly modulesContainer: ModulesContainer,
    @Inject(SERVICE_BUS_MODULE_OPTIONS) options: ServiceBusModuleOptions
  ) {
    super();

    this.clientConfig = options.client;

    console.log(modulesContainer.values());

    console.log(new MetadataExplorer());

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public async listen(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void
  ): Promise<void> {
    try {
      await this.start(callback);
    } catch (err) {
      callback(err);
    }
  }

  close() {
    this.client?.close();
  }

  public async start(callback?: () => void) {
    this.client = this.createClient();

    this.logger.warn("Service Bus connection stablished!");
  }

  public createClient(): ServiceBusClient {
    const { connectionString, options } = this.clientConfig;
    return new ServiceBusClient(connectionString, options);
  }
}
