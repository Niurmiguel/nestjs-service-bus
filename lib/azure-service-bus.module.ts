import {
  DynamicModule,
  Global,
  Module,
  OnApplicationShutdown,
  Provider,
} from "@nestjs/common";
import { ClientProxy, Closeable } from "@nestjs/microservices";

import { AzureServiceBusClient } from "./client";
import {
  AzureServiceBusModuleAsyncOptions,
  AzureServiceBusModuleOptions,
  AzureServiceBusModuleOptionsFactory,
  AzureServiceBusProviderAsyncOptions,
} from "./interfaces";

@Global()
@Module({})
export class AzureServiceBusModule {
  static forRoot(options: AzureServiceBusModuleOptions): DynamicModule {
    const AzureServiceBus = (options || []).map((item) => ({
      provide: item.name,
      useValue: this.assignOnAppShutdownHook(new AzureServiceBusClient(item)),
    }));
    return {
      module: AzureServiceBusModule,
      providers: AzureServiceBus,
      exports: AzureServiceBus,
    };
  }

  static forRootAsync(
    options: AzureServiceBusModuleAsyncOptions
  ): DynamicModule {
    const providers: Provider[] = options.reduce(
      (accProviders: Provider[], item) =>
        accProviders
          .concat(this.createAsyncProviders(item))
          .concat(item.extraProviders || []),
      []
    );
    const imports = options.reduce(
      (accImports, option) =>
        option.imports && !accImports.includes(option.imports)
          ? accImports.concat(option.imports)
          : accImports,
      []
    );
    return {
      module: AzureServiceBusModule,
      imports,
      providers: providers,
      exports: providers,
    };
  }

  private static createAsyncProviders(
    options: AzureServiceBusProviderAsyncOptions
  ): Provider[] {
    if (options.useExisting || options.useFactory) {
      return [this.createAsyncOptionsProvider(options)];
    }
    return [
      this.createAsyncOptionsProvider(options),
      {
        provide: options.useClass,
        useClass: options.useClass,
      },
    ];
  }

  private static createAsyncOptionsProvider(
    options: AzureServiceBusProviderAsyncOptions
  ): Provider {
    if (options.useFactory) {
      return {
        provide: options.name,
        useFactory: this.createFactoryWrapper(options.useFactory),
        inject: options.inject || [],
      };
    }
    return {
      provide: options.name,
      useFactory: this.createFactoryWrapper(
        (optionsFactory: AzureServiceBusModuleOptionsFactory) =>
          optionsFactory.createAzureServiceBusOptions()
      ),
      inject: [options.useExisting || options.useClass],
    };
  }

  private static createFactoryWrapper(
    useFactory: AzureServiceBusProviderAsyncOptions["useFactory"]
  ) {
    return async (...args: any[]) => {
      const clientOptions = await useFactory(...args);
      const clientProxyRef = new AzureServiceBusClient(clientOptions);
      return this.assignOnAppShutdownHook(clientProxyRef);
    };
  }

  private static assignOnAppShutdownHook(client: ClientProxy & Closeable) {
    (client as unknown as OnApplicationShutdown).onApplicationShutdown =
      client.close;
    return client;
  }
}
