import {
  OperationOptionsBase,
  ServiceBusClientOptions,
} from "@azure/service-bus";

export interface AzureServiceBusOptions {
  connectionString: string;
  options?: ServiceBusClientOptions;
}

export interface AzureServiceBusSenderOptions {
  name: string;
  options?: OperationOptionsBase;
}
