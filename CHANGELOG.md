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
  time fails with the new, exported `ReplyTimeoutError`. Not set by default.
- Client option `replySessions`: each client receives its replies in a session
  of its own, for several clients (e.g. replicas) sending to the same entity.
- The errors (`ReplyTimeoutError`, `InvalidMessageException`) are exported from
  the package root.
- Unit tests (`npm test`) and integration tests against the Azure Service Bus
  emulator (`npm run test:integration`), run in CI with NestJS 10 and 11 and
  with the lowest and latest supported `@azure/service-bus`.

### Changed

- `@azure/service-bus` is now a peer dependency, `^7.9.0`. It was always
  required at run time but was only a devDependency.
- Peer ranges: `@nestjs/*` `^10.0.4 || ^11.0.0`, `reflect-metadata`
  `^0.1.13 || ^0.2.0`.
- The package only contains `dist/`, `lib/` (the sources the source maps point
  to), the README, the license and this changelog. It used to include the
  tests, the CI workflows and the emulator setup.
- Replies of request-response carry application properties
  (`nestjs-sb-reply-type`, `nestjs-sb-is-disposed`), and requests carry
  `nestjs-sb-request-id`; see "Behavior changes".
- A handler's response is sent as one reply per value, with the end of the
  response on the last one: one message for a single value (it could be two).
- An event handler that returns an Observable has its message completed when
  that Observable completes, not when the handler returns it.

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
- Server: when a request handler threw, no reply was sent and the client waited
  forever. The client now gets the error (see "Behavior changes").
- Server: receiver errors were never logged and `processError` never resolved.
- Client: with concurrent `send()` calls to the same entity, a client could get
  another request's reply, and that reply was lost for its own request.
  Replies are now matched to their request by `correlationId`.
- Client: a `send()` to an entity that does not exist ended the process with an
  unhandled rejection, and after `close()` a send kept the process alive for
  about 90 seconds and then crashed it. Send errors now fail the Observable,
  senders and receivers are closed in order, and `close()` waits for the sends
  in flight.
- Client: a `send()` whose reply queue does not exist waited forever; it now
  fails. Reply receiver errors are logged (they were thrown inside a promise
  nobody awaited).
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

- The package no longer publishes its tests, CI workflows, emulator setup and
  configuration files.
- Releases are published from CI with npm provenance (`--provenance`), with
  dependency install scripts disabled in the job that holds the npm token, and
  GitHub Actions pinned to commit SHAs with read-only default permissions and
  no persisted checkout credentials.
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
- **Failed request handlers**: the client's `send()` Observable now fails with
  the error instead of waiting forever. The request message is completed once
  the error reply is sent (it is not delivered again).
- **Replies that are not the client's**: a client that receives a reply to a
  request it did not send abandons it (1.1.0 consumed it, and handed it to the
  wrong caller). With several clients on one reply queue, replies can bounce and
  end in the dead-letter queue: use `replySessions`.
- **`close()` of the client** waits for the sends in flight, and fails the
  `send()` calls still waiting for a reply with an error. After `close()`, a new
  `send()`/`emit()` connects again.
- **`maxAutoLockRenewalDurationInMs`** now takes effect. If you set it to `0`,
  locks are no longer renewed and a handler that outlasts the entity's lock
  duration loses the lock (the message is delivered again).
- **Event handlers that return an Observable**: the message is settled when the
  Observable completes. One that never completes keeps its message locked.
- **Peer dependency**: npm 7+ and pnpm now check that `@azure/service-bus`
  7.9.0 or later is installed.
- **Mixed versions**: a 1.2.0 server answers 1.1.0 clients as before, but a
  1.1.0 client receives an error reply as a regular value. A 1.2.0 client
  understands 1.1.0 servers, except when the caller sets its own `messageId` on
  `send()` (that server replies to the `messageId`, not to the request id), and
  `replySessions` needs 1.2.0 servers.

### Upgrading from 1.1.0

1. Make sure `@azure/service-bus` 7.9.0 or later is a dependency of your
   application.
2. Upgrade the servers (microservices) first, then the clients.
3. Review the event handlers that use `peekLock` and can throw: their messages
   are now redelivered and eventually dead-lettered. Check the entity's max
   delivery count and that the handlers are idempotent.
4. If you relied on `send()` waiting forever when the handler failed, handle the
   error of the Observable now. Consider `replyTimeoutInMs` for `send()` calls
   that must not wait forever.
5. If several instances send requests to the same entity, enable sessions on
   `<entity>.reply` and set `replySessions: true` on every client.
6. If you called `createMessageHandlers()` or `handleMessage()` on the client,
   remove those calls: replies are handled internally.

## [1.1.0] - 2024-04-16

Last release before this changelog was started.

[1.2.0]: https://github.com/Niurmiguel/nestjs-service-bus/compare/1.1.0...1.2.0
[1.1.0]: https://github.com/Niurmiguel/nestjs-service-bus/releases/tag/1.1.0
