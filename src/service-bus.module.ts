import { ClientProxy, Closeable } from '@nestjs/microservices';
import {
  DynamicModule,
  Inject,
  Module,
  OnApplicationShutdown,
  Optional,
} from '@nestjs/common';

import { SbModuleOptions } from './interfaces';
import { SbClient } from './client';

@Module({})
export class ServiceBusModule {
  static forRoot(options: SbModuleOptions): DynamicModule {
    const clients = (options || []).map((item) => ({
      provide: item.name,
      useValue: this.assignOnAppShutdownHook(new SbClient(item)),
    }));
    return {
      module: ServiceBusModule,
      providers: clients,
      exports: clients,
    };
  }

  private static assignOnAppShutdownHook(client: ClientProxy & Closeable) {
    (client as unknown as OnApplicationShutdown).onApplicationShutdown =
      client.close;
    return client;
  }
}
