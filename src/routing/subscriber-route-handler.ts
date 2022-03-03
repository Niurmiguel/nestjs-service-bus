import { MessageHandler } from "@nestjs/microservices";
import { LoggerService } from "@nestjs/common";
import {
  delay,
  isServiceBusError,
  ProcessErrorArgs,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
} from "@azure/service-bus";
import { isObservable, lastValueFrom, Observable } from "rxjs";

import { RouteToCommit, SbSubscriberTypeMap } from "../interfaces";
import { ServiceBusContext } from "../service-bus.context";
import { SbSubscriberMetadata } from "../metadata";
import { WrappedError } from "../errors";

export class SbSubscriberRouteHandler<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap
> {
  constructor(public readonly type: T, public readonly logger: LoggerService) {}

  async verifyAndCreate<R extends "method">(
    routeInstructions: RouteToCommit<R, T>,
    receiver: ServiceBusReceiver,
    configurator?: any // todo - implement
  ): Promise<void> {
    const options = routeInstructions.subscriber
      .metaOptions as SbSubscriberTypeMap[T];
    const { handler } = routeInstructions;

    const messageHandler = this.createMethodHandler(
      routeInstructions.subscriber,
      handler as MessageHandler
    );

    try {
      const subscription = receiver.subscribe({
        processMessage: messageHandler,
        processError: async (args: ProcessErrorArgs) => {
          this.logger.error(
            `Error from source ${args.errorSource} occurred: `,
            args.error
          );

          if (isServiceBusError(args.error)) {
            switch (args.error.code) {
              case "MessagingEntityDisabled":
              case "MessagingEntityNotFound":
              case "UnauthorizedAccess":
                this.logger.error(
                  `An unrecoverable error occurred. Stopping processing. ${args.error.code}`,
                  args.error
                );
                await subscription.close();
                break;
              case "MessageLockLost":
                this.logger.error(`Message lock lost for message`, args.error);
                break;
              case "ServiceBusy":
                await delay(1000);
                break;
            }
          }
        },
      });
    } catch (err) {
      this.logger.log("ReceiveMessagesStreaming - Error occurred: ", err);
    }
  }

  private createMethodHandler(metadata: SbSubscriberMetadata<T>, handler: any) {
    return async (message: ServiceBusReceivedMessage): Promise<void> => {
      await handler(message.body, new ServiceBusContext([metadata, message]))
        .then(safeResolveResult)
        .catch(WrappedError.wrapPromise);
    };
  }
}

async function safeResolveResult(result: Observable<any> | Promise<any> | any) {
  if (isObservable(result)) {
    await lastValueFrom(result);
  } else if (result && typeof (result as Promise<any>).then === "function") {
    await result;
  } else {
    await Promise.resolve(result);
  }
}
