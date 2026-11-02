"use strict";
// Unit tests against the compiled output in dist/ (run `npm run build` first,
// `npm test` does it). No Azure connection: ServiceBusClient is replaced by
// in-memory fakes assigned to the private `sbClient` field.
require("reflect-metadata");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lastValueFrom } = require("rxjs");
const { ServiceBusError } = require("@azure/service-bus");
const { PATTERN_METADATA } = require("@nestjs/microservices/constants");

const {
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
  const foreign = replyMessage("another-client-request", "not-yours", RESPONSE_END);
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
function replyingServer(handler) {
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
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

test("server answers a 1.1.0 client by messageId, and streams values with the end on the last one", async () => {
  const { of } = require("rxjs");
  const { server, replies } = replyingServer(async () => of(1, 2, 3));

  await server.handleMessage({ body: null, messageId: "m-1", replyTo: "rpc.reply" }, "rpc-pattern");

  assert.deepEqual(
    replies.map((r) => [r.correlationId, r.sessionId, r.body, r.applicationProperties[SB_REPLY_DISPOSED_PROPERTY]]),
    [
      ["m-1", undefined, 1, false],
      ["m-1", undefined, 2, false],
      ["m-1", undefined, 3, true],
    ]
  );
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
    const handling = server.handleMessage(
      { body: null, messageId: "m-1", replyTo: "rpc.reply" },
      "rpc-pattern"
    );
    await ticks();
    values.next(1);
    values.next(2); // the first reply is sent (and fails) while the response goes on
    await ticks(20);
    values.next(3);
    values.complete();
    await handling;
    await ticks();
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

  await server.handleMessage({ body: null, messageId: "m-1", replyTo: "rpc.reply" }, "rpc-pattern");

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
    "not-a-service-bus-pattern"
  );

  await assert.rejects(listen(server), /not-a-service-bus-pattern/);
  assert.equal(fake.receivers[0].closed, true);
  assert.equal(fake.closed, true);
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
async function listeningWith(handler, metaOptions) {
  const fake = fakeServiceBusClient();
  const logged = [];
  const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  server.logger = silentLogger(logged);
  server.createServiceBusClient = () => fake.client;
  server.addHandler({ type: "queue", metaOptions: { queueName: "q", ...metaOptions } }, handler, true);
  await listen(server);
  const receiver = fake.receivers[0];
  receiver.completed = [];
  receiver.abandoned = [];
  receiver.completeMessage = async (message) => receiver.completed.push(message);
  receiver.abandonMessage = async (message) => receiver.abandoned.push(message);
  return { server, receiver, logged };
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
