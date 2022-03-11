import { ClientProxy, Closeable } from "@nestjs/microservices";
import {
  DynamicModule,
  Module,
  OnApplicationShutdown,
  Provider,
} from "@nestjs/common";

import { SbClient } from "./client/service-bus.client";
import {
  SbModuleAsyncOptions,
  SbModuleOptions,
  SbModuleOptionsFactory,
  SbProviderAsyncOptions,
} from "./interfaces";

@Module({})
export class SbModule {
  static register(options: SbModuleOptions): DynamicModule {
    const clients = (options || []).map((item) => ({
      provide: item.name,
      useValue: this.assignOnAppShutdownHook(new SbClient(item)),
    }));
    return {
      module: SbModule,
      providers: clients,
      exports: clients,
    };
  }

  static registerAsync(options: SbModuleAsyncOptions): DynamicModule {
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
      module: SbModule,
      imports,
      providers: providers,
      exports: providers,
    };
  }

  private static createAsyncProviders(
    options: SbProviderAsyncOptions
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
    options: SbProviderAsyncOptions
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
        (optionsFactory: SbModuleOptionsFactory) =>
          optionsFactory.createClientOptions()
      ),
      inject: [options.useExisting || options.useClass],
    };
  }

  private static createFactoryWrapper(
    useFactory: SbProviderAsyncOptions["useFactory"]
  ) {
    return async (...args: any[]) => {
      const clientOptions = await useFactory(...args);
      const clientProxyRef = new SbClient(clientOptions);
      return this.assignOnAppShutdownHook(clientProxyRef);
    };
  }

  private static assignOnAppShutdownHook(client: ClientProxy & Closeable) {
    (client as unknown as OnApplicationShutdown).onApplicationShutdown =
      client.close;
    return client;
  }
}
