import { MessageHandler } from "@nestjs/microservices";
import { SbSubscriberMetadata } from "../metadata";
import { ServiceBusServer } from "../server";

export class SbDiscoveryService {
  constructor(
    protected readonly messageHandlers: Map<
      string,
      MessageHandler<any, any, any>
    >,
    protected registerRoute: any
  ) {}

  async discover() {
    await this.build();
  }

  private async build() {
    this.messageHandlers.forEach((v, k) => {
      const metadata: SbSubscriberMetadata = JSON.parse(k);

      this.registerRoute("method", metadata, v);
    });
  }
}
