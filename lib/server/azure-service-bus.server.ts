import {
  Server,
  WritePacket,
  CustomTransportStrategy,
} from "@nestjs/microservices";
import {
  MessageHandlers,
  ProcessErrorArgs,
  ServiceBusClient,
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusReceiverOptions,
} from "@azure/service-bus";
import { Observable, finalize } from "rxjs";

import { AzureServiceBusContext } from "../azure-service-bus.context";
import {
  AzureServiceBusOptions,
  SbQueueMetadataOptions,
  SbSubscriberTypeMap,
  SbSubscriptionMetadataOptions,
} from "../interfaces";

/** A receiver opened by `bindEvents()` and the subscription it is running. */
interface ActiveReceiver {
  receiver: ServiceBusReceiver;
  subscription: { close(): Promise<void> };
  /** Cancels the SDK's (infinite) reconnect retries when closing. */
  abortController: AbortController;
  /** `options.autoCompleteMessages`, which the server applies itself. */
  autoComplete: boolean;
}

/** What a handler pattern holds once parsed back from Nest's string key. */
interface SubscriberPattern {
  type?: keyof SbSubscriberTypeMap;
  metaOptions: Partial<SbSubscriptionMetadataOptions & SbQueueMetadataOptions>;
}

/** Resolves when `promise` settles, whatever the outcome. */
const settled = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (err) => err
  );

