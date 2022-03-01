import { ModuleMetadata, Provider, Type } from '@nestjs/common';
import { ServiceBusClientOptions } from '@azure/service-bus';

export interface SbOptions {
  connectionString: string;
  options?: ServiceBusClientOptions;
}

export type SbProvider = SbOptions;

export type SbProviderOptions = SbProvider & {
  name: string | symbol;
};

export type SbModuleOptions = Array<SbProviderOptions>;

export interface SbModuleOptionsFactory {
  createClientOptions(): Promise<SbProvider> | SbProvider;
}

export interface SbProviderAsyncOptions
  extends Pick<ModuleMetadata, 'imports'> {
  useExisting?: Type<SbModuleOptionsFactory>;
  useClass?: Type<SbModuleOptionsFactory>;
  useFactory?: (...args: any[]) => Promise<SbProvider> | SbProvider;
  inject?: any[];
  extraProviders?: Provider[];
  name: string | symbol;
}

export type SbModuleAsyncOptions = Array<SbProviderAsyncOptions>;
