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
import { Module } from "@nestjs/core/injector/module";
import { InstanceWrapper } from "@nestjs/core/injector/instance-wrapper";

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
    await this.build();
  }

  public createClient(): ServiceBusClient {
    const { connectionString, options } = this.clientConfig;
    return new ServiceBusClient(connectionString, options);
  }

  private async build() {
    const promises = Array.from(this.modulesContainer.values()).map((module) =>
      this.parseModule(module)
    );

    await Promise.all(promises);
  }

  private async parseModule(module: Module) {
    const promises = [
      ...module.providers.values(),
      ...module.controllers.values(),
    ].map((instance) =>
      Promise.all([this.parseProvider(instance, new MetadataExplorer())])
    );

    await Promise.all(promises);
  }

  async parseProvider(
    instanceWrapper: InstanceWrapper<any>,
    explorer: MetadataExplorer
  ) {
    const promises: Array<Promise<any>> = [];

    if (!instanceWrapper.isNotMetatype) {
      for (const subscriber of explorer.scanForSubscriberHooks(
        instanceWrapper.instance
      )) {
        console.log(subscriber);

        // promises.push(this.initSubscriber(subscriber, instanceWrapper));
      }
    }

    return Promise.all(promises);
  }
}
