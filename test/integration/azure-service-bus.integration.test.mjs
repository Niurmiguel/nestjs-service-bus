// Integration tests against the Azure Service Bus emulator.
//
// Optional: `npm test` never runs them. `npm run test:integration` runs them
// and skips the whole suite when the emulator is not reachable, unless
// SB_EMULATOR_REQUIRED=1 (CI), where a missing emulator is a failure.
// How to start the emulator: see docker-compose.yml next to this file.
//
// The script runs with --test-force-exit. Without it this process sometimes
// lived two more minutes after the last test: rhea (the AMQP library under the
// SDK) re-armed its 120 s idle timer on a connection closed right after it
// opened. Leaks of this transport are still caught: the "exits on its own"
// test runs in a child process without that flag.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ServiceBusClient } = require("@azure/service-bus");
const { firstValueFrom } = require("rxjs");
const nestVersion = require("@nestjs/microservices/package.json").version;
const {
  AzureServiceBusClient,
  AzureServiceBusContext,
  AzureServiceBusServer,
  Queue,
  ReplyTimeoutError,
  Subscription,
} = require("../../dist");
const {
  CONNECTION_STRING,
  captureLogger,
  defineController,
  deferred,
  delay,
  emulatorAvailable,
  runId,
  startMicroservice,
  timeoutAfter,
} = require("./helpers.js");

const available = await emulatorAvailable();
const required = process.env.SB_EMULATOR_REQUIRED === "1";
if (!available && required) {
  throw new Error("SB_EMULATOR_REQUIRED=1 but the Service Bus emulator is not reachable");
}

