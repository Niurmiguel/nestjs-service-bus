"use strict";
// Unit tests against the compiled output in dist/ (run `npm run build` first,
// `npm test` does it). No Azure connection: ServiceBusClient is replaced by
// in-memory fakes assigned to the private `sbClient` field.
require("reflect-metadata");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lastValueFrom } = require("rxjs");
const { randomUUID } = require("node:crypto");
const { ServiceBusError } = require("@azure/service-bus");
const { Controller, Module } = require("@nestjs/common");
const { ClientProxyFactory, MessagePattern, Transport } = require("@nestjs/microservices");
const { PATTERN_METADATA, TRANSPORT_METADATA } = require("@nestjs/microservices/constants");

const { freePort, startHybridApp } = require("./hybrid-app");
const {
  AZURE_SERVICE_BUS_TRANSPORT,
  AzureServiceBusClient,
  AzureServiceBusContext,
  AzureServiceBusModule,
  AzureServiceBusServer,
  Queue,
  ReplyTimeoutError,
  Subscription,
} = require("../dist");
const {
  SB_REPLY_DISPOSED_PROPERTY,
  SB_REPLY_TYPE_PROPERTY,
  SB_REQUEST_ID_PROPERTY,
  SB_SUBSCRIBER_EXTRA,
  SB_SUBSCRIBER_METADATA,
} = require("../dist/azure-service-bus.constants");

// Never parsed: the SDK client is only created on connect()/listen(), which
// the tests replace with fakes.
const CONNECTION_STRING = "fake-connection-string";

function fakeSender() {
  const sender = { sent: [], closed: false };
  let markClosed;
  sender.done = new Promise((resolve) => (markClosed = resolve));
  sender.sendMessages = async (messages, options) => {
    sender.sent.push({ messages, options });
  };
  sender.close = async () => {
    sender.closed = true;
    markClosed();
  };
  return sender;
}

/**
 * A fake ServiceBusClient for the client side: records the senders and the
 * reply receivers, and lets a test deliver replies through `processMessage`.
 */
function fakeClientSdk({ sendMessages } = {}) {
  const sdk = { senders: [], receivers: [], closed: false };
  sdk.createSender = (name) => {
    const sender = fakeSender();
    sender.name = name;
    if (sendMessages) sender.sendMessages = (...args) => sendMessages(sender, ...args);
    sdk.senders.push(sender);
    return sender;
  };
  sdk.createReceiver = (entity, options) => {
    const receiver = {
      entity,
      options,
      closed: false,
      completed: [],
      abandoned: [],
      deadLettered: [],
      subscribe(handlers, subscribeOptions) {
        receiver.handlers = handlers;
        receiver.subscribeOptions = subscribeOptions;
        return { close: async () => {} };
      },
      async completeMessage(message) {
        receiver.completed.push(message);
      },
      async abandonMessage(message) {
        receiver.abandoned.push(message);
      },
      async deadLetterMessage(message, options) {
        receiver.deadLettered.push({ message, options });
      },
      async close() {
        receiver.closed = true;
      },
    };
    sdk.receivers.push(receiver);
    return receiver;
  };
  sdk.acceptSession = async (entity, sessionId, options) => {
    const receiver = sdk.createReceiver(entity, options);
    receiver.sessionId = sessionId;
    return receiver;
  };
  sdk.close = async () => {
    sdk.closed = true;
  };
  return sdk;
}

/** A received reply as the SDK hands it to processMessage. */
function replyMessage(correlationId, body, applicationProperties) {
  return { correlationId, body, applicationProperties, messageId: `reply-${Math.random()}` };
}

/** Reply properties a 1.2.0 server sets (see SB_REPLY_* in the constants). */
const RESPONSE_END = {
  [SB_REPLY_TYPE_PROPERTY]: "response",
  [SB_REPLY_DISPOSED_PROPERTY]: true,
};

/** Starts a send() and collects what its Observable does. */
function collect(observable) {
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => (resolveDone = resolve));
  observable.subscribe({
    next: (value) => events.push(["next", value]),
    error: (err) => {
      events.push(["error", err]);
      resolveDone();
    },
    complete: () => {
      events.push(["complete"]);
      resolveDone();
    },
  });
  return { events, done };
}

/** The request id a send() put on the message it sent. */
const requestIdOf = (sender) => sender.sent[0].messages[0].messageId;

/** Lets pending promise callbacks and I/O callbacks run `n` times. */
async function ticks(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
}

function silentLogger(logged = []) {
  const push = (level) => (...args) => logged.push({ level, args });
  return { error: push("error"), warn: push("warn"), log: push("log"), debug: push("debug"), verbose() {} };
}

test("forRoot registers one closable client provider per entry", () => {
  const mod = AzureServiceBusModule.forRoot([
    { name: "SB_A", connectionString: CONNECTION_STRING },
    { name: "SB_B", connectionString: CONNECTION_STRING },
  ]);

  assert.equal(mod.module, AzureServiceBusModule);
  assert.deepEqual(
    mod.providers.map((p) => p.provide),
    ["SB_A", "SB_B"]
  );
  for (const provider of mod.providers) {
    assert.ok(provider.useValue instanceof AzureServiceBusClient);
    assert.equal(typeof provider.useValue.onApplicationShutdown, "function");
  }
});

test("forRootAsync builds the client from the factory result", async () => {
  const mod = AzureServiceBusModule.forRootAsync([
    {
      name: "SB_ASYNC",
      useFactory: async () => ({ connectionString: CONNECTION_STRING }),
    },
  ]);

  const [provider] = mod.providers;
  assert.equal(provider.provide, "SB_ASYNC");
  const client = await provider.useFactory();
  assert.ok(client instanceof AzureServiceBusClient);
});

test("@Subscription stores subscriber metadata and an event pattern", () => {
  const options = {
    topic: "orders",
    subscription: "billing",
    receiveMode: "peekLock",
  };

  class Handlers {
    onOrder() {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(Handlers.prototype, "onOrder");
  Subscription(options)(Handlers.prototype, "onOrder", descriptor);

  const stored = Reflect.getMetadata(SB_SUBSCRIBER_METADATA, Handlers.prototype);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].key, "onOrder");
  assert.equal(stored[0].metadata.type, "subscription");
  assert.deepEqual(stored[0].metadata.metaOptions, options);

  const patterns = Reflect.getMetadata(PATTERN_METADATA, descriptor.value);
  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0].metaOptions, options);
});

test("client.emit sends the message through a sender and closes it", { timeout: 5000 }, async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const sender = fakeSender();
  const createdFor = [];
  client.sbClient = {
    createSender: (name) => {
      createdFor.push(name);
      return sender;
    },
  };

  const sendOptions = { tracingOptions: { tracingContext: null } };
  client.emit({ name: "orders", options: sendOptions }, { body: "hello" });
  await sender.done;

  assert.deepEqual(createdFor, ["orders"]);
  assert.equal(sender.sent.length, 1);
  assert.deepEqual(sender.sent[0].messages, { body: "hello" });
  assert.deepEqual(sender.sent[0].options, sendOptions);
  assert.equal(sender.closed, true);
});

test("client.emit hands the send options to the SDK as given (AbortSignal included)", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const sender = fakeSender();
  client.sbClient = { createSender: () => sender };

  const abortSignal = new AbortController().signal;
  await lastValueFrom(client.emit({ name: "orders", options: { abortSignal } }, { body: 1 }), {
    defaultValue: undefined,
  });
  assert.equal(sender.sent[0].options.abortSignal, abortSignal);
});

test("client.emit accepts send options with undefined values", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const sender = fakeSender();
  client.sbClient = { createSender: () => sender };

  await lastValueFrom(
    client.emit({ name: "orders", options: { abortSignal: undefined } }, { body: 1 }),
    { defaultValue: undefined }
  );
  assert.equal(sender.sent.length, 1);
});

test("client.send hands the send options to the SDK as given", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const sender = fakeSender();
  client.sbClient = {
    createSender: () => sender,
    createReceiver: () => ({ subscribe: () => ({ close: async () => {} }), close: async () => {} }),
  };

  const abortSignal = new AbortController().signal;
  const subscription = client
    .send({ name: "orders", options: { abortSignal, tracingOptions: undefined } }, { body: 1 })
    .subscribe({ error: () => {} });
  for (let i = 0; i < 20 && sender.sent.length === 0; i++) await new Promise((r) => setImmediate(r));
  subscription.unsubscribe();
  assert.equal(sender.sent.length, 1);
  assert.equal(sender.sent[0].options.abortSignal, abortSignal);
});

test("client.emit with no subscriber logs a send that fails", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = { error: (...args) => logged.push(args), warn() {}, debug() {}, log() {} };
  const sender = fakeSender();
  sender.sendMessages = async () => {
    throw new Error("entity not found");
  };
  client.sbClient = { createSender: () => sender };

  client.emit({ name: "missing" }, { body: 1 }); // fire and forget
  for (let i = 0; i < 20 && logged.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(logged.length, 1);
  assert.match(String(logged[0][0]), /"missing".*entity not found/);
});

test("client.emit with a subscriber gives it the error instead of logging it", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = { error: (...args) => logged.push(args), warn() {}, debug() {}, log() {} };
  const sender = fakeSender();
  sender.sendMessages = async () => {
    throw new Error("entity not found");
  };
  client.sbClient = { createSender: () => sender };

  await assert.rejects(lastValueFrom(client.emit({ name: "missing" }, { body: 1 })), /entity not found/);
  assert.deepEqual(logged, []);
});

test("client.send errors the Observable when the send fails", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.sbClient = fakeClientSdk({
    sendMessages: async () => {
      throw Object.assign(new Error("The messaging entity could not be found"), {
        code: "MessagingEntityNotFound",
      });
    },
  });

  await assert.rejects(lastValueFrom(client.send({ name: "missing" }, { body: 1 })), {
    code: "MessagingEntityNotFound",
  });
  await ticks();
  assert.equal(client.sbClient.senders[0].closed, true);
});

