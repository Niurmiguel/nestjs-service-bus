<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

  <p align="center"><a href="https://nestjs.com" target="_blank">NestJs</a> custom transport for <a href="https://docs.microsoft.com/en-us/azure/service-bus-messaging/service-bus-messaging-overview" target="_blank">Azure Service Bus</a>.</p>
    <p align="center">
<a href="https://www.npmjs.com/package/@niur/nestjs-service-bus" target="_blank"><img src="https://img.shields.io/npm/v/@niur/nestjs-service-bus.svg" alt="NPM Version" /></a>
<a href="https://github.com/Niurmiguel/nestjs-service-bus/blob/master/LICENSE" target="_blank"><img src="https://img.shields.io/npm/l/@niur/nestjs-service-bus.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/package/@niur/nestjs-service-bus" target="_blank"><img src="https://img.shields.io/npm/dm/@niur/nestjs-service-bus.svg" alt="NPM Downloads" /></a>
<a href="https://github.com/Niurmiguel/nestjs-service-bus/actions/workflows/ci.yml" target="_blank"><img src="https://github.com/Niurmiguel/nestjs-service-bus/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
</p>

## Description

<a href="https://azure.microsoft.com/en-us/services/service-bus/#overview" target="_blank">Azure Service Bus</a> is a fully managed enterprise message broker with message queues and publish-subscribe topics (in a namespace). Service Bus is used to decouple applications and services from each other, providing the following benefits:

- Load-balancing work across competing workers
- Safely routing and transferring data and control across service and application boundaries
- Coordinating transactional work that requires a high-degree of reliability

#### Installation

To start building Azure Service Bus-based microservices, first install the required packages:

```bash
$ npm i --save @azure/service-bus @niur/nestjs-service-bus
```

`@azure/service-bus` (7.9.0 or later), NestJS 10 or 11, `reflect-metadata` and `rxjs` are peer dependencies: the application provides them.
#### Overview

To use the Azure Service Bus strategy, pass the following options object to the `createMicroservice()` method:

```typescript
//  main.ts

const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
  strategy: new AzureServiceBusServer({
    connectionString: 'Endpoint=sb://<Name>.servicebus.windows.net/;SharedAccessKeyName=<SharedAccessKeyName>;SharedAccessKey=<SharedAccessKey>',
    options: {}
  }),
});

```
#### Options

`options` is the SDK's `ServiceBusClientOptions`; among its properties:

<table>
  <tr>
    <td><code>retryOptions</code></td>
    <td>Retry policy options that determine the mode, number of retries, retry interval etc (read more <a href="https://docs.microsoft.com/en-us/javascript/api/@azure/service-bus/servicebusclientoptions?view=azure-node-latest#@azure-service-bus-servicebusclientoptions-retryoptions" rel="nofollow" target="_blank">here</a>).</td>
  </tr>
  <tr>
    <td><code>webSocketOptions</code></td>
    <td>Options to configure the channelling of the AMQP connection over Web Sockets (read more <a href="https://docs.microsoft.com/en-us/javascript/api/@azure/service-bus/servicebusclientoptions?view=azure-node-latest#@azure-service-bus-servicebusclientoptions-websocketoptions" rel="nofollow" target="_blank">here</a>).</td>
  </tr>
  <tr>
    <td><code>userAgentOptions</code></td>
    <td>Options for adding user agent details to outgoing requests (read more <a href="https://docs.microsoft.com/en-us/javascript/api/@azure/service-bus/servicebusclientoptions?view=azure-node-latest#@azure-service-bus-servicebusclientoptions-useragentoptions" rel="nofollow" target="_blank">here</a>).</td>
  </tr>
</table>

The server (`new AzureServiceBusServer({...})`) also accepts:

<table>
  <tr>
    <td><code>allowedReplyTo</code></td>
    <td>Where the server may send the replies of request-response: a list of entity names (compared ignoring case), or a function <code>(replyTo, message) =&gt; boolean</code>. A request whose <code>replyTo</code> is not allowed gets no reply and its handler does not run; in <code>peekLock</code> mode it is dead-lettered with the reason <code>ReplyToNotAllowed</code>, and a warning is logged. Not set by default: any <code>replyTo</code> is answered. See <a href="#security">Security</a>.</td>
  </tr>
  <tr>
    <td><code>closeTimeoutInMs</code></td>
    <td>How long <code>close()</code> waits for the handlers that are running and the streamed responses they are still sending. <code>25000</code> (25 seconds) by default; <code>Infinity</code> waits for as long as they take. See <a href="#shutdown">Shutdown</a>.</td>
  </tr>
  <tr>
    <td><code>replyTimeToLiveInMs</code></td>
    <td>Time to live of the reply messages, so that a reply nobody receives does not stay in the reply queue. Not set by default (the reply queue's default message time to live applies). At least <code>1</code>; a smaller value throws a <code>RangeError</code> when the server is created. The SDK caps it at 2<sup>32</sup> - 1 ms (about 49.7 days), and Service Bus at the reply queue's default message time to live. Make it longer than the clients' <code>replyTimeoutInMs</code>.</td>
  </tr>
</table>

```typescript
new AzureServiceBusServer({
  connectionString: process.env.SERVICE_BUS_CONNECTION_STRING!,
  allowedReplyTo: ['orders.reply'],
  closeTimeoutInMs: 20_000,
  replyTimeToLiveInMs: 5 * 60_000,
});
```

#### Client

```typescript
@Module({
  imports: [
    AzureServiceBusModule.forRoot([
      {
        name: 'SB_CLIENT',
        connectionString: 'Endpoint=sb://<Name>.servicebus.windows.net/;SharedAccessKeyName=<SharedAccessKeyName>;SharedAccessKey=<SharedAccessKey>',
        options: {},
      },
    ]),
  ]
  ...
})

// or

@Module({
  imports: [
    AzureServiceBusModule.forRootAsync([
      {
        name: 'SB_CLIENT',
        useFactory: (configService: ConfigService) => ({
          connectionString: configService.getOrThrow<string>('connectionString'),
          options: {}
        }),
        inject: [ConfigService],
      },
    ]),
  ]
  ...
})

```

```typescript

@Injectable()
constructor(
  @Inject('SB_CLIENT') private readonly sbClient: AzureServiceBusClientProxy,
) {}

```

##### Client options

Besides `connectionString` and `options`, each client (an entry of `forRoot()`/`forRootAsync()`, or `new AzureServiceBusClient({...})`) accepts:

<table>
  <tr>
    <td><code>replyTimeoutInMs</code></td>
    <td>How long a <code>send()</code> waits for its reply to complete before its Observable fails with a <code>ReplyTimeoutError</code>. From <code>0</code> to <code>2147483647</code> (<code>0</code> and <code>Infinity</code> mean no limit); another value throws a <code>RangeError</code>. Not set by default: <code>send()</code> waits indefinitely. <strong>Recommended</strong>: without it, a request nobody answers (no server running, a server that crashed, a reply that was lost) keeps its caller waiting forever.</td>
  </tr>
  <tr>
    <td><code>replySessions</code></td>
    <td>Receive the replies in a session of this client's own. Use it when several clients (e.g. several replicas of a service) send requests to the same entity: see <a href="#request-response">Request-response</a>. Default <code>false</code>.</td>
  </tr>
</table>

##### Producer

Message-based (request-response)

```typescript

const pattern = {
  name: 'sample-queue', // queue or topic name
  options: {}, // passed to sendMessages(), e.g. { abortSignal }
};
const data = {
  body: 'Example message'
};

this.sbClient.send(pattern, data).subscribe((response) => {
  console.log(response); // reply message
});

```

Event-based

```typescript

const pattern = {
  name: 'sample-topic', // queue or topic name
  options: {}
};
const data = {
  body: 'Example message'
};
this.sbClient.emit(pattern, data);
```

`emit()` sends right away. If nobody subscribes to the Observable it returns, a failed send is logged.

##### Request-response

`send()` sends the request to `name` and waits for the reply on the queue `<name>.reply`, which must exist. The client matches each reply to its request by `correlationId` (a random UUID per request), so concurrent `send()` calls each get their own reply.

- The server sends each value of the handler's response as soon as it is emitted. Values emitted together, and the end of the response when it comes right after the last of them, travel together: a handler that returns one value sends one message. A response that ends later sends its end as a message of its own.
- The request message is completed once its first reply is sent; the rest of a streamed response goes on in the background (`close()` of the server waits for it, up to `closeTimeoutInMs`, and then cancels it).
- If a reply cannot be sent, the server logs it at once, unsubscribes the response and sends the client an error reply instead of the rest (Nest's generic `{ status: 'error', message: 'Internal server error' }`). If that error reply cannot be sent either, the client gets nothing more: only its `replyTimeoutInMs` ends the wait.
- If the handler fails, the Observable fails with the error Nest's exception filter makes of it, as in Nest's other transports: `{ status: 'error', message: 'Internal server error' }` for an unknown error, or the payload of an `RpcException`.
- If the request cannot be sent (e.g. the entity does not exist), or the reply queue cannot be received from (it does not exist, or its sessions setting does not match `replySessions`), the Observable fails.
- `close()` waits for the sends in flight and fails the `send()` calls still waiting for a reply.
- Set `replyTimeToLiveInMs` on the server and `replyTimeoutInMs` on the client (see the options above), so that neither a reply nobody waits for nor a request nobody answers stays around for ever.

When several clients send to the same entity they share `<name>.reply`. Without sessions, a client that receives a reply to a request it did not send abandons it, so that Service Bus delivers it again, possibly to the client it belongs to; a reply can bounce several times, and after the queue's max delivery count it is dead-lettered. (A reply whose `correlationId` is not a request id at all is dead-lettered at once, with the reason `InvalidCorrelationId`.) The warning about those replies is logged at most once a minute.

For several clients, use sessions: each client then receives only the replies sent to its own session.

1. The reply queue must have sessions enabled. **Sessions cannot be turned on for an existing queue** ([Azure docs](https://learn.microsoft.com/azure/service-bus-messaging/enable-message-sessions)): delete `<name>.reply` and create it again with sessions, which loses the replies in it. The Basic tier has no sessions.
2. Set `replySessions: true` on every client of that entity. A client without it fails its `send()` calls on a queue with sessions, and one with it fails them on a queue without (with an error that says so).
3. The servers must run 1.2.0 or later (they send the reply to the session the request names).

While the reply queue is being replaced, set `replyTimeoutInMs` on the clients, so that a request whose reply is lost fails instead of waiting forever.

Clients before 1.2.0 take the first message on their reply queue as the whole response, whatever its `correlationId`. A 1.2.0 server therefore sends them a single reply (the first value, the error or the end of an empty response) and nothing more, so that no later request of theirs gets it as an answer; the handler's Observable is unsubscribed after that reply. Upgrade the clients to get streamed responses and errors.

##### Consumer

To access the original Azure Service Bus message use the `Subscription` decorator as follows:


```typescript

@Subscription({
    topic: 'sample-topic',
    subscription: 'sample-subscription',
    receiveMode: 'peekLock', // or receiveAndDelete
  })
getMessages(@Payload() message: ServiceBusMessage) {
  console.log(message);
}
```

Options

<table>
  <tr>
    <td><code>topic</code></td>
    <td>Name of the topic for the subscription we want to receive from.</td>
  </tr>
  <tr>
    <td><code>subscription</code></td>
    <td>Name of the subscription (under the `topic`) that we want to receive from.</td>
  </tr>
  <tr>
    <td><code>receiveMode</code></td>
    <td>Represents the receive mode for the receiver. (read more <a href="https://docs.microsoft.com/azure/service-bus-messaging/message-transfers-locks-settlement#peeklock" rel="nofollow" target="_blank">here</a>).</td>
  </tr>
  <tr>
    <td><code>subQueueType</code></td>
    <td>Represents the sub queue that is applicable for any queue or subscription. (read more <a href="https://docs.microsoft.com/azure/service-bus-messaging/service-bus-dead-letter-queues" rel="nofollow" target="_blank">here</a>).</td>
  </tr>
  <tr>
    <td><code>maxAutoLockRenewalDurationInMs</code></td>
    <td>The maximum duration in milliseconds until which the lock on the message will be renewed by the sdk automatically.</td>
  </tr>
  <tr>
    <td><code>skipParsingBodyAsJson</code></td>
    <td>Option to disable the client from running JSON.parse() on the message body when receiving the message.</td>
  </tr>
  <tr>
    <td><code>options</code></td>
    <td>Options used when subscribing to a Service Bus queue or subscription.</td>
  </tr>
</table>



##### Queue consumer

To receive from a queue use the `Queue` decorator. It takes the same options as `Subscription`, with `queueName` instead of `topic` and `subscription`:

```typescript
@Queue({
    queueName: 'sample-queue',
    receiveMode: 'receiveAndDelete', // or peekLock
  })
getJobs(@Payload() message: ServiceBusReceivedMessage) {
  console.log(message);
}
```

##### Settling messages yourself (peekLock)

In `peekLock` mode a message is completed when the handler returns. To settle it yourself, turn that off with `options.autoCompleteMessages: false` and use the receiver from the context:

```typescript
@Subscription({
    topic: 'sample-topic',
    subscription: 'sample-subscription',
    receiveMode: 'peekLock',
    options: { autoCompleteMessages: false },
  })
async getMessages(
  @Payload() message: ServiceBusReceivedMessage,
  @Ctx() context: AzureServiceBusContext,
) {
  const receiver = context.getReceiver();
  try {
    await handle(message);
    await receiver.completeMessage(message);
  } catch {
    await receiver.abandonMessage(message); // or deadLetterMessage / deferMessage
  }
}
```

`context.getMessage()` returns the same message the handler gets as payload.

If the handler throws (or returns an Observable that errors) and has not settled the message, the message is abandoned: Service Bus delivers it again, and after the entity's max delivery count moves it to the dead-letter queue. In `receiveAndDelete` mode the message is already gone, so the error is only logged. A handler that returns an Observable has its message completed when that Observable completes.

While a handler runs in `peekLock` mode, the SDK renews the message's lock for up to `maxAutoLockRenewalDurationInMs` (5 minutes by default; `0` turns renewal off). A handler that outlasts the lock without renewal loses it: the message cannot be completed and is delivered again.

##### Shutdown

Closing the application (`app.close()`) stops receiving new messages, waits for the handlers that are running to finish (and for their messages to be completed), and then closes the receivers and the connection.

It waits for up to `closeTimeoutInMs` (25 seconds by default), including the rest of the streamed responses being sent. When that runs out, the Observables of the handlers still running are unsubscribed, a warning is logged, and the receivers and the connection are closed anyway:

- A handler still running has its message left unsettled: in `peekLock` mode Service Bus delivers it again once its lock expires (in `receiveAndDelete` mode it is gone).
- A streamed response whose request already had its first reply (so its message was completed) just stops: its client gets no further replies and, with `replyTimeoutInMs` set, fails after it.

The default leaves a few seconds before Kubernetes' default `terminationGracePeriodSeconds` (30 seconds) for the rest of the shutdown. Keep it shorter than the time your platform gives a process to stop, or set `Infinity` to wait for as long as the handlers take.

## Security

**Give each side only the rights it needs.** With shared access policies (SAS) defined on each entity, or with the Microsoft Entra roles *Azure Service Bus Data Sender* / *Data Receiver* scoped to each entity:

| Who | Send | Listen |
| --- | --- | --- |
| Clients (`send()`) | the request entity | their reply queue `<entity>.reply` |
| Clients (`emit()`) | the entity | — |
| Servers that answer requests | `<entity>.reply` only | the request queue or subscription |
| Servers that only handle events | — | the queue or subscription |

Avoid a namespace-wide policy such as `RootManageSharedAccessKey` (it also grants *Manage*) in applications.

**The server replies where the request says.** A request names its reply queue (`replyTo`) and session. Anyone who can send to a request entity can make the server send a handler's response to any entity the server can send to, with a `correlationId` of their choosing. Limit the server's Send rights to the reply queues, and set `allowedReplyTo` to the reply queues it should answer.

**Replies are not authenticated.** A client accepts, as the reply to a request, the first message on its reply queue whose `correlationId` is that request's id. Anyone who can send to the reply queue and who learns a request id (anyone who can read or peek the request entity) can answer in the server's place. Keep Send on reply queues to the servers, and Listen on request entities to the servers. If a reply must be trusted beyond that, sign it in the application.

**Logs.** Values taken from messages (`correlationId`, `replyTo`, `messageId`) are logged quoted, so they cannot fake log lines. `util.inspect()` (and `console.log()`) of a client or a server shows the connection string with its key replaced by `<redacted>`.

Report vulnerabilities as explained in [SECURITY.md](https://github.com/Niurmiguel/nestjs-service-bus/blob/master/SECURITY.md).

## Tests

`npm test` runs the unit tests, with no Azure connection.

`npm run test:integration` runs a NestJS microservice with this transport against the [Azure Service Bus emulator](https://learn.microsoft.com/azure/service-bus-messaging/overview-emulator), and skips itself when the emulator is not reachable. `test/integration/docker-compose.yml` explains how to start it; doing so requires accepting Microsoft's license terms for the emulator and for SQL Server.

## Stay in touch

* Author - [Niurmiguel](https://github.com/Niurmiguel)

## License
Nestjs Azure Service Bus is [MIT licensed](LICENSE).