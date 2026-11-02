# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] - 2026-11-02

### Added

- Support for NestJS 11 (`unwrap()`, `on()`), alongside NestJS 10 (10.0.4 or later).
- `@Queue({ queueName, ... })` to receive from a queue, with the same receiver
  options as `@Subscription`.
- `AzureServiceBusContext.getReceiver()` and `getMessage()`, to settle a
  `peekLock` message yourself (complete, abandon, defer, dead-letter).
- Client option `replyTimeoutInMs`: a `send()` whose reply has not completed in
  time fails with the new, exported `ReplyTimeoutError`. Not set by default
  (recommended).
- Client option `replySessions`: each client receives its replies in a session
  of its own, for several clients (e.g. replicas) sending to the same entity.
- Server option `allowedReplyTo` (a list of entity names or a function): a
  request whose `replyTo` is not allowed gets no reply, its handler does not
  run, and in `peekLock` mode it is dead-lettered (`ReplyToNotAllowed`). Not
  set by default.
- Server option `closeTimeoutInMs`: how long `close()` waits for the handlers
  that are running (25 seconds by default; see "Behavior changes").
- Server option `replyTimeToLiveInMs`: time to live of the reply messages, at
  least 1 ms (a smaller value throws a `RangeError`). Not set by default.
- Exported from the package root: the errors (`ReplyTimeoutError`,
  `InvalidMessageException`), the option and metadata interfaces
  (`AzureServiceBusOptions`, `AzureServiceBusClientOptions`,
  `AzureServiceBusServerOptions`, `AzureServiceBusSenderOptions`,
  `AllowedReplyTo`, `SbQueueMetadataOptions`, `SbSubscriptionMetadataOptions`,
  `SbReceiverMetadataOptions`, `SbSubscriberTypeMap`, the module option
  types...), `SbSubscriberMetadata`, `AzureServiceBusContextArgs`, and the
  `SendableMessages` / `SendableRequest` data types.
- Unit tests (`npm test`, which also compiles a strict consumer of the
  typings) and integration tests against the Azure Service Bus emulator
  (`npm run test:integration`), run in CI with NestJS 10 and 11 and with the
  lowest and latest supported `@azure/service-bus`.

### Changed

- `@azure/service-bus` is now a peer dependency, `^7.9.0`. It was always
  required at run time but was only a devDependency.
- Peer ranges: `@nestjs/*` `^10.0.4 || ^11.0.0`, `reflect-metadata`
  `^0.1.13 || ^0.2.0`.
- The package only contains `dist/`, `lib/` (the sources the source maps point
  to), the README, the license and this changelog. 1.1.0 also shipped
  `.github/` (CI workflows, issue templates, Dependabot), `.nvmrc`,
  `tsconfig.json` and `SECURITY.md`.
- Replies of request-response carry application properties
  (`nestjs-sb-reply-type`, `nestjs-sb-is-disposed`), and requests carry
  `nestjs-sb-request-id`; see "Behavior changes".
- Request ids (the `correlationId` of the replies) are random UUIDs
  (`crypto.randomUUID()`) whatever the NestJS version. NestJS 10, and 11 before
  11.2.8, derive them from `Math.random()`, and each one gives away most of the
  next.
- A handler's response is sent as one reply per value, each as soon as it is
  emitted. Values emitted together, and the end of the response when it comes
  in the same tick as the last of them, travel together: one message for a
  single value. An end that comes later is a reply of its own.
- An event handler that returns an Observable has its message completed when
  that Observable completes, not when the handler returns it.
- Logged values that come from messages (`correlationId`, `replyTo`,
  `messageId`) are JSON-quoted and cut to 200 characters.

### Changed (typings)

These compile differently against 1.1.0 code:

- `SubscriberMetadataForTarget[number].metadata.metaOptions` is now
  `SbSubscriptionMetadataOptions | SbQueueMetadataOptions` (because of
  `@Queue`): reading `.topic` needs a check of `metadata.type` first.
- `AzureServiceBusClientProxy` (and so `AzureServiceBusClient`) has a
  `protected readonly logger` (a NestJS `Logger`). A subclass that declares
  its own `logger` of another type, or `private`, no longer compiles: rename
  it, or make it a `Logger`.
- `new AzureServiceBusContext([]).getArgs()` is now typed
  `AzureServiceBusContextArgs` (`[ServiceBusReceiver?,
  ServiceBusReceivedMessage?]`), not `[]`.
- `send()` no longer accepts a `ServiceBusMessageBatch` (its messages are
  already encoded, so the reply queue cannot be added; it threw a `TypeError`
  at run time). `emit()` still does.
- The server's constructor takes `AzureServiceBusServerOptions`, which extends
  `AzureServiceBusOptions`: 1.1.0 options still compile, but a subclass that
  redeclares `options` with the old type does not.

### Removed

- `AzureServiceBusClient.createMessageHandlers()` and `handleMessage()`. They
  were public but undocumented internals of the old reply handling.

### Fixed