test("client.close waits for the sends in flight", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  let finishSend;
  const sdk = fakeClientSdk({
    sendMessages: () => new Promise((resolve) => (finishSend = resolve)),
  });
  client.sbClient = sdk;
  client.logger = silentLogger();

  client.emit({ name: "orders" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  let closed = false;
  const closing = client.close().then(() => (closed = true));
  await ticks();
  assert.equal(closed, false, "close() resolved with a send in flight");
  assert.equal(sdk.closed, false);

  finishSend();
  await closing;
  assert.equal(sdk.senders[0].closed, true);
  assert.equal(sdk.closed, true);
});

test("a receiver that fails to close is logged, not left as an unhandled rejection", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = silentLogger(logged);
  const sdk = fakeClientSdk();
  const createReceiver = sdk.createReceiver;
  sdk.createReceiver = (...args) => {
    const receiver = createReceiver(...args);
    receiver.close = async () => {
      throw new Error("link detach failed");
    };
    return receiver;
  };
  client.sbClient = sdk;

  const subscription = client.send({ name: "orders" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  subscription.unsubscribe();
  await client.close();
  assert.ok(
    logged.some((e) => e.level === "error" && /link detach failed/.test(String(e.args[0]))),
    JSON.stringify(logged)
  );
});

test("client processError on a reply queue logs and resolves", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = silentLogger(logged);
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  client.send({ name: "q" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  const { processError } = sdk.receivers[0].handlers;

  const result = await Promise.race([
    processError({ error: new Error("link detached"), errorSource: "receive", entityPath: "q.reply" }).then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(resolve, 200, "pending").unref()),
  ]);
  assert.equal(result, "resolved");
  assert.match(String(logged[0].args[0]), /receive error on the reply queue "q.reply": link detached/);
});

test("client.send fails when its reply queue does not exist", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const reply = lastValueFrom(client.send({ name: "orders" }, { body: 1 }));
  await ticks();
  const notFound = new ServiceBusError("The messaging entity could not be found", "MessagingEntityNotFound");
  await sdk.receivers[0].handlers.processError({
    error: notFound,
    errorSource: "receive",
    entityPath: "orders.reply",
  });
  await assert.rejects(reply, { code: "MessagingEntityNotFound" });
});

test("client cancels the SDK's retries on a failed reply queue only once no link is being attached", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  const a = collect(client.send({ name: "orders" }, { body: 1 }));
  await ticks();
  const receiver = sdk.receivers[0];
  const { finish, result, signal } = attachInProgress(receiver);

  // The reply queue does not exist: the waiting send() fails and the reply
  // receiver closes, while the SDK is attaching its link again.
  await receiver.handlers.processError({
    error: new ServiceBusError("The messaging entity could not be found", "MessagingEntityNotFound"),
    errorSource: "receive",
    entityPath: "orders.reply",
  });
  await a.done;
  assert.equal(a.events[0][1].code, "MessagingEntityNotFound");
  await ticks();
  finish();
  await client.close();
  assert.equal(result.abortedWhenAttached, false, "the client aborted while the SDK attached a link");
  assert.equal(signal.aborted, true, "the client did not cancel the SDK's retries");
  assert.equal(receiver.closed, true);
});

test("client close() logs, and does not throw, a connection that fails to close", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = silentLogger(logged);
  const sdk = fakeClientSdk();
  sdk.close = async () => {
    throw { condition: "amqp:internal-error", description: "boom" };
  };
  client.sbClient = sdk;

  await client.close();
  assert.match(
    String(logged.find((e) => e.level === "error")?.args[0]),
    /Could not close the Azure Service Bus connection: .*amqp:internal-error/
  );
  assert.throws(() => client.unwrap(), /Not initialized/);
});

test("client.send fails with ReplyTimeoutError after replyTimeoutInMs", async () => {
  const client = new AzureServiceBusClient({
    connectionString: CONNECTION_STRING,
    replyTimeoutInMs: 50,
  });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const started = Date.now();
  await assert.rejects(lastValueFrom(client.send({ name: "orders" }, { body: 1 })), (err) => {
    assert.ok(err instanceof ReplyTimeoutError);
    assert.equal(err.replyTo, "orders.reply");
    assert.equal(err.timeoutInMs, 50);
    return true;
  });
  assert.ok(Date.now() - started >= 45);
  await ticks();
  assert.equal(sdk.receivers[0].closed, true, "the reply receiver was not closed");
});

test("concurrent send() calls each get their own reply, whatever the arrival order", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const a = collect(client.send({ name: "rpc" }, { body: "a" }));
  const b = collect(client.send({ name: "rpc" }, { body: "b" }));
  await ticks();
  const [senderA, senderB] = sdk.senders;
  const { processMessage } = sdk.receivers[0].handlers;

  // B's reply arrives first, on the first receiver that was opened.
  await processMessage(replyMessage(requestIdOf(senderB), "reply-b", RESPONSE_END));
  await processMessage(replyMessage(requestIdOf(senderA), "reply-a", RESPONSE_END));
  await Promise.all([a.done, b.done]);

  assert.deepEqual(a.events, [["next", "reply-a"], ["complete"]]);
  assert.deepEqual(b.events, [["next", "reply-b"], ["complete"]]);
  assert.equal(sdk.receivers.length, 1, "one reply receiver shared by the requests");
  assert.notEqual(requestIdOf(senderA), requestIdOf(senderB));
  await ticks();
  assert.equal(sdk.receivers[0].closed, true, "closed once no request waits");
});

test("a reply to a request this client did not send is abandoned, not delivered", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const a = collect(client.send({ name: "rpc" }, { body: "a" }));
  await ticks();
  const foreign = replyMessage(randomUUID(), "not-yours", RESPONSE_END);
  await sdk.receivers[0].handlers.processMessage(foreign);

  assert.deepEqual(a.events, []);
  assert.deepEqual(sdk.receivers[0].abandoned, [foreign]);
  assert.deepEqual(sdk.receivers[0].completed, []);

  await sdk.receivers[0].handlers.processMessage(
    replyMessage(requestIdOf(sdk.senders[0]), "mine", RESPONSE_END)
  );
  await a.done;
  assert.deepEqual(a.events, [["next", "mine"], ["complete"]]);
});

test("a late reply to one of this client's finished requests is completed and dropped", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const a = collect(client.send({ name: "rpc" }, { body: "a" }));
  const b = collect(client.send({ name: "rpc" }, { body: "b" })); // keeps the receiver open
  await ticks();
  const id = requestIdOf(sdk.senders[0]);
  const receiver = sdk.receivers[0];
  await receiver.handlers.processMessage(replyMessage(id, "first", RESPONSE_END));
  await a.done;

  const late = replyMessage(id, "again", RESPONSE_END);
  await receiver.handlers.processMessage(late);
  assert.deepEqual(a.events, [["next", "first"], ["complete"]]);
  assert.deepEqual(b.events, []);
  assert.equal(receiver.completed.at(-1), late);
  assert.deepEqual(receiver.abandoned, []);
});

test("send() marks its messages with the request id and the reply queue", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  client
    .send({ name: "rpc" }, [
      { body: 1, applicationProperties: { tenant: "t1" } },
      { body: 2, messageId: "dedup-key" },
    ])
    .subscribe({ error: () => {} });
  await ticks();
  const [first, second] = sdk.senders[0].sent[0].messages;
  const id = first.applicationProperties[SB_REQUEST_ID_PROPERTY];
  assert.equal(typeof id, "string");
  assert.equal(first.messageId, id);
  assert.equal(first.replyTo, "rpc.reply");
  assert.equal(first.applicationProperties.tenant, "t1");
  // A messageId set by the caller (e.g. for duplicate detection) is kept: the
  // request id travels in the application property.
  assert.equal(second.messageId, "dedup-key");
  assert.equal(second.applicationProperties[SB_REQUEST_ID_PROPERTY], id);
  assert.equal(first.replyToSessionId, undefined);
});

test("send() completes on a reply from a 1.1.0 server (no reply properties)", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const a = collect(client.send({ name: "rpc" }, { body: 1 }));
  await ticks();
  await sdk.receivers[0].handlers.processMessage(replyMessage(requestIdOf(sdk.senders[0]), 5));
  await a.done;
  assert.deepEqual(a.events, [["next", 5], ["complete"]]);
});

test("send() follows a streamed reply: values, an undefined value and the end", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const a = collect(client.send({ name: "rpc" }, { body: 1 }));
  const empty = collect(client.send({ name: "rpc" }, { body: 2 }));
  await ticks();
  const { processMessage } = sdk.receivers[0].handlers;
  const idA = requestIdOf(sdk.senders[0]);
  const idEmpty = requestIdOf(sdk.senders[1]);
  const value = { [SB_REPLY_TYPE_PROPERTY]: "response", [SB_REPLY_DISPOSED_PROPERTY]: false };
  await processMessage(replyMessage(idA, 1, value));
  await processMessage(replyMessage(idA, undefined, RESPONSE_END));
  await processMessage(
    replyMessage(idEmpty, undefined, { [SB_REPLY_TYPE_PROPERTY]: "none", [SB_REPLY_DISPOSED_PROPERTY]: true })
  );
  await Promise.all([a.done, empty.done]);
  assert.deepEqual(a.events, [["next", 1], ["next", undefined], ["complete"]]);
  assert.deepEqual(empty.events, [["complete"]]);
});

test("send() fails with the error a server replies with", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const a = collect(client.send({ name: "rpc" }, { body: 1 }));
  await ticks();
  const error = { status: "error", message: "Internal server error" };
  await sdk.receivers[0].handlers.processMessage(
    replyMessage(requestIdOf(sdk.senders[0]), error, {
      [SB_REPLY_TYPE_PROPERTY]: "error",
      [SB_REPLY_DISPOSED_PROPERTY]: true,
    })
  );
  await a.done;
  assert.deepEqual(a.events, [["error", error]]);
});

test("send() with replySessions receives its replies in its own session", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING, replySessions: true });
  const other = new AzureServiceBusClient({ connectionString: CONNECTION_STRING, replySessions: true });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  other.sbClient = fakeClientSdk();

  const a = collect(client.send({ name: "rpc" }, { body: 1 }));
  other.send({ name: "rpc" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  const [message] = sdk.senders[0].sent[0].messages;
  const sessionId = message.replyToSessionId;
  assert.equal(typeof sessionId, "string");
  assert.notEqual(other.sbClient.senders[0].sent[0].messages[0].replyToSessionId, sessionId);
  const receiver = sdk.receivers[0];
  assert.equal(receiver.entity, "rpc.reply");
  assert.equal(receiver.sessionId, sessionId);

  await receiver.handlers.processMessage(replyMessage(requestIdOf(sdk.senders[0]), "ok", RESPONSE_END));
  await a.done;
  assert.deepEqual(a.events, [["next", "ok"], ["complete"]]);
});