export class AzureServiceBusServer
  extends Server
  implements CustomTransportStrategy
{
  private sbClient: ServiceBusClient;
  /** Receivers kept open while listening, by handler pattern. */
  private readonly receivers = new Map<string, ActiveReceiver>();
  /** Messages being handled right now, so `close()` can wait for them. */
  private readonly inFlight = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;

  constructor(protected readonly options: AzureServiceBusOptions) {
    super();

    this.initializeSerializer(options);
    this.initializeDeserializer(options);
  }

  async listen(callback: (...optionalParams: unknown[]) => any) {
    try {
      await this.closing;
      // A second listen() reuses the client and the receivers already open.
      if (!this.sbClient) {
        this.sbClient = this.createServiceBusClient();
      }
      await this.start(callback);
    } catch (err) {
      // Do not leave half the receivers (and the AMQP connection) open: they
      // would keep the process alive after a failed start.
      await this.close().catch((closeErr) =>
        this.logger.error(
          `Could not close Azure Service Bus after a failed start: ${closeErr}`
        )
      );
      callback(err);
    }
  }

  async start(
    callback: (err?: unknown, ...optionalParams: unknown[]) => void
  ): Promise<void> {
    await this.bindEvents();
    callback();
  }

  /**
   * Opens one receiver per registered handler and keeps it open until
   * `close()`. Handlers that already have a receiver are skipped.
   */
  async bindEvents(): Promise<void> {
    for (const pattern of this.messageHandlers.keys()) {
      if (this.receivers.has(pattern)) {
        continue;
      }
      const { metaOptions } = this.parsePattern(pattern);
      const receiver = this.createReceiver(metaOptions, pattern);
      const abortController = new AbortController();
      const subscription = receiver.subscribe(this.createMessageHandlers(pattern), {
        ...metaOptions.options,
        // Completed by the server after the handler (see processMessage()), so
        // that close() can wait for it instead of racing the SDK.
        autoCompleteMessages: false,
        abortSignal: abortController.signal,
      });
      this.receivers.set(pattern, {
        receiver,
        subscription,
        abortController,
        autoComplete: metaOptions.options?.autoCompleteMessages ?? true,
      });
    }
  }

  public createMessageHandlers = (pattern: string): MessageHandlers => ({
    processMessage: (receivedMessage: ServiceBusReceivedMessage) =>
      this.track(this.processMessage(receivedMessage, pattern)),
    processError: async (args: ProcessErrorArgs): Promise<void> => {
      // The SDK keeps retrying on its own; this is for visibility only. It
      // must resolve: the SDK awaits it before giving up on a subscribe().
      const error = args.error as Error | undefined;
      if (this.closing && error?.name === "AbortError") {
        return; // close() cancelled the SDK's retries on purpose.
      }
      this.logger.error(
        `Azure Service Bus ${args.errorSource} error on "${args.entityPath}": ${
          error?.message ?? error
        }`,
        error?.stack
      );
    },
  });

  /**
   * Runs the handler and then, in peekLock mode, completes the message unless
   * the handler already settled it or `autoCompleteMessages` is false. A
   * handler error rejects, and the SDK abandons the message.
   */
  private async processMessage(
    receivedMessage: ServiceBusReceivedMessage,
    pattern: string
  ): Promise<void> {
    await this.handleMessage(receivedMessage, pattern);

    const active = this.receivers.get(pattern);
    if (!active?.autoComplete || active.receiver.receiveMode !== "peekLock") {
      return;
    }
    // Same check the SDK's own auto-completion uses.
    const delivery = (receivedMessage as { delivery?: { remote_settled?: boolean } })
      .delivery;
    if (delivery?.remote_settled) {
      return;
    }
    try {
      await active.receiver.completeMessage(receivedMessage);
    } catch (err) {
      // As with the SDK's auto-completion: report it, the lock will expire
      // and the message will be redelivered.
      this.logger.error(
        `Could not complete message ${receivedMessage.messageId} on "${active.receiver.entityPath}": ${
          (err as Error)?.message ?? err
        }`,
        (err as Error)?.stack
      );
    }
  }

  public async handleMessage(
    receivedMessage: ServiceBusReceivedMessage,
    pattern: string
  ): Promise<void> {
    const partialPacket = { data: receivedMessage, pattern };
    const packet = await this.deserializer.deserialize(partialPacket);
    const receiver = this.receivers.get(pattern)?.receiver;
    const sbContext = new AzureServiceBusContext([receiver, receivedMessage]);

    if (!receivedMessage.replyTo) {
      return this.handleEvent(packet.pattern, packet, sbContext);
    }

    const handler = this.getHandlerByPattern(pattern);
    const response$ = this.transformToObservable(
      await handler(receivedMessage, sbContext)
    );
    if (response$) {
      await this.sendReply(
        response$,
        receivedMessage.replyTo,
        receivedMessage.messageId as string
      );
    }
  }

  public getPublisher(replyTo: string, correlationId: string) {
    return async (data: WritePacket) => {
      const sender = this.sbClient.createSender(replyTo);
      const responseMessage = {
        correlationId,
        body: data.response,
      } as ServiceBusMessage;
      try {
        await sender.sendMessages([responseMessage]);
      } finally {
        await sender.close();
      }
    };
  }

  createServiceBusClient(): ServiceBusClient {
    const { connectionString, options } = this.options;
    return new ServiceBusClient(connectionString, options);
  }

  /**
   * Returns the underlying `ServiceBusClient` (NestJS 11+ API).
   */
  unwrap<T = ServiceBusClient>(): T {
    if (!this.sbClient) {
      throw new Error(
        'Not initialized. Please call the "listen"/"startAllMicroservices" method before accessing the server.'
      );
    }
    return this.sbClient as T;
  }

  /**
   * Status/event listeners (NestJS 11+ API) are not supported by this transport.
   */
  on(_event: string, _callback: unknown): never {
    throw new Error("Method not implemented.");
  }

  /**
   * Stops receiving, waits for the messages being handled, then closes the
   * receivers and the client. Calls made while closing share the same work.
   */
  async close(): Promise<void> {
    if (!this.closing) {
      this.closing = this.closeAll().finally(() => {
        this.closing = undefined;
      });
    }
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    // The map is kept until the end: messages still in flight need their
    // receiver to be settled.
    const active = [...this.receivers.values()];

    // 1. No new messages, and no more reconnect attempts. The links stay
    //    open, so the messages being handled can still be settled.
    for (const { abortController } of active) {
      abortController.abort();
    }
    await Promise.all(active.map(({ subscription }) => settled(subscription.close())));

    // 2. Let the handlers in flight finish (a drain can still deliver one).
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight].map(settled));
    }

    // 3. Close the links, then the connection.
    const failures = (
      await Promise.all(active.map(({ receiver }) => settled(receiver.close())))
    ).filter((err) => err !== undefined);
    for (const err of failures) {
      this.logger.error(`Could not close an Azure Service Bus receiver: ${err}`);
    }
    this.receivers.clear();

    const client = this.sbClient;
    this.sbClient = undefined;
    await client?.close();
  }

  private track(work: Promise<void>): Promise<void> {
    this.inFlight.add(work);
    const forget = () => {
      this.inFlight.delete(work);
    };
    work.then(forget, forget);
    // The SDK gets the original promise: a rejection abandons the message.
    return work;
  }

  /**
   * Publishes the handler's response and resolves once it has been sent, so
   * the message is not settled (nor the server closed) before the reply leaves.
   */
  private async sendReply(
    response$: Observable<unknown>,
    replyTo: string,
    correlationId: string
  ): Promise<void> {
    const publish = this.getPublisher(replyTo, correlationId);
    let publishing: Promise<void> = Promise.resolve();
    const respond = (packet: WritePacket): Promise<void> => {
      publishing = publishing
        .then(() => publish(packet))
        .catch((err) =>
          // Nothing else can be done with a reply that cannot be sent, and
          // rethrowing would be an unhandled rejection inside Nest.
          this.logger.error(
            `Could not send the reply to "${replyTo}": ${err?.message ?? err}`,
            err?.stack
          )
        );
      return publishing;
    };

    await new Promise<void>((resolve) => {
      this.send(response$.pipe(finalize(() => resolve())), respond);
    });
    // Nest hands the last packet to `respond` on a later tick: wait for every
    // publish it starts.
    let last: Promise<void>;
    do {
      await new Promise((resolve) => setImmediate(resolve));
      last = publishing;
      await last;
    } while (last !== publishing);
  }

  private parsePattern(pattern: string): SubscriberPattern {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pattern);
    } catch (err) {
      throw new Error(
        `Cannot read the Azure Service Bus options of the handler pattern ${pattern}: ${err}. ` +
          "Handlers on this transport must use @Subscription() or @Queue() with plain JSON values."
      );
    }
    const metaOptions = (parsed as SubscriberPattern | null)?.metaOptions;
    if (typeof metaOptions !== "object" || metaOptions === null) {
      throw new Error(
        `The handler pattern ${pattern} has no Azure Service Bus options. ` +
          "Handlers on this transport must use @Subscription() or @Queue()."
      );
    }
    return parsed as SubscriberPattern;
  }

  private createReceiver(
    meta: SubscriberPattern["metaOptions"],
    pattern: string
  ): ServiceBusReceiver {
    const receiverOptions: ServiceBusReceiverOptions = {
      receiveMode: meta.receiveMode,
      subQueueType: meta.subQueueType,
      skipParsingBodyAsJson: meta.skipParsingBodyAsJson,
    };
    const isName = (value: unknown): value is string =>
      typeof value === "string" && value.length > 0;

    // The SDK tells the overloads apart by the type of the second argument:
    // only a string is a subscription name; anything else (null included) is
    // read as the options object.
    if (isName(meta.queueName)) {
      return this.sbClient.createReceiver(meta.queueName, receiverOptions);
    }
    if (isName(meta.topic) && isName(meta.subscription)) {
      return this.sbClient.createReceiver(meta.topic, meta.subscription, receiverOptions);
    }
    if (isName(meta.topic) && meta.subscription == null) {
      // @Subscription without a subscription name has always ended up reading
      // the `topic` entity as a queue; keep that, now with its options.
      return this.sbClient.createReceiver(meta.topic, receiverOptions);
    }
    throw new Error(
      `The handler pattern ${pattern} needs a "queueName", or a "topic" and a "subscription".`
    );
  }
}
