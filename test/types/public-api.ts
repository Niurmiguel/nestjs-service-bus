// Compile-time tests: this file must compile (`tsc -p test/types`), and each
// `@ts-expect-error` line must fail to compile. Nothing here runs.
import { ServiceBusMessageBatch, ServiceBusReceivedMessage } from "@azure/service-bus";
import { CustomTransportStrategy, MessagePattern, Transport } from "@nestjs/microservices";
import { Observable } from "rxjs";

import {
  AZURE_SERVICE_BUS_TRANSPORT,
  AllowedReplyTo,
  AzureServiceBusClient,
  AzureServiceBusClientOptions,
  AzureServiceBusContextArgs,
  AzureServiceBusModuleOptions,
  AzureServiceBusOptions,
  AzureServiceBusProviderAsyncOptions,
  AzureServiceBusSenderOptions,
  AzureServiceBusServer,
  AzureServiceBusServerOptions,
  MetaOrMetaFactory,
  Queue,
  SbQueueMetadataOptions,
  SbReceiverMetadataOptions,
  SbSubscriberMetadata,
  SbSubscriberTypeMap,
  SbSubscriptionMetadataOptions,
  SendableMessages,
  SendableRequest,
  SubscriberMetadataForTarget,
} from "../../dist";

declare const client: AzureServiceBusClient;
declare const batch: ServiceBusMessageBatch;
const pattern: AzureServiceBusSenderOptions = { name: "orders" };

// send(): messages and annotated messages, one or several.
const single: Observable<number> = client.send<number>(pattern, { body: 1 });
client.send(pattern, [{ body: 1 }, { body: 2, messageId: "dedup-key" }]);
client.send(pattern, { body: 1, bodyType: "value" as const });
// @ts-expect-error a batch cannot carry the reply queue: send() rejects it.
client.send(pattern, batch);
// emit() still sends a batch.
client.emit(pattern, batch);

// The interfaces are exported from the package root.
const clientOptions: AzureServiceBusClientOptions = {
  connectionString: "Endpoint=sb://localhost;SharedAccessKeyName=k;SharedAccessKey=v",
  replyTimeoutInMs: 30_000,
  replySessions: true,
  closeTimeoutInMs: 3_000,
};
const serverOptions: AzureServiceBusServerOptions = {
  connectionString: clientOptions.connectionString,
  allowedReplyTo: ["orders.reply"],
  closeTimeoutInMs: 10_000,
  replyTimeToLiveInMs: 60_000,
};
const byFunction: AllowedReplyTo = (replyTo: string, message: ServiceBusReceivedMessage) =>
  replyTo.endsWith(".reply") && message.replyToSessionId !== "";
const base: AzureServiceBusOptions = serverOptions;
new AzureServiceBusServer(serverOptions);
new AzureServiceBusServer(base); // 1.1.0-style options still compile
new AzureServiceBusClient(clientOptions);
const moduleOptions: AzureServiceBusModuleOptions = [{ name: "SB", ...clientOptions }];
const asyncOptions: AzureServiceBusProviderAsyncOptions = {
  name: "SB",
  useFactory: () => clientOptions,
};
const queue: SbQueueMetadataOptions = { queueName: "jobs", receiveMode: "peekLock" };
const subscription: SbSubscriptionMetadataOptions = {
  topic: "orders",
  subscription: "billing",
  receiveMode: "receiveAndDelete",
};
const receiverOptions: SbReceiverMetadataOptions = queue;
const map: SbSubscriberTypeMap = { queue, subscription };
const factory: MetaOrMetaFactory<SbQueueMetadataOptions> = async () => queue;
const args: AzureServiceBusContextArgs = [];
const sendable: SendableMessages = batch;
const request: SendableRequest = { body: 1 };

// Hybrid applications: the transport id is exported, for handlers declared
// by hand for this transport, and the server is still a custom strategy.
const transport: symbol = AZURE_SERVICE_BUS_TRANSPORT;
const strategy: CustomTransportStrategy = new AzureServiceBusServer(serverOptions);
const transportId: Transport | symbol | undefined = new AzureServiceBusServer(serverOptions).transportId;
class HybridHandlers {
  @Queue({ queueName: "jobs", receiveMode: "peekLock" })
  onJob(): void {}

  @MessagePattern({ cmd: "sum" }, Transport.TCP)
  sum(numbers: number[]): number {
    return numbers.reduce((a, b) => a + b, 0);
  }
}
class CustomServer extends AzureServiceBusServer {}
const custom: CustomTransportStrategy = new CustomServer(serverOptions);

// Reading the stored decorator metadata: metaOptions is a union since @Queue.
declare const stored: SubscriberMetadataForTarget;
const names = stored.map(({ metadata }) =>
  metadata.type === "queue"
    ? (metadata as SbSubscriberMetadata<"queue">).metaOptions.queueName
    : (metadata as SbSubscriberMetadata<"subscription">).metaOptions.topic
);

export {
  single,
  byFunction,
  moduleOptions,
  asyncOptions,
  receiverOptions,
  map,
  factory,
  args,
  sendable,
  request,
  names,
  transport,
  strategy,
  transportId,
  HybridHandlers,
  custom,
};