test("client.close fails the requests still waiting for a reply", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;

  const a = collect(client.send({ name: "rpc" }, { body: 1 }));
  await ticks();
  await client.close();
  await a.done;
  assert.equal(a.events[0][0], "error");
  assert.match(a.events[0][1].message, /closed before the reply/);
  assert.equal(sdk.receivers[0].closed, true);
  assert.equal(sdk.closed, true);
});

test("client.emit rejects a missing pattern or payload", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  await assert.rejects(lastValueFrom(client.emit(null, { body: "x" })), {
    message: /invalid data or message pattern/,
  });
  await assert.rejects(lastValueFrom(client.send({ name: "q" }, undefined)), {
    message: /invalid data or message pattern/,
  });
});

test("client.unwrap throws before connect and returns the SDK client after", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  assert.throws(() => client.unwrap(), /Not initialized/);

  const sdkClient = { createSender() {} };
  client.sbClient = sdkClient;
  await client.connect();
  assert.equal(client.unwrap(), sdkClient);
});

test("server dispatches an event message to its handler with a context", async () => {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  const calls = [];
  server.addHandler(
    "orders-pattern",
    async (data, ctx) => {
      calls.push({ data, ctx });
    },
    true
  );

  const received = { body: { id: 1 }, messageId: "m-1" };
  await server.handleMessage(received, "orders-pattern");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].data, received);
  assert.ok(calls[0].ctx instanceof AzureServiceBusContext);
});

/** A server whose replies are recorded instead of sent. */
function replyingServer(handler, options = {}) {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING, ...options });
  server.logger = silentLogger();
  const replies = [];
  server.sbClient = {
    createSender: (entity) => ({
      sendMessages: async (messages) => replies.push(...messages.map((m) => ({ entity, ...m }))),
      close: async () => {},
    }),
  };
  server.addHandler("rpc-pattern", handler, true);
  return { server, replies };
}

test("server replies with the request id as correlationId, in the reply session", async () => {
  const { server, replies } = replyingServer(async (message) => message.body * 2);

  await server.handleMessage(
    {
      body: 21,
      messageId: "dedup-key",
      replyTo: "rpc.reply",
      replyToSessionId: "client-session",
      applicationProperties: { [SB_REQUEST_ID_PROPERTY]: "req-1" },
    },
    "rpc-pattern"
  );

  assert.deepEqual(replies, [
    {
      entity: "rpc.reply",
      correlationId: "req-1",
      sessionId: "client-session",
      body: 42,
      applicationProperties: { [SB_REPLY_TYPE_PROPERTY]: "response", [SB_REPLY_DISPOSED_PROPERTY]: true },
    },
  ]);
});

/** A request as a 1.2.0 client sends it. */
const requestFrom120 = (extra = {}) => ({
  body: null,
  messageId: "m-1",
  replyTo: "rpc.reply",
  applicationProperties: { [SB_REQUEST_ID_PROPERTY]: "req-1" },
  ...extra,
});

/** [body, reply type, is the end] of each reply. */
const replyShape = (replies) =>
  replies.map((r) => [
    r.body,
    r.applicationProperties[SB_REPLY_TYPE_PROPERTY],
    r.applicationProperties[SB_REPLY_DISPOSED_PROPERTY],
  ]);

test("server streams values to a 1.2.0 client, with the end on the last one of the same tick", async () => {
  const { of } = require("rxjs");
  const { server, replies } = replyingServer(async () => of(1, 2, 3));

  await server.handleMessage(requestFrom120(), "rpc-pattern"); // resolves after the first reply
  await ticks();

  assert.deepEqual(
    replies.map((r) => [r.correlationId, r.body, r.applicationProperties[SB_REPLY_DISPOSED_PROPERTY]]),
    [
      ["req-1", 1, false],
      ["req-1", 2, false],
      ["req-1", 3, true],
    ]
  );
});

test("server answers a 1.1.0 client by messageId with a single reply (it reads any further one as the next answer)", async () => {
  const { of, concat, throwError, Subject } = require("rxjs");
  const legacy = { body: null, messageId: "m-1", replyTo: "rpc.reply" };

  const stream = replyingServer(async () => of(1, 2, 3));
  await stream.server.handleMessage(legacy, "rpc-pattern");
  assert.deepEqual(
    stream.replies.map((r) => [r.correlationId, ...replyShape([r])[0]]),
    [["m-1", 1, "response", true]]
  );

  const failingLater = replyingServer(async () => concat(of(1), throwError(() => ({ status: "error" }))));
  await failingLater.server.handleMessage(legacy, "rpc-pattern");
  assert.deepEqual(replyShape(failingLater.replies), [[1, "response", true]]);

  const failing = replyingServer(async () => throwError(() => ({ status: "error", message: "x" })));
  await failing.server.handleMessage(legacy, "rpc-pattern");
  assert.deepEqual(replyShape(failing.replies), [[{ status: "error", message: "x" }, "error", true]]);

  // Spread over time: still one reply, sent as soon as the first value comes.
  const later = new Subject();
  const spread = replyingServer(async () => later);
  const handling = spread.server.handleMessage(legacy, "rpc-pattern");
  await ticks();
  later.next("first");
  await handling; // resolves once the first reply is out
  later.next("second");
  later.complete();
  await ticks();
  assert.deepEqual(replyShape(spread.replies), [["first", "response", true]]);
});

test("server ends an empty response with a reply that has no value", async () => {
  const { EMPTY } = require("rxjs");
  const { server, replies } = replyingServer(async () => EMPTY);

  await server.handleMessage({ body: null, messageId: "m-1", replyTo: "rpc.reply" }, "rpc-pattern");

  assert.equal(replies.length, 1);
  assert.equal(replies[0].body, undefined);
  assert.deepEqual(replies[0].applicationProperties, {
    [SB_REPLY_TYPE_PROPERTY]: "none",
    [SB_REPLY_DISPOSED_PROPERTY]: true,
  });
});

test("server logs a reply it cannot send, even in the middle of a long response", async () => {
  const { Subject } = require("rxjs");
  const values = new Subject();
  const { server } = replyingServer(async () => values);
  const logged = [];
  server.logger = silentLogger(logged);
  server.sbClient = {
    createSender: () => ({
      sendMessages: async () => {
        throw new Error("reply queue is gone");
      },
      close: async () => {},
    }),
  };
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const handling = server.handleMessage(requestFrom120(), "rpc-pattern");
    await ticks();
    values.next(1);
    values.next(2); // the first reply is sent (and fails) while the response goes on
    await ticks(20);
    values.next(3);
    values.complete();
    await handling;
    await ticks(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(logged.filter((e) => e.level === "error").length, 1);
  assert.match(String(logged[0].args[0]), /Could not send the reply to "rpc.reply": reply queue is gone/);
});

test("server replies with the error when a request handler fails", async () => {
  const { of, concat, throwError } = require("rxjs");
  // What Nest's exception filter returns: an Observable that errors with a
  // client-safe object (no stack).
  const filtered = { status: "error", message: "Internal server error" };
  const { server, replies } = replyingServer(async () => concat(of(1), throwError(() => filtered)));

  await server.handleMessage(requestFrom120(), "rpc-pattern");
  await ticks(); // handleMessage() resolves once the first reply is out

  assert.deepEqual(
    replies.map((r) => [r.body, r.applicationProperties[SB_REPLY_TYPE_PROPERTY], r.applicationProperties[SB_REPLY_DISPOSED_PROPERTY]]),
    [
      [1, "response", false],
      [filtered, "error", true],
    ]
  );
});

test("server replies with a generic error, and logs it, when an Error bypasses Nest's filter", async () => {
  const logged = [];
  const { server, replies } = replyingServer(async () => {
    throw new TypeError("secret detail at /srv/app/handler.js:12");
  });
  server.logger = silentLogger(logged);

  await server.handleMessage({ body: null, messageId: "m-1", replyTo: "rpc.reply" }, "rpc-pattern");

  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].body, { status: "error", message: "Internal server error" });
  assert.equal(replies[0].applicationProperties[SB_REPLY_TYPE_PROPERTY], "error");
  assert.ok(!JSON.stringify(replies[0]).includes("secret"));
  assert.match(String(logged.find((e) => e.level === "error")?.args[0]), /secret detail/);
});

test("server replies with an error when no handler matches the request", async () => {
  const { server, replies } = replyingServer(async () => 1);
  await server.handleMessage({ body: null, messageId: "m-1", replyTo: "rpc.reply" }, "unknown-pattern");
  assert.equal(replies[0].applicationProperties[SB_REPLY_TYPE_PROPERTY], "error");
});

test("server.unwrap throws before listen", () => {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  assert.throws(() => server.unwrap(), /Not initialized/);
});

test("server.bindEvents opens one receiver per subscription", async () => {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  const receivers = [];
  server.sbClient = {
    createReceiver: (topic, subscription, options) => {
      const receiver = {
        topic,
        subscription,
        options,
        subscribed: false,
        closed: false,
        subscribe() {
          receiver.subscribed = true;
          return { close: async () => {} };
        },
        async close() {
          receiver.closed = true;
        },
      };
      receivers.push(receiver);
      return receiver;
    },
  };
  server.addHandler(
    { type: "subscription", metaOptions: { topic: "orders", subscription: "billing", receiveMode: "receiveAndDelete" } },
    async () => {},
    true
  );

  await server.bindEvents();

  assert.equal(receivers.length, 1);
  assert.equal(receivers[0].topic, "orders");
  assert.equal(receivers[0].subscription, "billing");
  assert.equal(receivers[0].options.receiveMode, "receiveAndDelete");
  assert.equal(receivers[0].subscribed, true);
});

function fakeServiceBusClient() {
  const calls = { receivers: [], closed: false };
  calls.client = {
    createReceiver: (...args) => {
      const receiver = {
        args,
        receiveMode: "peekLock",
        subscribeOptions: undefined,
        subscriptionClosed: false,
        closed: false,
        subscribe(handlers, options) {
          receiver.handlers = handlers;
          receiver.subscribeOptions = options;
          return {
            close: async () => {
              receiver.subscriptionClosed = true;
            },
          };
        },
        async close() {
          receiver.closed = true;
        },
      };
      calls.receivers.push(receiver);
      return receiver;
    },
    async close() {
      calls.closed = true;
    },
  };
  return calls;
}

