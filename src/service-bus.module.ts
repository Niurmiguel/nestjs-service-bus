import { DynamicModule, Module, Provider, Type } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { SERVICE_BUS_MODULE_OPTIONS } from "./constants";
import {
  ServiceBusModuleAsyncOptions,
  ServiceBusModuleOptions,
  ServiceBusOptionsFactory,
} from "./interfaces";
import { ServerServiceBus } from "./server";

@Module({
  providers: [ServerServiceBus],
})
export class ServiceBusModule {
  constructor(readonly modulesContainer: ModulesContainer) {}

  /**
   * Bootstraps the Service Bus Module synchronously
   * @param {ServiceBusModuleOptions} options The options for the Service Bus Module
   */
  static forRoot(options: ServiceBusModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: SERVICE_BUS_MODULE_OPTIONS,
        useValue: options,
      },
    ];

    return {
      module: ServiceBusModule,
      providers,
      exports: providers,
    };
  }

  /**
   * Bootstrap the Service Bus Module asynchronously
   * @param options The options for the Service Bus module
   */
  static forRootAsync(options: ServiceBusModuleAsyncOptions): DynamicModule {
    const asyncProviders = this.createAsyncProviders(options);

    return {
      module: ServiceBusModule,
      imports: [...(options.imports || [])],
      providers: [...asyncProviders],
      exports: [...asyncProviders],
    };
  }

  private static createAsyncProviders(
    options: ServiceBusModuleAsyncOptions
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    const useClass = options.useClass as Type<ServiceBusOptionsFactory>;
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: useClass,
        useClass,
        inject: [...(options.inject || [])],
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: ServiceBusModuleAsyncOptions
  ): Provider {
    if (options.useFactory) {
      return {
        provide: SERVICE_BUS_MODULE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      };
    }
    if (options.useClass || options.useExisting) {
      const inject = [
        (options.useClass ||
          options.useExisting) as Type<ServiceBusOptionsFactory>,
      ];
      return {
        provide: SERVICE_BUS_MODULE_OPTIONS,
        useFactory: async (optionsFactory: ServiceBusOptionsFactory) =>
          await optionsFactory.createServiceBusOptions(),
        inject,
      };
    }

    throw new Error();
  }
}