- Server: receivers were closed right after subscribing. With an AMQP
  connection already open nothing was received; otherwise messages could not
  be settled. Receivers now stay open while listening, and `close()` stops
  receiving, waits for the handlers in flight, settles their messages and then
  closes the receivers and the connection.
- Server: `receiveMode`, `subQueueType` and `skipParsingBodyAsJson` could be
  dropped for a `@Subscription` without `subscription`; they now always reach
  the SDK.
- Server: `maxAutoLockRenewalDurationInMs` was never passed to the receiver;
  `0` did not turn lock renewal off and other values were ignored.
- Server: when an event handler threw, the message was completed and the
  failure lost. In `peekLock` mode it is now abandoned (unless the handler
  settled it), so Service Bus delivers it again.
- Server: when a request handler threw (an `RpcException` or any other error),
  the reply had no body: the client got `null` as a successful response
  (checked against the emulator with NestJS 10 and 11, with 1.1.0 and 1.2.0
  clients). The client now gets the error (see "Behavior changes").
- Server: the last value of a streamed response was held back until the next
  one or the end: a response that emitted a value and did not complete never
  answered, and progress updates arrived one step late.
- Server: a response that never completed kept its request message, and with
  the default `maxConcurrentCalls` (1) the whole receiver, busy for ever. The
  request is now completed once its first reply is sent.
- Server: receiver errors were never logged and `processError` never resolved.
- Client: with concurrent `send()` calls to the same entity, a client could get
  another request's reply, and that reply was lost for its own request.
  Replies are now matched to their request by `correlationId`.
- Client: a `send()` to an entity that does not exist ended the process with an
  unhandled rejection, and after `close()` a send kept the process alive for
  about 90 seconds and then crashed it. Send errors now fail the Observable,
  senders and receivers are closed in order, and `close()` waits for the sends
  in flight.
- Client: a `send()` whose reply queue does not exist, or cannot be received
  from (e.g. it has sessions and `replySessions` is off), waited forever while
  the SDK retried; it now fails. Reply receiver errors are logged (they were
  thrown inside a promise nobody awaited).
- Client: send options went through `JSON.stringify`/`JSON.parse`: an
  `abortSignal` arrived as `{}` and an option set to `undefined` broke the
  send. They are now passed as given.
- Client: an `emit()` with no subscriber lost its error; it is now logged.
- Typings: the `.d.ts` files imported `@azure/core-amqp`, which is not a
  dependency; with pnpm (or any non-hoisted layout) and `skipLibCheck: false`
  the build failed with "Cannot find module '@azure/core-amqp'".
- `npm publish` built the package only because CI ran `npm ci` first: the build
  now runs on `prepack` instead of the deprecated `prepublish`.

### Security

- Request ids are random UUIDs (see "Changed"): with NestJS 10 they were
  predictable, so a reply could be forged for a request not yet sent.
- `allowedReplyTo` lets a server answer only its reply queues, and the README
  documents the least-privilege rights of clients and servers, and that
  replies are not authenticated.
- `util.inspect()` (and `console.log()`) of a client or a server no longer
  shows the connection string's `SharedAccessKey`.
- Values from messages are quoted in the logs, so a `correlationId` or a
  `replyTo` with line breaks cannot fake log lines.
- A reply whose `correlationId` is not a request id is dead-lettered at once
  instead of bouncing between clients, and the warning about replies that are
  not the client's is logged at most once a minute.
- The package no longer publishes its CI workflows and configuration files
  (`.github/`, `.nvmrc`, `tsconfig.json`).
- Releases are published from CI with npm provenance (`--provenance`): one job
  builds and tests the package with dependency install scripts disabled, and a
  separate job, the only one with the npm token and the OIDC token, publishes
  that tarball. GitHub Actions are pinned to commit SHAs, with read-only
  default permissions and no persisted checkout credentials.
- An error that reaches the transport without going through Nest's exception
  filter is logged on the server and replied as Nest's generic
  `{ status: "error", message: "Internal server error" }`, so no stack or
  internal message reaches the client.
- Development dependencies updated and `rimraf` removed: `npm audit` reports no
  advisories for the repository's dependency tree.
- NestJS 10 has advisories fixed only in 11.x (`@nestjs/core` <= 11.1.17,
  `@nestjs/microservices` <= 11.2.4; several affect only the TCP transport).
  NestJS 10 is still supported here, but prefer the latest NestJS 11.

### Behavior changes

Read these before upgrading a service that relies on the 1.1.0 behavior.

- **Failed event handlers (`peekLock`)**: the message is abandoned instead of
  completed. It is delivered again and, after the entity's max delivery count,
  moved to the dead-letter queue. Make handlers idempotent, or catch the errors
  you want to swallow. `receiveAndDelete` is unchanged (the error is logged).
- **Failed request handlers**: with 1.1.0 servers the client got `null` as a
  successful response. Now (1.2.0 server and client) the `send()` Observable
  fails with the error: Nest's `{ status: "error", message: "Internal server
  error" }` for an unknown error, or the payload of an `RpcException`. The
  request message is completed once the error reply is sent (it is not
  delivered again).
