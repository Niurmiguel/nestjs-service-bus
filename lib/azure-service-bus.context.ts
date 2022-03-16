import { BaseRpcContext } from "@nestjs/microservices/ctx-host/base-rpc.context";

type AzureServiceBusContextArgs = [];

export class AzureServiceBusContext extends BaseRpcContext<AzureServiceBusContextArgs> {
  constructor(args: AzureServiceBusContextArgs) {
    super(args);
  }
}
