import { ServiceBusClient } from "@azure/service-bus";
import { ClientProxy, ReadPacket, WritePacket } from "@nestjs/microservices";
import { SbOptions } from "../interfaces";

export class SbClient extends ClientProxy {
  protected client: ServiceBusClient = null;
  protected responsePatterns: string[] = [];

  constructor(protected readonly options: SbOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  public subscribeToResponseOf(pattern: any): void {
    const request = this.normalizePattern(pattern);
    this.responsePatterns.push(this.getResponsePatternName(request));
  }

  async connect(): Promise<ServiceBusClient> {
    if (this.client) return this.client;
    this.client = this.createClient();

    console.log({ d: this.responsePatterns });
  }

  public createClient(): ServiceBusClient {
    const { connectionString, options } = this.getOptionsProp(
      this.options,
      "credentials"
    );
    return new ServiceBusClient(connectionString, options);
  }

  close() {
    this.client && this.client.close();
    this.client = null;
  }
  protected publish(
    packet: ReadPacket<any>,
    callback: (packet: WritePacket<any>) => void
  ): () => void {
    throw new Error("Method not implemented.");
  }

  protected getResponsePatternName(pattern: string): string {
    return `${pattern}.reply`;
  }

  protected dispatchEvent<T = any>(packet: ReadPacket<any>): Promise<T> {
    throw new Error("Method not implemented.");
  }
}