- **Streamed responses**: each value is sent when it is emitted, and the
  request message is completed once the first reply is sent; the rest of the
  response is sent in the background, and `close()` waits for it. When a reply
  cannot be sent, the response is unsubscribed and a 1.2.0 client gets an
  error reply instead of the rest (if that one cannot be sent either, only the
  client's `replyTimeoutInMs` ends its wait).
- **`close()` of the server** waits for the handlers that are running and the
  streamed responses they are still sending, for up to `closeTimeoutInMs` (25
  seconds by default, under Kubernetes' default 30-second grace period). 1.1.0
  did not wait at all. After the time limit the Observables of the handlers
  still running are unsubscribed and the receivers are closed anyway: in
  `peekLock` mode the messages of the handlers still running are delivered
  again once their lock expires, while a streamed response whose request was
  already completed just ends (its client gets no further replies). Set
  `closeTimeoutInMs: Infinity` to wait for as long as the handlers take.
- **Replies that are not the client's**: a client that receives a reply to a
  request it did not send abandons it (1.1.0 consumed it, and handed it to the
  wrong caller). With several clients on one reply queue, replies can bounce and
  end in the dead-letter queue: use `replySessions`. A reply whose
  `correlationId` is not a request id is dead-lettered at once.
- **`close()` of the client** waits for the sends in flight, and fails the
  `send()` calls still waiting for a reply with an error. After `close()`, a new
  `send()`/`emit()` connects again.
- **`replyTimeoutInMs`** out of range (negative, `NaN`, not a number, or more
  than 2147483647) throws a `RangeError` when the client is created. Before, a
  value above 2147483647 (or `Infinity`) made every `send()` time out at once,
  and a negative one was ignored. `Infinity` now means no limit, like `0`.
- **`maxAutoLockRenewalDurationInMs`** now takes effect. If you set it to `0`,
  locks are no longer renewed and a handler that outlasts the entity's lock
  duration loses the lock (the message is delivered again).
- **Event handlers that return an Observable**: the message is settled when the
  Observable completes. One that never completes keeps its message locked.
- **Peer dependency**: npm 7+ and pnpm now check that `@azure/service-bus`
  7.9.0 or later is installed.
- **Mixed versions** (checked against the emulator, NestJS 10 and 11):
  - 1.2.0 server, 1.1.0 client: single values work as before. A 1.1.0 client
    takes the first message on its reply queue as the whole response, whatever
    its `correlationId`, so the server sends it exactly one reply: the first
    value of a stream, or the error, which that client receives as a regular
    value (`{ status: "error", ... }`) instead of 1.1.0's `null`. 1.1.0 servers
    sent every value of a stream, and the extra ones reached later requests of
    that client as their answers.
  - 1.1.0 server, 1.2.0 client: single values work. The first reply is taken
    as the whole response (later values of a stream are dropped), and a failed
    handler still arrives as a successful `null`: those servers send no error.
    A caller that sets its own `messageId` on `send()` gets no reply (that
    server replies to the `messageId`, not to the request id).
  - 1.1.0 and 1.2.0 clients must not share a reply queue (`<entity>.reply`):
    a 1.1.0 client takes any message there as its answer, including the
    replies meant for 1.2.0 clients, and a 1.2.0 client dead-letters at once
    (`InvalidCorrelationId`) the replies whose `correlationId` does not have
    the shape of a request id, such as a reply to a 1.1.0 client that set its
    own `messageId`. Upgrade all the clients of an entity together, or give
    them separate entities while you do.
  - `replySessions` needs 1.2.0 servers.

### Upgrading from 1.1.0

1. Make sure `@azure/service-bus` 7.9.0 or later is a dependency of your
   application.
2. Upgrade the servers (microservices) first, then the clients. Only a 1.2.0
   server and a 1.2.0 client report a failed handler as an error and stream
   responses.
3. Review the event handlers that use `peekLock` and can throw: their messages
   are now redelivered and eventually dead-lettered. Check the entity's max
   delivery count and that the handlers are idempotent.
4. If you relied on getting `null` from `send()` when the handler failed,
   handle the error of the Observable now. Set `replyTimeoutInMs` on the
   clients, so that a request nobody answers does not wait forever.
5. If handlers (or streamed responses) can run longer than 25 seconds, review
   `closeTimeoutInMs` (and the time your platform gives the process to stop).
6. If several instances send requests to the same entity, use sessions on
   `<entity>.reply` and set `replySessions: true` on every client. Sessions
   cannot be turned on for an existing queue: the reply queue has to be
   deleted and created again with sessions (the Basic tier has none). Set
   `replyTimeoutInMs` on the clients while you do it, so that the requests
   whose replies are lost in the switch fail instead of waiting.
7. Consider `allowedReplyTo` on the servers and least-privilege access rights
   (see "Security" in the README).
8. If you called `createMessageHandlers()` or `handleMessage()` on the client,
   remove those calls: replies are handled internally.

## [1.1.0] - 2024-04-16

Last release before this changelog was started.

[1.2.0]: https://github.com/Niurmiguel/nestjs-service-bus/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/Niurmiguel/nestjs-service-bus/releases/tag/1.1.0
