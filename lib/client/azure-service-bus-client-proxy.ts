import { isNil } from "@nestjs/common/utils/shared.utils";
import { ClientProxy } from "@nestjs/microservices";
import {
  connectable,
  defer,
  mergeMap,
  Observable,
  Observer,
  Subject,
  throwError,
} from "rxjs";

import { AzureServiceBusSenderOptions } from "../interfaces";
import { InvalidMessageException } from "../errors";
import { ServiceBusMessage, ServiceBusMessageBatch } from "@azure/service-bus";
import { AmqpAnnotatedMessage } from "@azure/core-amqp";

export abstract class AzureServiceBusClientProxy extends ClientProxy {
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
    const source = defer(async () => this.connect()).pipe(
      mergeMap(() => this.dispatchEvent({ pattern, data }))
    );
    const connectableSource = connectable(source, {
      connector: () => new Subject(),
      resetOnDisconnect: false,
    });
    connectableSource.connect();
    return connectableSource;
  }
}
