import { ServiceBusClientOptions } from "@azure/service-bus";

export interface SbOptions {
  credentials: {
    connectionString: string;
    options?: ServiceBusClientOptions;
  };
}
