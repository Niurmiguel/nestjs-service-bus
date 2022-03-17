<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center"><a href="https://nestjs.com" target="_blank">NestJs</a> custom transport for <a href="https://docs.microsoft.com/en-us/azure/service-bus-messaging/service-bus-messaging-overview" target="_blank">Azure Service Bus</a>.</p>
    <p align="center">
<a href="https://www.npmjs.com/~niur" target="_blank"><img src="https://img.shields.io/npm/v/@niur/nestjs-service-bus.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~niur" target="_blank"><img src="https://img.shields.io/npm/l/@niur/nestjs-service-bus.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~niur" target="_blank"><img src="https://img.shields.io/npm/dm/@niur/nestjs-service-bus.svg" alt="NPM Downloads" /></a>
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

The <strong>Azure Service Bus</strong> strategy exposes the properties described below.

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
          connectionString: configService.get('connectionString'),
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

##### Producer

Event-based

```typescript

const pattern = {
  name: 'sample-topic', // topic name
  options: {}
}; // queue name
const data = {
  body: 'Example message'
};

this.sbClient.send(pattern, data).subscribe((response) => {
  console.log(response); // reply message
});

```

Message-based

```typescript

const pattern = {
  name: 'sample-topic', // topic name
  options: {}
}; // queue name
const data = {
  body: 'Example message'
};
this.sbClient.emit(pattern, data);
```


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



## Stay in touch

* Author - [Niurmiguel](https://github.com/Niurmiguel)

## License
Nestjs Azure Service Bus is [MIT licensed](LICENSE).