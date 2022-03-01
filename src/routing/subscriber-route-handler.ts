import {
  ServiceBusMessage,
  ServiceBusReceiver,
  ServiceBusSessionReceiver,
} from '@azure/service-bus';
import { MessageHandler } from '@nestjs/microservices';
import {
  isObservable,
  lastValueFrom,
  mapTo,
  Observable,
  of,
  OperatorFunction,
} from 'rxjs';
import { createConsumer } from '../interceptors';
import { RouteToCommit, SbSubscriberTypeMap } from '../interfaces';
import { SbSubscriberMetadata } from '../metadata';
import { SbContext } from '../service-bus.context';

class WrappedError extends Error {
  static wrapPromise(error: Error) {
    throw new WrappedError(error);
  }

  get name(): string {
    return this.error.name;
  }
  set name(value: string) {
    this.error.name = value;
  }

  get message(): string {
    return this.error.message;
  }
  set message(value: string) {
    this.error.message = value;
  }

  get stack(): string {
    return this.error.stack;
  }
  set stack(value: string) {
    this.error.stack = value;
  }

  constructor(public readonly error: Error) {
    super();
  }
}

export class SbSubscriberRouteHandler<
  T extends keyof SbSubscriberTypeMap = keyof SbSubscriberTypeMap,
> {
  constructor(public readonly type: T) {}

  async verifyAndCreate<R extends 'pipe' | 'method'>(
    routeInstructions: RouteToCommit<R, T>,
    receiver: ServiceBusReceiver, // todo - implement
    configurator?: any, // todo - implement
  ): Promise<void> {
    const options = routeInstructions.subscriber
      .metaOptions as SbSubscriberTypeMap[T];
    const { handler } = routeInstructions;

    const messageHandler =
      routeInstructions.type === 'method'
        ? this.createMethodHandler(
            routeInstructions.subscriber,
            handler as MessageHandler,
          )
        : this.createPipeHandler(
            routeInstructions.subscriber,
            handler as OperatorFunction<SbContext, SbContext>,
            routeInstructions,
          );

    try {
      await registerMessageHandler(receiver, messageHandler, (error) => {
        console.log({ error });
      });
    } catch (error) {
      console.log({ error });
    }

    // receiver.subscribe({
    //   processMessage: messageHandler,
    //   processError: async (err) => {
    //     console.log(err);
    //   },
    // });
  }

  private createMethodHandler(metadata: SbSubscriberMetadata<T>, handler: any) {
    return async (message: ServiceBusMessage) => {
      await handler(message.body, new SbContext([metadata, message]))
        .then(safeResolveResult)
        .catch(WrappedError.wrapPromise);
    };
  }

  private createPipeHandler(
    metadata: SbSubscriberMetadata<T>,
    handler: OperatorFunction<SbContext, SbContext>,
    routeInstructions: RouteToCommit,
  ) {
    const consumer = createConsumer(routeInstructions);

    return async (message: ServiceBusMessage) => {
      const context = new SbContext([metadata, message]);

      const done = async () =>
        lastValueFrom(handler(of(context)).pipe(mapTo(context)));
      await consumer
        .intercept(context, done)
        .then(safeResolveResult)
        .catch(WrappedError.wrapPromise);
    };
  }
}

async function registerMessageHandler(
  receiver: ServiceBusReceiver | ServiceBusSessionReceiver,
  onMessage: any,
  onError: any,
) {
  return new Promise((resolve, reject) => {
    let done = false;
    const onErrorRouter: any = (err) => {
      if (done) {
        onError(err);
      } else {
        done = true;
        reject(err);
      }
    };
    const poll = () => {
      setTimeout(() => {
        // if (receiver.isReceivingMessages()) {
        //   done = true;
        //   resolve();
        // } else if (!done) {
        //   poll();
        // }
      }, 10);
    };
    receiver.subscribe({
      processMessage: onMessage,
      processError: onError,
    });
    poll();
  });
}

async function safeResolveResult(result: Observable<any> | Promise<any> | any) {
  if (isObservable(result)) {
    await lastValueFrom(result);
  } else if (result && typeof (result as Promise<any>).then === 'function') {
    await result;
  } else {
    await Promise.resolve(result);
  }
}
