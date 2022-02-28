import { DynamicModule, Module, Provider, Type } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { SERVICE_BUS_MODULE_OPTIONS } from "./constants";
import {
  ServiceBusModuleAsyncOptions,
  ServiceBusModuleOptions,
} from "./interfaces";
import { ServerServiceBus } from "./server";

@Module({})
export class ServiceBusModule {
  /**
   * Bootstraps the Service Bus Module synchronously
   * @param {ServiceBusModuleOptions} options The options for the Service Bus Module
   */
  static forRoot(options: ServiceBusModuleOptions): DynamicModule {
    return ServiceBusModule.forRootAsync({
      useFactory: () => options,
    });
  }

  /**
   * Bootstrap the Service Bus Module asynchronously
   * @param options The options for the Service Bus module
   */
  static forRootAsync(options: ServiceBusModuleAsyncOptions): DynamicModule {
    const { imports = [], useClass, useFactory, useExisting, inject } = options;
    return {
      module: ServiceBusModule,
      global: true,
      imports,
      providers: [
        {
          inject,
          useClass,
          useFactory,
          useExisting,
          provide: SERVICE_BUS_MODULE_OPTIONS,
        },
        ServerServiceBus,
      ],
      exports: [ServerServiceBus],
    };
  }
}