describe(
  `Azure Service Bus emulator (NestJS ${nestVersion})`,
  { skip: !available && "Service Bus emulator not reachable" },
  () => {
    /**
     * Runs `fn` with its own raw SDK client, used to send test messages and to
     * inspect entities, so that no connection outlives a test.
     */
    async function withSdk(fn) {
      const sdk = new ServiceBusClient(CONNECTION_STRING);
      try {
        return await fn(sdk);
      } finally {
        await sdk.close();
      }
    }

    function sendRaw(entity, body, extra = {}) {
      return withSdk(async (sdk) => {
        const sender = sdk.createSender(entity);
        await sender.sendMessages({ body, ...extra });
        await sender.close();
      });
    }

    /** Messages still in `entity` that belong to this run (peek does not consume). */
    function remaining(entity) {
      return withSdk(async (sdk) => {
        const receiver = sdk.createReceiver(entity);
        const peeked = await receiver.peekMessages(50);
        await receiver.close();
        return peeked.filter((m) => m.body?.runId === runId);
      });
    }

    test("receives from a topic subscription with @Subscription", async () => {
      const got = deferred("a message on itest.topic/itest.sub");
      const controller = defineController({
        onOrder: {
          decorator: Subscription({
            topic: "itest.topic",
            subscription: "itest.sub",
            receiveMode: "receiveAndDelete",
          }),
          fn: (message, ctx) => {
            if (message.body?.runId === runId) got.resolve({ message, ctx });
          },
        },
      });
      const { app } = await startMicroservice(controller);
      try {
        await sendRaw("itest.topic", { runId, kind: "topic" });
        const { message, ctx } = await got.promise;
        assert.equal(message.body.kind, "topic");
        assert.ok(ctx instanceof AzureServiceBusContext);
      } finally {
        await app.close();
      }
    });

    test("keeps receiving when the SDK connection is already open at listen()", async () => {
      // A subclass may hand the server a client that has already connected
      // (createServiceBusClient() is public). Closing the receiver right after
      // subscribe() is only a no-op while the AMQP connection is still
      // opening; with an open connection it really closes the receiver.
      class SharedClientServer extends AzureServiceBusServer {
        createServiceBusClient() {
          return connected;
        }
      }
      const connected = new ServiceBusClient(CONNECTION_STRING);
      const probe = connected.createReceiver("itest.queue");
      await probe.peekMessages(1);
      await probe.close();

      const got = deferred("a message with an already connected client", 8_000);
      const controller = defineController({
        onOrder: {
          decorator: Subscription({
            topic: "itest.topic",
            subscription: "itest.sub",
            receiveMode: "receiveAndDelete",
          }),
          fn: (message) => {
            if (message.body?.runId === runId) got.resolve(message);
          },
        },
      });
      const strategy = new SharedClientServer({ connectionString: CONNECTION_STRING });
      const { app } = await startMicroservice(controller, { strategy });
      try {
        await sendRaw("itest.topic", { runId, kind: "preconnected" });
        const message = await got.promise;
        assert.equal(message.body.kind, "preconnected");
      } finally {
        await app.close();
        await connected.close();
        // Drain it if it was not received, so it does not leak into other tests.
        await withSdk(async (sdk) => {
          const drain = sdk.createReceiver("itest.topic", "itest.sub", {
            receiveMode: "receiveAndDelete",
          });
          await drain.receiveMessages(10, { maxWaitTimeInMs: 1000 });
          await drain.close();
        });
      }
    });

    test("receives from a queue with @Queue and honours receiveAndDelete", async () => {
      const got = deferred("a message on itest.queue");
      const controller = defineController({
        onJob: {
          decorator: Queue({ queueName: "itest.queue", receiveMode: "receiveAndDelete" }),
          fn: (message) => {
            if (message.body?.runId === runId) got.resolve(message);
          },
        },
      });
      const { app } = await startMicroservice(controller);
      try {
        await sendRaw("itest.queue", { runId, kind: "queue" });
        const message = await got.promise;
        assert.equal(message.body.kind, "queue");
        // receiveAndDelete messages carry no lock: the option reached the SDK.
        assert.equal(message.lockToken, undefined);
      } finally {
        await app.close();
      }
      assert.deepEqual(await remaining("itest.queue"), []);
    });

    test("emit() from the client reaches a @Subscription handler", async () => {
      const got = deferred("an emitted event");
      const controller = defineController({
        onEvent: {
          decorator: Subscription({
            topic: "itest.topic",
            subscription: "itest.sub",
            receiveMode: "receiveAndDelete",
          }),
          fn: (message) => {
            if (message.body?.runId === runId) got.resolve(message);
          },
        },
      });
      const { app } = await startMicroservice(controller);
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      try {
        await firstValueFrom(
          client.emit({ name: "itest.topic" }, { body: { runId, kind: "emit" } }),
          { defaultValue: undefined }
        );
        const message = await got.promise;
        assert.equal(message.body.kind, "emit");
      } finally {
        await client.close();
        await app.close();
      }
    });

    /**
     * Runs a fixture in its own Node process. Resolves with its exit code, or
     * "timeout" if it is still alive after `ms` (then it is killed).
     */
    function runChild(fixture, ms) {
      const script = fileURLToPath(new URL(fixture, import.meta.url));
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, SB_EXIT_RUN_ID: runId },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
      return Promise.race([exited, timeoutAfter(ms)]).then((code) => {
        if (code === "timeout") child.kill("SIGKILL");
        return { code, output: () => output };
      });
    }

    // The request-response run is shared by the next two tests.
    let requestReply;

    test("send() from the client gets the handler's reply (request-response)", async () => {
      requestReply = runChild("./request-reply.js", 15_000);
      const { output } = await requestReply;
      assert.match(output(), /^reply=5$/m, output());
      assert.match(output(), /^closed$/m, output());
    });

    test("send(): the process exits on its own after close()", async () => {
      const { code, output } = await requestReply;
      assert.equal(code, 0, output());
    });

    /**
     * A @Queue handler that echoes `n` back after a random delay. It handles
     * the requests concurrently, so the replies come out of order.
     */
    function echoController(queueName) {
      return defineController({
        echo: {
          decorator: Queue({ queueName, receiveMode: "peekLock", options: { maxConcurrentCalls: 16 } }),
          fn: async (message) => {
            await delay(Math.floor(Math.random() * 300));
            return { n: message.body.n, runId: message.body.runId };
          },
        },
      });
    }

    test("concurrent send() calls each get their own reply", async () => {
      const { app } = await startMicroservice(echoController("itest.rpc"));
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      client.logger = captureLogger();
      try {
        const replies = await Promise.race([
          Promise.all(
            Array.from({ length: 12 }, (_, n) =>
              firstValueFrom(client.send({ name: "itest.rpc" }, { body: { n, runId } }))
            )
          ),
          timeoutAfter(30_000),
        ]);
        assert.notEqual(replies, "timeout", "not every send() got a reply");
        assert.deepEqual(
          replies.map((reply) => reply.n),
          Array.from({ length: 12 }, (_, n) => n)
        );
        assert.ok(replies.every((reply) => reply.runId === runId));
      } finally {
        await client.close();
        await app.close();
      }
    });

    test("replySessions: clients sharing a reply queue each get only their replies", async () => {
      const { app } = await startMicroservice(echoController("itest.rpc.sessions"));
      const clients = [0, 1].map(
        () => new AzureServiceBusClient({ connectionString: CONNECTION_STRING, replySessions: true })
      );
      for (const client of clients) client.logger = captureLogger();
      try {
        const sendAll = (client, offset) =>
          Promise.all(
            Array.from({ length: 6 }, (_, i) =>
              firstValueFrom(
                client.send({ name: "itest.rpc.sessions" }, { body: { n: offset + i, runId } })
              )
            )
          );
        const results = await Promise.race([
          Promise.all([sendAll(clients[0], 0), sendAll(clients[1], 100)]),
          timeoutAfter(30_000),
        ]);
        assert.notEqual(results, "timeout", "not every send() got a reply");
        assert.deepEqual(results[0].map((r) => r.n), [0, 1, 2, 3, 4, 5]);
        assert.deepEqual(results[1].map((r) => r.n), [100, 101, 102, 103, 104, 105]);
        // In its own session, a client never sees the other one's replies.
        for (const client of clients) {
          assert.deepEqual(
            client.logger.entries.filter((e) => /Abandoned a reply/.test(String(e.message))),
            []
          );
        }
      } finally {
        await Promise.all(clients.map((client) => client.close()));
        await app.close();
      }
    });

    test("send() to an entity that does not exist errors the Observable", async () => {
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      try {
        const outcome = await Promise.race([
          firstValueFrom(client.send({ name: "itest.does-not-exist" }, { body: { runId } })).then(
            (value) => ({ value }),
            (error) => ({ error })
          ),
          timeoutAfter(20_000),
        ]);
        assert.notEqual(outcome, "timeout", "send() neither replied nor failed");
        assert.ok(outcome.error, `expected an error, got ${JSON.stringify(outcome)}`);
        assert.equal(outcome.error.code, "MessagingEntityNotFound");
      } finally {
        await client.close();
      }
    });

    /** Empties `entity` (requests nobody answered), so they do not pile up between runs. */
    function drain(entity) {
      return withSdk(async (sdk) => {
        const receiver = sdk.createReceiver(entity, { receiveMode: "receiveAndDelete" });
        while ((await receiver.receiveMessages(50, { maxWaitTimeInMs: 500 })).length > 0);
        await receiver.close();
      });
    }

    /** Settles `observable` into `{ value }`, `{ error }` or "timeout". */
    function outcomeOf(observable, ms) {
      return Promise.race([
        firstValueFrom(observable).then(
          (value) => ({ value }),
          (error) => ({ error })
        ),
        timeoutAfter(ms),
      ]);
    }

    test("send() fails when its reply queue does not exist", async () => {
      // itest.noreply exists, itest.noreply.reply does not.
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      const logger = captureLogger();
      client.logger = logger;
      try {
        const outcome = await outcomeOf(
          client.send({ name: "itest.noreply" }, { body: { runId } }),
          20_000
        );
        assert.notEqual(outcome, "timeout", "send() kept waiting for a reply queue that does not exist");
        assert.equal(outcome.error?.code, "MessagingEntityNotFound");
        assert.match(String(logger.errors()[0]?.message), /itest\.noreply\.reply/);
      } finally {
        await client.close();
        await drain("itest.noreply");
      }
    });

    test("send() with replyTimeoutInMs fails when no reply comes", async () => {
      // Nobody listens on itest.timeout: the request is sent, the reply never comes.
      const client = new AzureServiceBusClient({
        connectionString: CONNECTION_STRING,
        replyTimeoutInMs: 1500,
      });
      try {
        const started = Date.now();
        const outcome = await outcomeOf(
          client.send({ name: "itest.timeout" }, { body: { runId } }),
          15_000
        );
        assert.notEqual(outcome, "timeout");
        assert.ok(outcome.error instanceof ReplyTimeoutError, String(outcome.error));
        assert.ok(Date.now() - started >= 1400);
      } finally {
        await client.close();
        await drain("itest.timeout");
      }
    });

    test("peekLock: the context exposes the receiver to abandon and complete", async () => {
      const deliveries = [];
      const done = deferred("the second delivery to be completed");
      const controller = defineController({
        onLocked: {
          decorator: Queue({
            queueName: "itest.peeklock",
            receiveMode: "peekLock",
            options: { autoCompleteMessages: false },
          }),
          fn: async (message, ctx) => {
            if (message.body?.runId !== runId) return;
            assert.ok(message.lockToken, "peekLock messages carry a lock token");
            deliveries.push(message.deliveryCount);
            const receiver = ctx.getReceiver();
            assert.equal(ctx.getMessage(), message);
            if (deliveries.length === 1) {
              await receiver.abandonMessage(message);
            } else {
              await receiver.completeMessage(message);
              done.resolve();
            }
          },
        },
      });
      const { app, logger } = await startMicroservice(controller);
      try {
        await sendRaw("itest.peeklock", { runId, kind: "settle" });
        await done.promise;
      } finally {
        await app.close();
      }
      // Redelivered once: the abandon worked (the emulator starts counting at 0).
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[1], deliveries[0] + 1);
      assert.deepEqual(logger.errors(), []);
      assert.deepEqual(await remaining("itest.peeklock"), []);
    });

    test(
      "peekLock: a handler error abandons the message and it is redelivered",
      async () => {
        const deliveries = [];
        const done = deferred("the redelivery", 5_000);
        const controller = defineController({
          onFlaky: {
            decorator: Queue({ queueName: "itest.peeklock", receiveMode: "peekLock" }),
            fn: async (message) => {
              if (message.body?.runId !== runId) return;
              deliveries.push(message.deliveryCount);
              if (deliveries.length === 1) throw new Error("first attempt fails");
              done.resolve();
            },
          },
        });
        const { app } = await startMicroservice(controller);
        try {
          await sendRaw("itest.peeklock", { runId, kind: "retry" });
          await done.promise;
        } finally {
          await app.close();
        }
        assert.equal(deliveries.length, 2);
        assert.equal(deliveries[1], deliveries[0] + 1);
        // The second delivery succeeded, so it was auto-completed.
        assert.deepEqual(await remaining("itest.peeklock"), []);
      }
    );

    test("close() waits for in-flight handlers and settles their messages", async () => {
      const started = deferred("the handler to start");
      let finished = false;
      const controller = defineController({
        onSlow: {
          decorator: Queue({ queueName: "itest.inflight", receiveMode: "peekLock" }),
          fn: async (message) => {
            if (message.body?.runId !== runId) return;
            started.resolve();
            await delay(1500);
            finished = true;
          },
        },
      });
      const { app } = await startMicroservice(controller);
      await sendRaw("itest.inflight", { runId, kind: "slow" });
      await started.promise;
      await app.close();
      assert.equal(finished, true, "close() resolved before the handler finished");
      // Completed before the receiver closed: not left behind for redelivery.
      assert.deepEqual(await remaining("itest.inflight"), []);
    });

    test("listen() twice does not open duplicate receivers", async () => {
      const controller = defineController({
        onOrder: {
          decorator: Queue({ queueName: "itest.queue", receiveMode: "receiveAndDelete" }),
          fn: () => {},
        },
      });
      const { app, server } = await startMicroservice(controller);
      try {
        const sdkClient = server.unwrap();
        const receiversBefore = server.receivers.size;
        await new Promise((resolve, reject) =>
          server.listen((err) => (err ? reject(err) : resolve()))
        );
        assert.equal(server.unwrap(), sdkClient, "a second ServiceBusClient was created");
        assert.equal(server.receivers.size, receiversBefore);
      } finally {
        await app.close();
      }
    });

    test("receiver errors go to the logger and do not block close()", async () => {
      const controller = defineController({
        onMissing: {
          decorator: Queue({ queueName: "itest.does-not-exist", receiveMode: "peekLock" }),
          fn: () => {},
        },
      });
      const logger = captureLogger();
      const { app } = await startMicroservice(controller, { logger });
      try {
        for (let i = 0; i < 50 && logger.errors().length === 0; i++) await delay(200);
        const [first] = logger.errors();
        assert.ok(first, "the receiver error was not logged");
        assert.match(String(first.message), /itest\.does-not-exist/);
      } finally {
        const closing = app.close();
        const timeout = timeoutAfter(10_000);
        assert.notEqual(await Promise.race([closing, timeout]), "timeout");
      }
    });

    test("the process exits on its own after close() (no open handles)", async () => {
      const { code, output } = await runChild("./exit-check.js", 30_000);
      assert.equal(code, 0, `child did not exit cleanly:\n${output()}`);
      assert.match(output(), /received/);
    });
  }
);