function serverWith(fake, ...patterns) {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  server.createServiceBusClient = () => fake.client;
  for (const pattern of patterns) server.addHandler(pattern, async () => {}, true);
  return server;
}

const listen = (server) =>
  new Promise((resolve, reject) => server.listen((err) => (err ? reject(err) : resolve())));

test("server keeps receivers open while listening and closes them in close()", async () => {
  const fake = fakeServiceBusClient();
  const server = serverWith(fake, {
    type: "subscription",
    metaOptions: { topic: "t", subscription: "s", receiveMode: "peekLock" },
  });

  await listen(server);
  const [receiver] = fake.receivers;
  assert.equal(receiver.closed, false);
  assert.equal(receiver.subscriptionClosed, false);
  assert.equal(server.receivers.size, 1);

  await server.close();
  assert.equal(receiver.subscriptionClosed, true);
  assert.equal(receiver.closed, true);
  assert.equal(fake.closed, true);
  assert.equal(server.receivers.size, 0);
  assert.throws(() => server.unwrap(), /Not initialized/);
});

test("server uses the queue overload of createReceiver for @Queue", async () => {
  const fake = fakeServiceBusClient();
  const server = serverWith(fake, {
    type: "queue",
    metaOptions: {
      queueName: "jobs",
      receiveMode: "receiveAndDelete",
      subQueueType: "deadLetter",
      skipParsingBodyAsJson: true,
    },
  });

  await listen(server);
  // Two arguments: a non-string second argument is read as the options, so
  // passing (queue, null, options) would silently drop them.
  assert.deepEqual(fake.receivers[0].args, [
    "jobs",
    { receiveMode: "receiveAndDelete", subQueueType: "deadLetter", skipParsingBodyAsJson: true },
  ]);
  await server.close();
});

test("server hands maxAutoLockRenewalDurationInMs to the receiver, 0 included", async () => {
  for (const value of [0, 60_000]) {
    const fake = fakeServiceBusClient();
    const server = serverWith(fake, {
      type: "queue",
      metaOptions: { queueName: "jobs", receiveMode: "peekLock", maxAutoLockRenewalDurationInMs: value },
    });
    await listen(server);
    assert.equal(fake.receivers[0].args[1].maxAutoLockRenewalDurationInMs, value);
    await server.close();
  }
});

test("server keeps reading @Subscription without a subscription name as a queue", async () => {
  const fake = fakeServiceBusClient();
  const server = serverWith(fake, {
    type: "subscription",
    metaOptions: { topic: "legacy-queue", receiveMode: "receiveAndDelete" },
  });

  await listen(server);
  assert.equal(fake.receivers[0].args.length, 2);
  assert.equal(fake.receivers[0].args[0], "legacy-queue");
  assert.equal(fake.receivers[0].args[1].receiveMode, "receiveAndDelete");
  await server.close();
});

test("server subscribes with its own completion and an abort signal", async () => {
  const fake = fakeServiceBusClient();
  const server = serverWith(fake, {
    type: "queue",
    metaOptions: { queueName: "q", receiveMode: "peekLock", options: { maxConcurrentCalls: 4 } },
  });

  await listen(server);
  const options = fake.receivers[0].subscribeOptions;
  assert.equal(options.maxConcurrentCalls, 4);
  assert.equal(options.autoCompleteMessages, false);
  assert.equal(options.abortSignal.aborted, false);
  await server.close();
  assert.equal(options.abortSignal.aborted, true);
});

test("a second listen() reuses the client and the receivers", async () => {
  const fake = fakeServiceBusClient();
  let clients = 0;
  const server = serverWith(fake, { type: "queue", metaOptions: { queueName: "q" } });
  server.createServiceBusClient = () => {
    clients++;
    return fake.client;
  };

  await listen(server);
  await listen(server);
  assert.equal(clients, 1);
  assert.equal(fake.receivers.length, 1);
  await server.close();
});

test("a failed listen() closes what it opened and reports the error", async () => {
  const fake = fakeServiceBusClient();
  const server = serverWith(
    fake,
    { type: "queue", metaOptions: { queueName: "ok" } },
    { type: "queue", metaOptions: { receiveMode: "peekLock", broken: true } }
  );

  await assert.rejects(listen(server), /broken.*needs a "queueName"/);
  assert.equal(fake.receivers[0].closed, true);
  assert.equal(fake.closed, true);
});

/** A controller declared the way a TypeScript user would, from plain functions. */
function controllerWith(handlers) {
  class Handlers {}
  for (const [name, { decorator, fn }] of Object.entries(handlers)) {
    Object.defineProperty(Handlers.prototype, name, { value: fn, writable: true, configurable: true });
    decorator(Handlers.prototype, name, Object.getOwnPropertyDescriptor(Handlers.prototype, name));
  }
  Controller()(Handlers);
  return Handlers;
}

/** A module with the handlers of a hybrid app: this transport's, TCP's and undeclared ones. */
function hybridModule(received) {
  const handlers = controllerWith({
    onJob: { decorator: Queue({ queueName: "jobs", receiveMode: "peekLock" }), fn: (m) => received.push(m) },
    onOrder: {
      decorator: Subscription({ topic: "orders", subscription: "billing", receiveMode: "peekLock" }),
      fn: (m) => received.push(m),
    },
    // No transport: Nest registers it on every server of the app, this one included.
    sum: { decorator: MessagePattern({ cmd: "sum" }), fn: (numbers) => numbers.reduce((a, b) => a + b, 0) },
    // TCP only.
    ping: { decorator: MessagePattern({ cmd: "ping" }, Transport.TCP), fn: () => "pong" },
  });
  class AppModule {}
  Module({ controllers: [handlers] })(AppModule);
  return AppModule;
}

const TCP_ONLY_PATTERN = '{"cmd":"ping"}';
const UNDECLARED_PATTERN = '{"cmd":"sum"}';

test("a hybrid app (#216): only @Queue/@Subscription handlers open receivers, and TCP keeps its own", async () => {
  // The server as given, and a subclass of it: both are used as `strategy`.
  class CustomServer extends AzureServiceBusServer {}
  for (const ServerClass of [AzureServiceBusServer, CustomServer]) {
    const fake = fakeServiceBusClient();
    const server = new ServerClass({ connectionString: CONNECTION_STRING });
    server.createServiceBusClient = () => fake.client;
    const logged = [];
    server.logger = silentLogger(logged);
    const port = await freePort();
    const received = [];

    const app = await startHybridApp(hybridModule(received), [
      { strategy: server },
      { transport: Transport.TCP, options: { host: "127.0.0.1", port } },
    ]);
    const tcp = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: "127.0.0.1", port } });
    try {
      // This server: a receiver for each of its handlers, and nothing else.
      assert.deepEqual(
        fake.receivers.map(({ args }) => args.slice(0, args.length - 1)).sort(),
        [["jobs"], ["orders", "billing"]]
      );
      const patterns = [...server.getHandlers().keys()];
      assert.ok(!patterns.includes(TCP_ONLY_PATTERN), "a TCP handler reached this server");
      // A handler without transport reaches every server; this one ignores it
      // and says so once, at debug level.
      assert.ok(patterns.includes(UNDECLARED_PATTERN));
      const ignored = logged.filter(({ args }) => String(args[0]).includes('{\\"cmd\\":\\"sum\\"}'));
      assert.equal(ignored.length, 1, JSON.stringify(logged));
      assert.equal(ignored[0].level, "debug");
      assert.deepEqual(logged.filter(({ level }) => level !== "debug"), []);

      // The TCP server: its handlers, and none of this transport's.
      assert.equal(await lastValueFrom(tcp.send({ cmd: "ping" }, {})), "pong");
      assert.equal(await lastValueFrom(tcp.send({ cmd: "sum" }, [1, 2, 3])), 6);
      const ours = JSON.parse([...patterns].find((p) => p.includes('"queueName":"jobs"')));
      await assert.rejects(lastValueFrom(tcp.send(ours, {})), /no matching message handler/);

      // A message for this transport still reaches its handler.
      const [jobs] = fake.receivers.filter(({ args }) => args[0] === "jobs");
      jobs.completeMessage = async () => {};
      await jobs.handlers.processMessage({ body: { n: 1 }, messageId: "m1" });
      assert.deepEqual(received.map((m) => m.body), [{ n: 1 }]);

      // listen() again: no second receiver, no second log line.
      await listen(server);
      assert.equal(fake.receivers.length, 2);
      assert.equal(logged.length, 1);
    } finally {
      await tcp.close();
      await app.close();
    }
    assert.equal(fake.closed, true);
  }
});

