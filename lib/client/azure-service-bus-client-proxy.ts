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
import { quote } from "../utils";
import { ServiceBusMessageBatch, ServiceBusSender } from "@azure/service-bus";

/**
 * What `emit()` accepts as data: whatever `ServiceBusSender.sendMessages()`
 * accepts (messages, a batch, AMQP annotated messages). Derived from the SDK
 * so that the typings do not import `@azure/core-amqp`, which is not a
 * dependency of this package.
 */
export type SendableMessages = Parameters<ServiceBusSender["sendMessages"]>[0];

/**
 * What `send()` accepts as data: messages or AMQP annotated messages, one or
 * several. Not a `ServiceBusMessageBatch`: its messages are already encoded,
 * so the reply queue and the request id cannot be added to them.
 */
export type SendableRequest = Exclude<SendableMessages, ServiceBusMessageBatch>;

/**
 * `never` for a `ServiceBusMessageBatch`, so that `send()` does not compile
 * with one. (A constraint on `send()`'s type parameter would not compile:
 * NestJS's `ClientProxy.send()` accepts any data.)
 */
export type NotABatch<T> = T extends ServiceBusMessageBatch ? never : unknown;

export abstract class AzureServiceBusClientProxy extends ClientProxy {
  protected readonly logger = new Logger("AzureServiceBusClient");

  public send<
    TResult = AzureServiceBusSenderOptions,
    TInput = SendableRequest
  >(
    pattern: AzureServiceBusSenderOptions,
    data: TInput & NotABatch<TInput>
  ): Observable<TResult> {
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
    TInput = SendableMessages
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
              `Could not emit to ${quote(pattern?.name)}: ${err?.message ?? err}`,
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
