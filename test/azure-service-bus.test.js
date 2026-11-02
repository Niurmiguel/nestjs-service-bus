"use strict";
// Unit tests against the compiled output in dist/ (run `npm run build` first,
// `npm test` does it). No Azure connection: ServiceBusClient is replaced by
// in-memory fakes assigned to the private `sbClient` field.
require("reflect-metadata");

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lastValueFrom } = require("rxjs");
const { PATTERN_METADATA } = require("@nestjs/microservices/constants");

const {
  AzureServiceBusClient,
  AzureServiceBusContext,
  AzureServiceBusModule,
  AzureServiceBusServer,
  Subscription,
} = require("../dist");
const { SB_SUBSCRIBER_METADATA } = require("../dist/azure-service-bus.constants");

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

  // The pattern goes through a string round trip, so only JSON-safe options
  // survive (an AbortSignal, for instance, does not).
  const sendOptions = { tracingOptions: { tracingContext: null } };
  client.emit({ name: "orders", options: sendOptions }, { body: "hello" });
  await sender.done;

  assert.deepEqual(createdFor, ["orders"]);
  assert.equal(sender.sent.length, 1);
  assert.deepEqual(sender.sent[0].messages, { body: "hello" });
  assert.deepEqual(sender.sent[0].options, sendOptions);
  assert.equal(sender.closed, true);
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

test(
  "server.bindEvents keeps receivers open while listening",
  { todo: "bindEvents() closes each receiver right after subscribe(); see PR #205" },
  async () => {
    const server = new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
    let closed = false;
    server.sbClient = {
      createReceiver: () => ({
        subscribe: () => ({ close: async () => {} }),
        close: async () => {
          closed = true;
        },
      }),
    };
    server.addHandler(
      { type: "subscription", metaOptions: { topic: "t", subscription: "s" } },
      async () => {},
      true
    );

    await server.bindEvents();
    assert.equal(closed, false);
  }
);

test("the context exposes the receiver and the message", () => {
  const receiver = {};
  const message = {};
  const ctx = new AzureServiceBusContext([receiver, message]);
  assert.equal(ctx.getReceiver(), receiver);
  assert.equal(ctx.getMessage(), message);
  assert.equal(ctx.getArgs()[0], receiver);
});