test("server.transportId is AZURE_SERVICE_BUS_TRANSPORT, which @Queue and @Subscription declare", () => {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  assert.equal(typeof AZURE_SERVICE_BUS_TRANSPORT, "symbol");
  assert.equal(server.transportId, AZURE_SERVICE_BUS_TRANSPORT);
  // A registered symbol: a second copy of this package in node_modules still matches.
  assert.equal(AZURE_SERVICE_BUS_TRANSPORT, Symbol.for(Symbol.keyFor(AZURE_SERVICE_BUS_TRANSPORT)));

  class Handlers {
    onJob() {}
    onOrder() {}
  }
  for (const [key, decorator] of [
    ["onJob", Queue({ queueName: "jobs" })],
    ["onOrder", Subscription({ topic: "t", subscription: "s" })],
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(Handlers.prototype, key);
    decorator(Handlers.prototype, key, descriptor);
    assert.equal(Reflect.getMetadata(TRANSPORT_METADATA, descriptor.value), AZURE_SERVICE_BUS_TRANSPORT);
  }
});

test("bindEvents() ignores the patterns of other transports, logging each once at debug level", async () => {
  const fake = fakeServiceBusClient();
  const server = serverWith(
    fake,
    { type: "queue", metaOptions: { queueName: "jobs" } },
    "plain-string",
    { cmd: "sum" },
    42,
    { metaOptionsLike: { queueName: "not-ours" } }
  );
  const logged = [];
  server.logger = silentLogger(logged);

  await listen(server);
  await listen(server);
  assert.deepEqual(fake.receivers.map(({ args }) => args[0]), ["jobs"]);
  assert.deepEqual(
    logged.map(({ level }) => level),
    ["debug", "debug", "debug", "debug"]
  );
  assert.match(String(logged[0].args[0]), /plain-string/);
  await server.close();
});

test("bindEvents() still fails, clearly, on this transport's handlers it cannot read", async () => {
  const cases = [
    // metaOptions without an entity.
    [{ type: "queue", metaOptions: { receiveMode: "peekLock" } }, {}, /needs a "queueName", or a "topic" and a "subscription"/],
    // metaOptions that is not an object.
    [{ type: "queue", metaOptions: "jobs" }, {}, /has no Azure Service Bus options/],
    // From @Queue/@Subscription (marked in the handler's extras), but not JSON:
    // a factory, or an option set to undefined.
    [
      { type: "queue", metaFactory: () => ({ queueName: "jobs" }) },
      { [SB_SUBSCRIBER_EXTRA]: true },
      /Cannot read the Azure Service Bus options/,
    ],
    [
      { type: "queue", metaOptions: { queueName: "jobs", subQueueType: undefined } },
      { [SB_SUBSCRIBER_EXTRA]: true },
      /Cannot read the Azure Service Bus options/,
    ],
  ];
  for (const [pattern, extras, error] of cases) {
    const fake = fakeServiceBusClient();
    const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
    server.createServiceBusClient = () => fake.client;
    server.logger = silentLogger();
    server.addHandler(pattern, async () => {}, true, extras);
    await assert.rejects(listen(server), error);
    assert.equal(fake.closed, true);
  }
});

test("server processError resolves (the SDK awaits it)", async () => {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  const logged = [];
  server.logger = { error: (...args) => logged.push(args) };
  const { processError } = server.createMessageHandlers("p");

  const result = await Promise.race([
    processError({ error: new Error("boom"), errorSource: "receive", entityPath: "q" }).then(
      () => "resolved"
    ),
    new Promise((resolve) => setTimeout(resolve, 200, "pending").unref()),
  ]);
  assert.equal(result, "resolved");
  assert.match(String(logged[0][0]), /receive error on "q": boom/);
});

test("server completes peekLock messages after the handler unless told not to", async () => {
  for (const [options, expected] of [
    [{}, 1],
    [{ autoCompleteMessages: false }, 0],
  ]) {
    const fake = fakeServiceBusClient();
    const server = serverWith(fake, {
      type: "queue",
      metaOptions: { queueName: "q", receiveMode: "peekLock", options },
    });
    await listen(server);
    const receiver = fake.receivers[0];
    const completed = [];
    receiver.completeMessage = async (message) => completed.push(message);

    await receiver.handlers.processMessage({ body: {}, messageId: "m" });
    assert.equal(completed.length, expected, JSON.stringify(options));
    await server.close();
  }
});

/**
 * Listens with one @Queue handler and returns the fake receiver, with the
 * settlements it gets recorded.
 */
async function listeningWith(handler, metaOptions, serverOptions = {}) {
  const fake = fakeServiceBusClient();
  const logged = [];
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING, ...serverOptions });
  server.logger = silentLogger(logged);
  server.createServiceBusClient = () => fake.client;
  server.addHandler({ type: "queue", metaOptions: { queueName: "q", ...metaOptions } }, handler, true);
  await listen(server);
  const receiver = fake.receivers[0];
  receiver.completed = [];
  receiver.abandoned = [];
  receiver.deadLettered = [];
  receiver.completeMessage = async (message) => receiver.completed.push(message);
  receiver.abandonMessage = async (message) => receiver.abandoned.push(message);
  receiver.deadLetterMessage = async (message, options) =>
    receiver.deadLettered.push({ message, options });
  return { server, receiver, logged, fake };
}

test("an event handler that throws gets its peekLock message abandoned, not completed", async () => {
  const { throwError } = require("rxjs");
  const failures = [
    async () => {
      throw new Error("handler failed");
    },
    // What Nest's exception filter returns for an error thrown in a handler.
    async () => throwError(() => ({ status: "error", message: "Internal server error" })),
  ];
  for (const handler of failures) {
    const { server, receiver, logged } = await listeningWith(handler, { receiveMode: "peekLock" });
    const message = { body: {}, messageId: "m-1" };
    await receiver.handlers.processMessage(message);
    assert.deepEqual(receiver.abandoned, [message]);
    assert.deepEqual(receiver.completed, []);
    assert.match(String(logged.find((e) => e.level === "warn")?.args[0]), /m-1.*abandoned/);
    await server.close();
  }
});

test("an event handler error abandons nothing in receiveAndDelete or once the handler settled", async () => {
  const fail = async () => {
    throw new Error("handler failed");
  };
  const deleted = await listeningWith(fail, { receiveMode: "receiveAndDelete" });
  deleted.receiver.receiveMode = "receiveAndDelete";
  await deleted.receiver.handlers.processMessage({ body: {}, messageId: "m-1" });
  assert.deepEqual(deleted.receiver.abandoned, []);
  assert.match(String(deleted.logged.find((e) => e.level === "error")?.args[0]), /m-1/);
  await deleted.server.close();

  const settled = await listeningWith(fail, { receiveMode: "peekLock" });
  await settled.receiver.handlers.processMessage({
    body: {},
    messageId: "m-2",
    delivery: { remote_settled: true }, // e.g. the handler dead-lettered it, then threw
  });
  assert.deepEqual(settled.receiver.abandoned, []);
  assert.deepEqual(settled.receiver.completed, []);
  await settled.server.close();
});

test("the message is completed only once the handler's Observable completes", async () => {
  const { Subject } = require("rxjs");
  const work = new Subject();
  const { server, receiver } = await listeningWith(async () => work, { receiveMode: "peekLock" });
  const processing = receiver.handlers.processMessage({ body: {}, messageId: "m-1" });
  await ticks();
  assert.deepEqual(receiver.completed, []);
  work.next("progress");
  work.complete();
  await processing;
  assert.equal(receiver.completed.length, 1);
  await server.close();
});

