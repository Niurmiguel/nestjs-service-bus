import { Abstract, ModuleMetadata, Type } from "@nestjs/common";
import { ServiceBusClientOptions } from "@azure/service-bus";

export interface ServiceBusConnectionStringCredentials {
  connectionString: string;
  options?: ServiceBusClientOptions;
}

export interface ServiceBusModuleOptions {
  client: ServiceBusConnectionStringCredentials;
}

/**
 * The interface for the factory which provides the Service Bus options
 *
 * @publicApi
 */
export interface ServiceBusOptionsFactory {
  /**
   * The function which returns the Service Bus Options
   */
  createServiceBusOptions():
    | Promise<ServiceBusModuleOptions>
    | ServiceBusModuleOptions;
}

/**
 * The options for the asynchronous Service Bus module creation
 *
 * @publicApi
 */
export interface ServiceBusModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  /**
   * The name of the module
   */
  name?: string;
  /**
   * The class which should be used to provide the Terminus options
   */
  useClass?: Type<ServiceBusOptionsFactory>;
  /**
   * Import existing providers from other module
   */
  useExisting?: Type<ServiceBusOptionsFactory>;
  /**
   * The factory which should be used to provide the Terminus options
   */
  useFactory?: (
    ...args: any[]
  ) => Promise<ServiceBusModuleOptions> | ServiceBusModuleOptions;
  /**
   * The providers which should get injected
   */
  inject?: (string | symbol | Function | Type<any> | Abstract<any>)[];
}
