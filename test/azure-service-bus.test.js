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
  Queue,
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
