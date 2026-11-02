import { Logger } from "@nestjs/common";
import { isNil } from "@nestjs/common/utils/shared.utils";
import { ClientProxy } from "@nestjs/microservices";
import {
  connectable,
  defer,
  mergeMap,
  Observable,
  Observer,
  Subject,
  tap,
  throwError,
} from "rxjs";

import { AzureServiceBusSenderOptions } from "../interfaces";
import { InvalidMessageException } from "../errors";
import { ServiceBusMessage, ServiceBusMessageBatch } from "@azure/service-bus";
import { AmqpAnnotatedMessage } from "@azure/core-amqp";

export abstract class AzureServiceBusClientProxy extends ClientProxy {
  protected readonly logger = new Logger("AzureServiceBusClient");

  public send<
    TResult = AzureServiceBusSenderOptions,
    TInput =
      | ServiceBusMessage
      | ServiceBusMessage[]
      | ServiceBusMessageBatch
      | AmqpAnnotatedMessage
      | AmqpAnnotatedMessage[]
  >(pattern: AzureServiceBusSenderOptions, data: TInput): Observable<TResult> {
    if (isNil(pattern) || isNil(data)) {
      return throwError(() => new InvalidMessageException());
    }

    return defer(async () => this.connect()).pipe(
      mergeMap(
        () =>
          new Observable((observer: Observer<TResult>) => {
            const callback = this.createObserver(observer);
            return this.publish({ pattern, data }, callback);
          })
      )
    );
  }

  public emit<
    TResult = AzureServiceBusSenderOptions,
    TInput =
      | ServiceBusMessage
      | ServiceBusMessage[]
      | ServiceBusMessageBatch
      | AmqpAnnotatedMessage
      | AmqpAnnotatedMessage[]
  >(pattern: AzureServiceBusSenderOptions, data: TInput): Observable<TResult> {
    if (isNil(pattern) || isNil(data)) {
      return throwError(() => new InvalidMessageException());
    }
    let subject: Subject<TResult>;
    const source = defer(async () => this.connect()).pipe(
      mergeMap(() => this.dispatchEvent({ pattern, data })),
      tap({
        error: (err) => {
          // emit() is often fire-and-forget: with nobody subscribed, the error
          // would otherwise vanish.
          if (!subject.observed) {
            this.logger.error(
              `Could not emit to "${pattern?.name}": ${err?.message ?? err}`,
              err?.stack
            );
          }
        },
      })
    );
    const connectableSource = connectable(source, {
      connector: () => (subject = new Subject()),
      resetOnDisconnect: false,
    });
    connectableSource.connect();
    return connectableSource;
  }
}
