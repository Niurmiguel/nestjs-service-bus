import { CustomTransportStrategy, Server } from "@nestjs/microservices";
import { ServiceBusClient } from "@azure/service-bus";
import { Injectable } from "@nestjs/common";

import { ServiceBusModuleOptions } from "../interfaces";

@Injectable()
export class ServerServiceBus
  extends Server
  implements CustomTransportStrategy
{
  protected client: ServiceBusClient = null;

  constructor(protected readonly options: ServiceBusModuleOptions) {
    super();

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

    console.log(this.client);
  }

  public createClient(): ServiceBusClient {
    const { connectionString, options } = this.getOptionsProp(
      this.options,
      "client"
    );
    return new ServiceBusClient(connectionString, options);
  }
}
