import { ServiceBusReceiver } from "@azure/service-bus";
import { BaseRpcContext } from "@nestjs/microservices/ctx-host/base-rpc.context";

type AzureServiceBusContextArgs = [ServiceBusReceiver];

export class AzureServiceBusContext extends BaseRpcContext<AzureServiceBusContextArgs> {
  constructor(args: AzureServiceBusContextArgs) {
    super(args);
  }
}