test("@Queue stores queue metadata and an event pattern", () => {
  const options = { queueName: "jobs", receiveMode: "peekLock" };
  class Handlers {
    onJob() {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(Handlers.prototype, "onJob");
  Queue(options)(Handlers.prototype, "onJob", descriptor);

  const [stored] = Reflect.getMetadata(SB_SUBSCRIBER_METADATA, Handlers.prototype);
  assert.equal(stored.metadata.type, "queue");
  assert.deepEqual(stored.metadata.metaOptions, options);
  const [pattern] = Reflect.getMetadata(PATTERN_METADATA, descriptor.value);
  assert.deepEqual(pattern.metaOptions, options);
});

test("the context exposes the receiver and the message", () => {
  const receiver = {};
  const message = {};
  const ctx = new AzureServiceBusContext([receiver, message]);
  assert.equal(ctx.getReceiver(), receiver);
  assert.equal(ctx.getMessage(), message);
  assert.equal(ctx.getArgs()[0], receiver);
});

test("the published typings do not import @azure/core-amqp (not a dependency)", () => {
  const { readdirSync, readFileSync } = require("node:fs");
  const path = require("node:path");
  const dist = path.join(__dirname, "..", "dist");
  const typings = readdirSync(dist, { recursive: true }).filter((f) => f.endsWith(".d.ts"));
  assert.ok(typings.length > 0);
  for (const file of typings) {
    const source = readFileSync(path.join(dist, file), "utf8");
    assert.doesNotMatch(source, /(from\s+|import\()["']@azure\/core-amqp["']/, file);
  }
});


test("every package the published code and typings import is a declared peer dependency", () => {
  const { readdirSync, readFileSync } = require("node:fs");
  const { builtinModules } = require("node:module");
  const path = require("node:path");
  const pkg = require("../package.json");
  const declared = new Set([
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.dependencies ?? {}),
  ]);
  const dist = path.join(__dirname, "..", "dist");
  const files = readdirSync(dist, { recursive: true }).filter(
    (f) => f.endsWith(".js") || f.endsWith(".d.ts")
  );
  const undeclared = new Set();
  for (const file of files) {
    const source = readFileSync(path.join(dist, file), "utf8");
    const specifiers = source.matchAll(/(?:require\(|from\s+|import\()["']([^"'.][^"']*)["']/g);
    for (const [, specifier] of specifiers) {
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (builtinModules.includes(name.replace(/^node:/, ""))) continue;
      if (!declared.has(name)) undeclared.add(`${name} (${file})`);
    }
  }
  assert.deepEqual([...undeclared], []);
});

// --- Request ids ------------------------------------------------------------

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Sends `n` requests and returns the request ids they carried. */
async function requestIds(n) {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  const subscriptions = Array.from({ length: n }, () =>
    client.send({ name: "rpc" }, { body: 1 }).subscribe({ error: () => {} })
  );
  await ticks();
  const ids = sdk.senders.map((sender) => sender.sent[0].messages[0].applicationProperties[SB_REQUEST_ID_PROPERTY]);
  for (const subscription of subscriptions) subscription.unsubscribe();
  return ids;
}

/** True if `b` starts with what is left of `a` after its first character (uid(21)). */
const slidesFrom = (a, b) => a.slice(1) === b.slice(0, a.length - 1);

test("request ids are random UUIDs with the installed NestJS", async () => {
  const ids = await requestIds(5);
  assert.equal(new Set(ids).size, 5);
  for (const id of ids) assert.match(id, UUID_V4);
  for (let i = 1; i < ids.length; i++) assert.ok(!slidesFrom(ids[i - 1], ids[i]), ids.join(" "));
});

test("request ids do not come from NestJS's assignPacketId (Math.random in NestJS 10)", async () => {
  const { ClientProxy } = require("@nestjs/microservices");
  const original = ClientProxy.prototype.assignPacketId;
  let n = 0;
  // What NestJS 10 does, made obvious: each id is the previous one shifted.
  ClientProxy.prototype.assignPacketId = function (packet) {
    return Object.assign(packet, { id: `predictable-${n++}` });
  };
  try {
    const ids = await requestIds(3);
    for (const id of ids) assert.match(id, UUID_V4);
  } finally {
    ClientProxy.prototype.assignPacketId = original;
  }
});

// --- Option checks ----------------------------------------------------------

test("replyTimeoutInMs out of a timer's range throws a RangeError", () => {
  for (const replyTimeoutInMs of [2 ** 31, -1, Number.NaN, "100", -Infinity]) {
    assert.throws(
      () => new AzureServiceBusClient({ connectionString: CONNECTION_STRING, replyTimeoutInMs }),
      RangeError,
      String(replyTimeoutInMs)
    );
  }
  for (const replyTimeoutInMs of [undefined, 0, 1, 2 ** 31 - 1, Infinity]) {
    new AzureServiceBusClient({ connectionString: CONNECTION_STRING, replyTimeoutInMs });
  }
});

test("replyTimeoutInMs: 0 or Infinity sets no timer", async () => {
  for (const replyTimeoutInMs of [0, Infinity]) {
    const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING, replyTimeoutInMs });
    client.logger = silentLogger();
    const sdk = fakeClientSdk();
    client.sbClient = sdk;
    const a = collect(client.send({ name: "rpc" }, { body: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(a.events, [], String(replyTimeoutInMs));
    await client.close();
  }
});

test("a finished send() leaves no timer behind: the process exits at once", async () => {
  const { spawn } = require("node:child_process");
  const path = require("node:path");
  const child = spawn(process.execPath, [path.join(__dirname, "reply-timer-exit.js")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000, "still running").unref()),
  ]);
  if (outcome === "still running") child.kill("SIGKILL");
  assert.equal(outcome, 0, output);
  assert.match(output, /^reply=ok$/m);
});

test("server options out of range throw when the server is created", () => {
  for (const closeTimeoutInMs of [2 ** 31, -1, Number.NaN, "5"]) {
    assert.throws(
      () => new AzureServiceBusServer({ connectionString: CONNECTION_STRING, closeTimeoutInMs }),
      RangeError
    );
  }
  for (const replyTimeToLiveInMs of [0, -5, Number.NaN, "60000"]) {
    assert.throws(
      () => new AzureServiceBusServer({ connectionString: CONNECTION_STRING, replyTimeToLiveInMs }),
      RangeError
    );
  }
  for (const allowedReplyTo of ["orders.reply", [1], {}]) {
    assert.throws(
      () => new AzureServiceBusServer({ connectionString: CONNECTION_STRING, allowedReplyTo }),
      TypeError
    );
  }
});

// --- Reply receiver errors --------------------------------------------------

/** Starts a send() and hands its reply receiver's processError to `fn`. */
async function withPendingSend(fn) {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = silentLogger(logged);
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  const a = collect(client.send({ name: "rpc" }, { body: 1 }));
  await ticks();
  await fn(sdk.receivers[0].handlers.processError);
  await ticks();
  return { a, client, logged };
}

test("a receive error the SDK marks as not retryable fails the waiting send()", async () => {
  // What a receiver without sessions gets on a reply queue with sessions.
  const error = new ServiceBusError(
    "It is not possible for an entity that requires sessions to create a non-sessionful message receiver.",
    "GeneralError"
  );
  error.retryable = false;
  const { a, client, logged } = await withPendingSend((processError) =>
    processError({ error, errorSource: "receive", entityPath: "rpc.reply" })
  );
  await a.done;
  assert.equal(a.events[0][0], "error");
  assert.equal(a.events[0][1], error);
  assert.match(String(logged[0].args[0]), /must not have sessions enabled/);
  await client.close();
});

test("retryable receive errors and errors of the reply callback do not fail the waiting send()", async () => {
  const busy = new ServiceBusError("busy", "ServiceBusy");
  busy.retryable = true;
  const lockLost = new ServiceBusError("lock lost", "MessageLockLost");
  lockLost.retryable = false;
  const { a, client } = await withPendingSend(async (processError) => {
    await processError({ error: busy, errorSource: "receive", entityPath: "rpc.reply" });
    await processError({ error: lockLost, errorSource: "processMessageCallback", entityPath: "rpc.reply" });
    await processError({ error: lockLost, errorSource: "complete", entityPath: "rpc.reply" });
  });
  assert.deepEqual(a.events, []);
  await client.close();
});

// --- Replies that are not this client's -------------------------------------

test("a reply whose correlationId is not a request id is dead-lettered at once", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = silentLogger(logged);
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  client.send({ name: "rpc" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  const receiver = sdk.receivers[0];
  const junk = [undefined, "junk", 42, "x".repeat(36), "abcdef0123456789abcdeZ"].map((id) =>
    replyMessage(id, "junk", RESPONSE_END)
  );
  for (const message of junk) await receiver.handlers.processMessage(message);
  assert.deepEqual(
    receiver.deadLettered.map((d) => d.message),
    junk
  );
  assert.equal(receiver.deadLettered[0].options.deadLetterReason, "InvalidCorrelationId");
  assert.deepEqual(receiver.abandoned, []);
  // Ids of other clients (1.2.0: UUID; 1.1.0 on NestJS 10: 21 hex) bounce.
  const others = [randomUUID(), randomUUID().toUpperCase(), "0123456789abcdef01234"].map((id) =>
    replyMessage(id, "other", RESPONSE_END)
  );
  for (const message of others) await receiver.handlers.processMessage(message);
  assert.deepEqual(receiver.abandoned, others);
  await client.close();
});

test("the warning about replies that are not this client's is rate-limited", async () => {
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const logged = [];
  client.logger = silentLogger(logged);
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  client.send({ name: "rpc" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  for (let i = 0; i < 10; i++) {
    await sdk.receivers[0].handlers.processMessage(replyMessage(randomUUID(), "other", RESPONSE_END));
    await sdk.receivers[0].handlers.processMessage(replyMessage(`junk-${i}`, "junk", RESPONSE_END));
  }
  assert.equal(sdk.receivers[0].abandoned.length, 10);
  assert.equal(sdk.receivers[0].deadLettered.length, 10);
  assert.equal(logged.filter((e) => e.level === "warn").length, 1);
  await client.close();
});

test("values from a message are escaped in the logs (no forged log lines)", async () => {
  const forged = "x\n[Nest] 1  - LOG [Fake] forged line";
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  const clientLogs = [];
  client.logger = silentLogger(clientLogs);
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  client.send({ name: "rpc" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  await sdk.receivers[0].handlers.processMessage(replyMessage(forged, "junk", RESPONSE_END));
  await client.close();

  const { server, receiver, logged: serverLogs } = await listeningWith(
    async () => {
      throw new Error("failed");
    },
    { receiveMode: "peekLock" },
    { allowedReplyTo: ["rpc.reply"] }
  );
  await receiver.handlers.processMessage({ body: 1, messageId: forged, replyTo: forged });
  await receiver.handlers.processMessage({ body: 1, messageId: forged });
  await server.close();

  const lines = [...clientLogs, ...serverLogs].map((e) => String(e.args[0]));
  assert.ok(lines.length >= 3, JSON.stringify(lines));
  for (const line of lines) assert.doesNotMatch(line, /\n/, line);
  assert.ok(lines.some((line) => line.includes(JSON.stringify(forged))), JSON.stringify(lines));
});

// --- Who the server replies to (allowedReplyTo) -----------------------------

test("by default the server replies to any replyTo (as 1.1.0)", async () => {
  const { server, replies } = replyingServer(async () => "ok");
  await server.handleMessage({ body: null, messageId: "m-1", replyTo: "anything" }, "rpc-pattern");
  assert.equal(replies[0].entity, "anything");
});

test("allowedReplyTo: a request whose replyTo is not allowed gets no reply and is dead-lettered", async () => {
  const calls = [];
  const { server, receiver, logged, fake } = await listeningWith(
    async (message) => {
      calls.push(message);
      return "ok";
    },
    { receiveMode: "peekLock" },
    { allowedReplyTo: ["Orders.Reply"] }
  );
  const sent = [];
  fake.client.createSender = (entity) => ({
    sendMessages: async (messages) => sent.push({ entity, messages }),
    close: async () => {},
  });
  server.sbClient = fake.client;

  const allowed = { body: 1, messageId: "m-1", replyTo: "orders.reply" };
  const denied = { body: 2, messageId: "m-2", replyTo: "billing-commands", replyToSessionId: "victim" };
  await receiver.handlers.processMessage(allowed);
  await receiver.handlers.processMessage(denied);

  assert.deepEqual(calls, [allowed]);
  assert.deepEqual(sent.map((s) => s.entity), ["orders.reply"]);
  assert.deepEqual(receiver.completed, [allowed]);
  assert.deepEqual(receiver.deadLettered.map((d) => d.message), [denied]);
  assert.equal(receiver.deadLettered[0].options.deadLetterReason, "ReplyToNotAllowed");
  const warning = logged.find((e) => e.level === "warn");
  assert.match(String(warning.args[0]), /"billing-commands".*"victim".*not allowed/);
  await server.close();
});

test("allowedReplyTo as a function, and a function that throws denies", async () => {
  const seen = [];
  const check = (replyTo, message) => {
    seen.push([replyTo, message.messageId]);
    if (replyTo === "boom") throw new Error("check failed");
    return replyTo.startsWith("tenant-a.");
  };
  const { server, replies } = replyingServer(async () => "ok", { allowedReplyTo: check });
  for (const replyTo of ["tenant-a.reply", "tenant-b.reply", "boom"]) {
    await server.handleMessage({ body: null, messageId: replyTo, replyTo }, "rpc-pattern");
  }
  assert.deepEqual(replies.map((r) => r.entity), ["tenant-a.reply"]);
  assert.deepEqual(seen.map(([replyTo]) => replyTo), ["tenant-a.reply", "tenant-b.reply", "boom"]);
});

test("allowedReplyTo copies the list it is given", async () => {
  const list = ["a.reply"];
  const { server, replies } = replyingServer(async () => "ok", { allowedReplyTo: list });
  list.push("b.reply");
  await server.handleMessage({ body: null, messageId: "m", replyTo: "b.reply" }, "rpc-pattern");
  assert.deepEqual(replies, []);
});

// --- Streamed responses -----------------------------------------------------

test("server sends a value as soon as it is emitted, even if the response never completes", async () => {
  const { Observable } = require("rxjs");
  const { server, replies } = replyingServer(
    async () => new Observable((subscriber) => subscriber.next("first"))
  );
  server.handleMessage(requestFrom120(), "rpc-pattern");
  await ticks();
  assert.deepEqual(
    replies.map((r) => [r.body, r.applicationProperties[SB_REPLY_TYPE_PROPERTY], r.applicationProperties[SB_REPLY_DISPOSED_PROPERTY]]),
    [["first", "response", false]]
  );
});

test("server streams progress values one by one and ends with a reply of its own", async () => {
  const { Subject } = require("rxjs");
  const progress = new Subject();
  const { server, replies } = replyingServer(async () => progress);
  server.handleMessage(requestFrom120(), "rpc-pattern");
  await ticks();
  const shape = () =>
    replies.map((r) => [r.body, r.applicationProperties[SB_REPLY_TYPE_PROPERTY], r.applicationProperties[SB_REPLY_DISPOSED_PROPERTY]]);
  for (const [i, value] of ["10%", "50%", "100%"].entries()) {
    progress.next(value);
    await ticks();
    assert.equal(replies.length, i + 1, `"${value}" was not sent before the next value`);
  }
  progress.complete();
  await ticks();
  assert.deepEqual(shape(), [
    ["10%", "response", false],
    ["50%", "response", false],
    ["100%", "response", false],
    [undefined, "none", true],
  ]);
});

test("server sends the error of a response after the values already sent", async () => {
  const { Subject } = require("rxjs");
  const values = new Subject();
  const { server, replies } = replyingServer(async () => values);
  server.handleMessage(requestFrom120(), "rpc-pattern");
  await ticks();
  values.next(1);
  await ticks();
  values.error({ status: "error", message: "late failure" });
  await ticks();
  assert.deepEqual(
    replies.map((r) => [r.body, r.applicationProperties[SB_REPLY_TYPE_PROPERTY], r.applicationProperties[SB_REPLY_DISPOSED_PROPERTY]]),
    [
      [1, "response", false],
      [{ status: "error", message: "late failure" }, "error", true],
    ]
  );
});

test("replyTimeToLiveInMs sets the time to live of the replies; none by default", async () => {
  const withTtl = replyingServer(async () => "ok", { replyTimeToLiveInMs: 60_000 });
  await withTtl.server.handleMessage({ body: null, messageId: "m", replyTo: "rpc.reply" }, "rpc-pattern");
  assert.equal(withTtl.replies[0].timeToLive, 60_000);

  const byDefault = replyingServer(async () => "ok");
  await byDefault.server.handleMessage({ body: null, messageId: "m", replyTo: "rpc.reply" }, "rpc-pattern");
  assert.equal("timeToLive" in byDefault.replies[0], false);
});

// --- Shutdown ---------------------------------------------------------------

test("server close() stops waiting for handlers after closeTimeoutInMs and closes the receivers", async () => {
  const { NEVER } = require("rxjs");
  for (const handler of [async () => new Promise(() => {}), async () => NEVER]) {
    const { server, receiver, logged, fake } = await listeningWith(
      handler,
      { receiveMode: "peekLock" },
      { closeTimeoutInMs: 100 }
    );
    receiver.handlers.processMessage({ body: {}, messageId: "m-1" });
    await ticks();
    const started = Date.now();
    const outcome = await Promise.race([
      server.close().then(() => "closed"),
      new Promise((resolve) => setTimeout(resolve, 3000, "still waiting").unref()),
    ]);
    assert.equal(outcome, "closed");
    assert.ok(Date.now() - started >= 90);
    assert.equal(receiver.closed, true);
    assert.equal(fake.closed, true);
    assert.deepEqual(receiver.completed, []);
    assert.match(String(logged.find((e) => e.level === "warn")?.args[0]), /closeTimeoutInMs.*1 message handler/);
  }
});

test("server close() waits 25 s by default, and for ever with Infinity", () => {
  assert.equal(new AzureServiceBusServer({ connectionString: CONNECTION_STRING }).closeTimeoutInMs, 25_000);
  assert.equal(
    new AzureServiceBusServer({ connectionString: CONNECTION_STRING, closeTimeoutInMs: Infinity }).closeTimeoutInMs,
    Infinity
  );
});

test("server close() leaves no timer behind when the handlers finish in time", async () => {
  const { server, receiver } = await listeningWith(async () => {}, { receiveMode: "peekLock" }, {
    closeTimeoutInMs: 60_000,
  });
  await receiver.handlers.processMessage({ body: {}, messageId: "m-1" });
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await server.close();
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before, `${before} -> ${after}`);
});

// --- close() and the SDK's link attach ----------------------------------------

/**
 * Makes `receiver` behave like the SDK's while it attaches a link: close()
 * waits for the attach to finish (it takes the link's lock), and the attach
 * records whether the abort signal had fired by the time it finished, which
 * is when @azure/service-bus 7.9.x checks it and, if it fired, closes the new
 * link without handling its error (an unhandled rejection when the entity
 * rejects the link). Returns `finish()`, which ends the attach, and `result`.
 */
function attachInProgress(receiver) {
  const signal = receiver.subscribeOptions.abortSignal;
  let finish;
  const result = {};
  const attaching = new Promise((resolve) => (finish = resolve)).then(() => {
    result.abortedWhenAttached = signal.aborted;
  });
  const close = receiver.close;
  receiver.close = async () => {
    await attaching;
    await close.call(receiver);
  };
  return { finish, result, signal };
}

test("server close() cancels the SDK's retries only once no link is being attached", async () => {
  const fake = fakeServiceBusClient();
  const server = serverWith(fake, {
    type: "queue",
    metaOptions: { queueName: "missing", receiveMode: "peekLock" },
  });
  await listen(server);
  const receiver = fake.receivers[0];
  const { finish, result, signal } = attachInProgress(receiver);

  const closing = server.close();
  await ticks();
  finish();
  await closing;
  assert.equal(result.abortedWhenAttached, false, "close() aborted while the SDK attached a link");
  assert.equal(signal.aborted, true, "close() did not cancel the SDK's retries");
  assert.equal(receiver.closed, true);
  assert.equal(fake.closed, true);
});

test("server close() logs, and does not throw, a connection that fails to close", async () => {
  const fake = fakeServiceBusClient();
  const logged = [];
  const server = serverWith(fake, { type: "queue", metaOptions: { queueName: "q" } });
  server.logger = silentLogger(logged);
  // What rhea (under the SDK) rejects with: a plain AMQP error, not an Error.
  const amqpError = { condition: "amqp:not-found", description: "The entity could not be found" };
  fake.client.close = async () => {
    throw amqpError;
  };
  await listen(server);
  fake.receivers[0].close = async () => {
    throw amqpError;
  };

  await server.close();
  const errors = logged.filter((e) => e.level === "error").map((e) => String(e.args[0]));
  assert.equal(errors.length, 2, errors.join("\n"));
  assert.match(errors[0], /Could not close an Azure Service Bus receiver: .*amqp:not-found/);
  assert.match(errors[1], /Could not close the Azure Service Bus connection: .*amqp:not-found/);
  assert.throws(() => server.unwrap(), /Not initialized/);
  assert.equal(server.receivers.size, 0);
});

// --- What util.inspect() shows ------------------------------------------------

test("util.inspect() of the client and the server does not show the connection string's key", async () => {
  const util = require("node:util");
  const secret = "c2VjcmV0LWtleS10aGF0LW11c3Qtbm90LWxlYWs=";
  // .invalid never resolves; nothing here connects anyway.
  const connectionString = `Endpoint=sb://example.invalid/;SharedAccessKeyName=app;SharedAccessKey=${secret}`;
  const { ServiceBusClient } = require("@azure/service-bus");
  // A connected-looking client: an SDK client (it holds the key) and a
  // request waiting on a reply receiver.
  const client = new AzureServiceBusClient({ connectionString });
  client.logger = silentLogger();
  const sdk = fakeClientSdk();
  client.sbClient = sdk;
  client.send({ name: "rpc" }, { body: 1 }).subscribe({ error: () => {} });
  await ticks();
  sdk.receivers[0].credentials = new ServiceBusClient(connectionString);
  client.sbClient = new ServiceBusClient(connectionString);
  const server = new AzureServiceBusServer({ connectionString });
  server.sbClient = new ServiceBusClient(connectionString);
  for (const target of [client, server]) {
    for (const depth of [2, Infinity]) {
      const shown = util.inspect(target, { depth, showHidden: false });
      assert.ok(!shown.includes(secret), shown);
      assert.match(shown, /SharedAccessKey=<redacted>/);
      assert.match(shown, /SharedAccessKeyName=app/);
    }
    assert.ok(!require("node:util").format("%o", target).includes(secret));
    // The code (and subclasses) still read the real options.
    assert.equal(target.options.connectionString, connectionString);
  }
  class MyServer extends AzureServiceBusServer {
    connection() {
      return this.options.connectionString;
    }
  }
  const mine = new MyServer({ connectionString });
  assert.equal(mine.connection(), connectionString);
  assert.match(util.inspect(mine), /^MyServer /);
  assert.match(util.inspect(client), /ReplyRouter \{ waiting: \{ "rpc.reply": 1 \}/);
  client.sbClient = sdk;
  await client.close();
  await server.sbClient.close();
});

test("a streamed request is completed once its first reply is out, and close() waits for the rest", async () => {
  const { Subject } = require("rxjs");
  const values = new Subject();
  const { server, receiver } = await listeningWith(async () => values, { receiveMode: "peekLock" });
  const replies = [];
  server.sbClient = {
    ...server.sbClient,
    createSender: () => ({ sendMessages: async (m) => replies.push(...m), close: async () => {} }),
  };
  const request = requestFrom120();
  const processing = receiver.handlers.processMessage(request);
  await ticks();
  assert.deepEqual(receiver.completed, [], "completed before any reply");
  values.next("first");
  await processing; // the receiver can take the next message
  assert.deepEqual(receiver.completed, [request]);

  let closed = false;
  const closing = server.close().then(() => (closed = true));
  await ticks();
  assert.equal(closed, false, "close() did not wait for the rest of the response");
  values.next("second");
  values.complete();
  await closing;
  // "second" and the end came in the same tick: one reply.
  assert.deepEqual(replyShape(replies), [
    ["first", "response", false],
    ["second", "response", true],
  ]);
});

// --- Streams that close() cuts, and replies that cannot be sent ---------------

/**
 * Listens with one peekLock @Queue handler whose replies are recorded (or
 * sent with `sendMessages`, when given).
 */
async function listeningWithReplies(handler, serverOptions = {}, sendMessages) {
  const listening = await listeningWith(handler, { receiveMode: "peekLock" }, serverOptions);
  const replies = [];
  listening.fake.client.createSender = (entity) => ({
    sendMessages:
      sendMessages ?? (async (messages) => replies.push(...messages.map((m) => ({ entity, ...m })))),
    close: async () => {},
  });
  return { ...listening, replies };
}

/** An endless response that records how often it emits and whether it is torn down. */
function endlessResponse(periodMs = 20) {
  const { interval, finalize, tap } = require("rxjs");
  const state = { emitted: 0, tornDown: false };
  state.observable = interval(periodMs).pipe(
    tap(() => state.emitted++),
    finalize(() => (state.tornDown = true))
  );
  return state;
}

const activeTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

test("close() cancels an endless streamed response after closeTimeoutInMs", async () => {
  const endless = endlessResponse();
  const timersBefore = activeTimers();
  const { server, receiver, logged, replies } = await listeningWithReplies(
    async () => endless.observable,
    { closeTimeoutInMs: 100 }
  );
  const request = requestFrom120();
  await receiver.handlers.processMessage(request); // resolves after the first reply
  assert.deepEqual(receiver.completed, [request]);

  await server.close();
  assert.equal(endless.tornDown, true, "the response is still subscribed after close()");
  assert.equal(server.inFlight.size, 0);
  const emitted = endless.emitted;
  const sent = replies.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(endless.emitted, emitted, "the handler kept emitting after close()");
  assert.equal(replies.length, sent);
  assert.ok(activeTimers() <= timersBefore, `${timersBefore} -> ${activeTimers()} timers`);

  // The request was completed: the warning must not say it comes back.
  const warning = String(logged.find((e) => e.level === "warn")?.args[0]);
  assert.match(warning, /closeTimeoutInMs/);
  assert.match(warning, /1 streamed response\(s\) cancelled.*already completed/);
  assert.doesNotMatch(warning, /delivers them again/);
});

test("close() cancels a response that has not replied yet, and leaves its message unsettled", async () => {
  const { NEVER, finalize } = require("rxjs");
  let tornDown = false;
  const { server, receiver, logged, replies } = await listeningWithReplies(
    async () => NEVER.pipe(finalize(() => (tornDown = true))),
    { closeTimeoutInMs: 50 }
  );
  const processing = receiver.handlers.processMessage(requestFrom120());
  await ticks();
  await server.close();
  await processing;
  assert.equal(tornDown, true);
  assert.deepEqual(replies, []);
  // Not completed nor abandoned (the receiver is closing): back when its lock expires.
  assert.deepEqual(receiver.completed, []);
  assert.deepEqual(receiver.abandoned, []);
  const warning = String(logged.find((e) => e.level === "warn")?.args[0]);
  assert.match(warning, /1 message handler\(s\) still running.*delivers them again once their lock expires/);
  assert.doesNotMatch(warning, /streamed response/);
});

test("after a close() that gave up, a new listen() + close() does not wait for the old handlers", async () => {
  const { server, receiver, logged } = await listeningWithReplies(
    async () => new Promise(() => {}), // never settles
    { closeTimeoutInMs: 50 }
  );
  receiver.handlers.processMessage({ body: {}, messageId: "m-1" });
  await ticks();
  await server.close();
  assert.equal(server.inFlight.size, 0);

  await listen(server);
  logged.length = 0;
  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started < 40, `the second close() took ${Date.now() - started} ms`);
  assert.deepEqual(logged.filter((e) => e.level === "warn"), []);
});

test("a response a handler returns after close() gave up is not subscribed", async () => {
  const endless = endlessResponse();
  let release;
  const { server, receiver, replies } = await listeningWithReplies(
    () => new Promise((resolve) => (release = () => resolve(endless.observable))),
    { closeTimeoutInMs: 30 }
  );
  const processing = receiver.handlers.processMessage(requestFrom120());
  await ticks();
  await server.close();
  release();
  await processing;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(endless.emitted, 0, "the late response was subscribed");
  assert.deepEqual(replies, []);
  assert.deepEqual(receiver.completed, []);
});

test("the process exits on its own after close() cuts an endless response", async () => {
  const { spawn } = require("node:child_process");
  const path = require("node:path");
  const child = spawn(process.execPath, [path.join(__dirname, "close-stream-exit.js")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000, "still running").unref()),
  ]);
  if (outcome === "still running") child.kill("SIGKILL");
  assert.equal(outcome, 0, output);
  assert.match(output, /^closed$/m);
});

test("a 1.1.0 client's single reply ends the response: close() does not wait for the rest", async () => {
  const endless = endlessResponse();
  const { server, receiver, logged, replies } = await listeningWithReplies(
    async () => endless.observable,
    { closeTimeoutInMs: 1_000 }
  );
  const legacy = { body: null, messageId: "m-110", replyTo: "rpc.reply" };
  await receiver.handlers.processMessage(legacy);
  assert.equal(endless.tornDown, true, "the response is still subscribed after its only reply");
  assert.deepEqual(replyShape(replies), [[0, "response", true]]);
  assert.deepEqual(receiver.completed, [legacy]);

  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started < 500, `close() took ${Date.now() - started} ms`);
  assert.deepEqual(logged.filter((e) => e.level === "warn"), []);
});

test("a reply that fails mid-stream is logged at once, cancels the response and sends the client an error", async () => {
  const { Subject, finalize } = require("rxjs");
  const values = new Subject();
  let tornDown = false;
  let sends = 0;
  const { server, receiver, logged, replies } = await listeningWithReplies(
    async () => values.pipe(finalize(() => (tornDown = true))),
    {},
    async (messages) => {
      if (++sends === 2) throw new Error("reply queue is busy");
      replies.push(...messages);
    }
  );
  const processing = receiver.handlers.processMessage(requestFrom120());
  await ticks();
  values.next(1);
  await processing;
  values.next(2); // fails
  await ticks(20);
  // Logged now, not when the (endless) response ends.
  const errors = logged.filter((e) => e.level === "error");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].args[0]), /Could not send the reply to "rpc.reply": reply queue is busy/);
  assert.match(String(errors[0].args[0]), /sent an error instead/);
  assert.equal(tornDown, true, "the response is still subscribed");
  assert.equal(values.observed, false);
  // The client gets the end of the response, as an error.
  assert.deepEqual(replyShape(replies), [
    [1, "response", false],
    [{ status: "error", message: "Internal server error" }, "error", true],
  ]);
  assert.equal(server.inFlight.size, 0);
  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started < 100, `close() took ${Date.now() - started} ms`);
});

test("when the error reply cannot be sent either, the failure is logged once and the response still ends", async () => {
  const { Subject } = require("rxjs");
  const values = new Subject();
  let sends = 0;
  const { server, receiver, logged, replies } = await listeningWithReplies(
    async () => values,
    {},
    async (messages) => {
      if (++sends >= 2) throw new Error("reply queue is gone");
      replies.push(...messages);
    }
  );
  const processing = receiver.handlers.processMessage(requestFrom120());
  await ticks();
  values.next(1);
  await processing;
  values.next(2);
  await ticks(20);
  assert.equal(sends, 3, "one value, the failed one, and one error reply");
  const errors = logged.filter((e) => e.level === "error");
  assert.equal(errors.length, 1);
  assert.match(String(errors[0].args[0]), /reply queue is gone.*could not be sent either.*replyTimeoutInMs/);
  assert.equal(values.observed, false);
  assert.equal(server.inFlight.size, 0);
  await server.close();
});

test("a failed reply to a 1.1.0 client gets no error reply after it (it would read it as its next answer)", async () => {
  const { of } = require("rxjs");
  let sends = 0;
  const { server, receiver, logged } = await listeningWithReplies(
    async () => of(1, 2),
    {},
    async () => {
      sends++;
      throw new Error("reply queue is gone");
    }
  );
  await receiver.handlers.processMessage({ body: null, messageId: "m-110", replyTo: "rpc.reply" });
  await ticks();
  assert.equal(sends, 1);
  assert.equal(logged.filter((e) => e.level === "error").length, 1);
  await server.close();
});

test("allowedReplyTo is called once per request", async () => {
  let calls = 0;
  const counting = await listeningWithReplies(async () => "ok", {
    allowedReplyTo: () => {
      calls++;
      return true;
    },
  });
  await counting.receiver.handlers.processMessage(requestFrom120());
  assert.equal(calls, 1);
  await counting.server.close();

  // A function that changes its mind cannot get a request completed unanswered.
  let k = 0;
  const flaky = await listeningWithReplies(async () => "ok", { allowedReplyTo: () => ++k === 1 });
  const request = requestFrom120();
  await flaky.receiver.handlers.processMessage(request);
  assert.equal(flaky.replies.length, 1);
  assert.deepEqual(flaky.receiver.completed, [request]);
  await flaky.server.close();
});

test("replyTimeToLiveInMs must be at least 1 ms", () => {
  for (const replyTimeToLiveInMs of [0.5, 0.999]) {
    assert.throws(
      () => new AzureServiceBusServer({ connectionString: CONNECTION_STRING, replyTimeToLiveInMs }),
      RangeError,
      String(replyTimeToLiveInMs)
    );
  }
  for (const replyTimeToLiveInMs of [1, 60_000, 2 ** 32 - 1, 1e15]) {
    assert.equal(
      new AzureServiceBusServer({ connectionString: CONNECTION_STRING, replyTimeToLiveInMs })
        .replyTimeToLiveInMs,
      replyTimeToLiveInMs
    );
  }
});

test("close() cancels an endless Observable of an event handler too", async () => {
  const endless = endlessResponse();
  const { server, receiver, logged } = await listeningWith(
    async () => endless.observable,
    { receiveMode: "peekLock" },
    { closeTimeoutInMs: 50 }
  );
  const processing = receiver.handlers.processMessage({ body: {}, messageId: "e-1" });
  await ticks();
  await server.close();
  await processing;
  assert.equal(endless.tornDown, true, "the event's Observable is still subscribed after close()");
  // Neither completed nor abandoned: delivered again once its lock expires.
  assert.deepEqual(receiver.completed, []);
  assert.deepEqual(receiver.abandoned, []);
  assert.match(String(logged.find((e) => e.level === "warn")?.args[0]), /1 message handler\(s\) still running/);
});
