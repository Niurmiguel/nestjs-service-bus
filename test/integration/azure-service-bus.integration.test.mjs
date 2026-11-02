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
const { RpcException } = require("@nestjs/microservices");
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

    test("send() fails with the error of a request handler that throws", async () => {
      const controller = defineController({
        fail: {
          decorator: Queue({ queueName: "itest.rpc", receiveMode: "peekLock" }),
          fn: async (message) => {
            if (message.body.kind === "rpc-exception") throw new RpcException("Order 7 not found");
            throw new Error("internal detail that must not reach the client");
          },
        },
      });
      const { app } = await startMicroservice(controller);
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      client.logger = captureLogger();
      try {
        const [unknown, rpc] = await Promise.all(
          ["error", "rpc-exception"].map((kind) =>
            outcomeOf(client.send({ name: "itest.rpc" }, { body: { runId, kind } }), 20_000)
          )
        );
        assert.notEqual(unknown, "timeout", "send() waited forever for a handler that threw");
        // As Nest's other transports: unknown errors are replaced, RpcException goes through.
        assert.deepEqual(unknown.error, { status: "error", message: "Internal server error" });
        assert.deepEqual(rpc.error, { status: "error", message: "Order 7 not found" });
      } finally {
        await client.close();
        await app.close();
      }
      // The requests were answered, so they were completed, not redelivered.
      assert.deepEqual(await remaining("itest.rpc"), []);
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
      // itest.nosend does not exist, but its reply queue does: the error can
      // only come from the send itself.
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      const logger = captureLogger();
      client.logger = logger;
      try {
        const outcome = await Promise.race([
          firstValueFrom(client.send({ name: "itest.nosend" }, { body: { runId } })).then(
            (value) => ({ value }),
            (error) => ({ error })
          ),
          timeoutAfter(20_000),
        ]);
        assert.notEqual(outcome, "timeout", "send() neither replied nor failed");
        assert.ok(outcome.error, `expected an error, got ${JSON.stringify(outcome)}`);
        assert.equal(outcome.error.code, "MessagingEntityNotFound");
        assert.match(String(outcome.error.message), /itest\.nosend/);
        // The reply receiver did not fail: nothing about the reply queue.
        assert.deepEqual(
          logger.errors().filter((e) => /reply/i.test(String(e.message))),
          []
        );
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

    // itest.lockrenewal has a 5 s lock; the handler takes longer than that.
    function slowLockController(deliveries, done, maxAutoLockRenewalDurationInMs) {
      return defineController({
        onSlow: {
          decorator: Queue({
            queueName: "itest.lockrenewal",
            receiveMode: "peekLock",
            ...(maxAutoLockRenewalDurationInMs !== undefined && { maxAutoLockRenewalDurationInMs }),
          }),
          fn: async (message) => {
            if (message.body?.runId !== runId) return;
            deliveries.push(message.deliveryCount);
            if (deliveries.length === 1) {
              await delay(8_000);
            } else {
              done.resolve();
            }
          },
        },
      });
    }

    test("peekLock: the lock is renewed while a handler outlasts it (default)", async () => {
      const deliveries = [];
      const { app, logger } = await startMicroservice(slowLockController(deliveries, deferred("unused")));
      try {
        await sendRaw("itest.lockrenewal", { runId, kind: "renewed" });
        for (let i = 0; i < 60 && deliveries.length === 0; i++) await delay(100);
        await delay(9_000); // the handler, plus time for a redelivery that must not come
      } finally {
        await app.close();
      }
      assert.deepEqual(deliveries.length, 1, `delivered ${deliveries.length} times`);
      assert.deepEqual(logger.errors(), []);
      assert.deepEqual(await remaining("itest.lockrenewal"), []);
    });

    test("peekLock: maxAutoLockRenewalDurationInMs: 0 turns lock renewal off", async () => {
      const deliveries = [];
      const done = deferred("the redelivery after the lock expired", 30_000);
      const { app, logger } = await startMicroservice(slowLockController(deliveries, done, 0));
      try {
        await sendRaw("itest.lockrenewal", { runId, kind: "not-renewed" });
        await done.promise;
      } finally {
        await app.close();
      }
      // The lock expired during the first run: completing it failed, and the
      // message came back.
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[1], deliveries[0] + 1);
      assert.match(String(logger.errors()[0]?.message), /Could not complete message/);
      assert.deepEqual(await remaining("itest.lockrenewal"), []);
    });

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

    test("send() without replySessions fails fast on a reply queue with sessions", async () => {
      // itest.rpc.sessions.reply requires sessions: a receiver without them
      // gets a non-retryable error, which the SDK would retry for ever.
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      const logger = captureLogger();
      client.logger = logger;
      try {
        const started = Date.now();
        const outcome = await outcomeOf(
          client.send({ name: "itest.rpc.sessions" }, { body: { runId, n: -1 } }),
          20_000
        );
        assert.notEqual(outcome, "timeout", "send() kept waiting on a receiver that cannot work");
        assert.equal(outcome.error?.retryable, false, String(outcome.error));
        assert.match(String(outcome.error?.message), /requires sessions/);
        assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
        assert.match(String(logger.errors()[0]?.message), /must not have sessions enabled/);
      } finally {
        await client.close();
        await drain("itest.rpc.sessions");
      }
    });

    test("allowedReplyTo: the server does not reply to a replyTo it does not allow", async () => {
      const calls = [];
      const controller = defineController({
        echo: {
          decorator: Queue({ queueName: "itest.guarded", receiveMode: "peekLock" }),
          fn: (message) => {
            calls.push(message.body);
            return { echoed: message.body };
          },
        },
      });
      const logger = captureLogger();
      const strategy = new AzureServiceBusServer({
        connectionString: CONNECTION_STRING,
        allowedReplyTo: ["itest.guarded.reply"],
      });
      const { app } = await startMicroservice(controller, { logger, strategy });
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      client.logger = captureLogger();
      try {
        // A request that names another entity as its reply queue.
        await sendRaw("itest.guarded", { runId, kind: "redirect" }, {
          replyTo: "itest.forbidden",
          messageId: `redirect-${runId}`,
        });
        // A legitimate one still gets its reply.
        const outcome = await outcomeOf(
          client.send({ name: "itest.guarded" }, { body: { runId, kind: "legit" } }),
          20_000
        );
        assert.deepEqual(outcome.value, { echoed: { runId, kind: "legit" } });
        const dead = await withSdk(async (sdk) => {
          const dlq = sdk.createReceiver("itest.guarded", {
            subQueueType: "deadLetter",
            receiveMode: "receiveAndDelete",
          });
          const got = await dlq.receiveMessages(10, { maxWaitTimeInMs: 5_000 });
          await dlq.close();
          return got.filter((m) => m.body?.runId === runId);
        });
        assert.equal(dead.length, 1);
        assert.equal(dead[0].body.kind, "redirect");
        assert.equal(dead[0].deadLetterReason, "ReplyToNotAllowed");
        assert.deepEqual(calls, [{ runId, kind: "legit" }], "the handler ran for the rejected request");
        assert.match(
          String(logger.entries.find((e) => e.level === "warn")?.message),
          /"itest\.forbidden" is not allowed/
        );
      } finally {
        await client.close();
        await app.close();
      }
      // Nothing was sent to the entity the request named.
      const forbidden = await withSdk(async (sdk) => {
        const receiver = sdk.createReceiver("itest.forbidden", { receiveMode: "receiveAndDelete" });
        const got = await receiver.receiveMessages(10, { maxWaitTimeInMs: 2_000 });
        await receiver.close();
        return got;
      });
      assert.deepEqual(forbidden, []);
    });

    /** A @Queue handler on itest.stream whose response is chosen by the request. */
    function streamController() {
      const { Observable } = require("rxjs");
      return defineController({
        stream: {
          decorator: Queue({ queueName: "itest.stream", receiveMode: "peekLock" }),
          fn: (message) =>
            new Observable((subscriber) => {
              if (message.body.kind === "progress") {
                const steps = ["10%", "50%", "100%"];
                const timers = steps.map((step, i) =>
                  setTimeout(() => {
                    subscriber.next(step);
                    if (i === steps.length - 1) subscriber.complete();
                  }, 300 * i)
                );
                return () => timers.forEach(clearTimeout);
              }
              // Emits once and never completes.
              subscriber.next("started");
              return undefined;
            }),
        },
      });
    }

    test("streamed responses: each value is sent as soon as it is emitted", async () => {
      const { toArray } = require("rxjs");
      const strategy = new AzureServiceBusServer({
        connectionString: CONNECTION_STRING,
        closeTimeoutInMs: 1_000,
      });
      const { app } = await startMicroservice(streamController(), { strategy });
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      client.logger = captureLogger();
      try {
        const all = await outcomeOf(
          client.send({ name: "itest.stream" }, { body: { runId, kind: "progress" } }).pipe(toArray()),
          20_000
        );
        assert.deepEqual(all.value, ["10%", "50%", "100%"]);
        // A response that never completes still delivers its first value.
        const first = await outcomeOf(
          // Short-lived: closing the server leaves it locked, and it must not
          // reach the handler again in a later test or run.
          client.send({ name: "itest.stream" }, { body: { runId, kind: "endless" }, timeToLive: 5_000 }),
          10_000
        );
        assert.notEqual(first, "timeout", "the value of an endless response was held back");
        assert.equal(first.value, "started");
        // The endless response does not hold the receiver (one call at a
        // time by default): the next request is answered.
        const next = await outcomeOf(
          client.send({ name: "itest.stream" }, { body: { runId, kind: "progress" } }).pipe(toArray()),
          10_000
        );
        assert.deepEqual(next.value, ["10%", "50%", "100%"]);
      } finally {
        await client.close();
        await app.close(); // the endless handler is cut by closeTimeoutInMs
        await drain("itest.stream");
        await drain("itest.stream.reply");
      }
    });

    test("replyTimeToLiveInMs sets the time to live of the replies", async () => {
      const strategy = new AzureServiceBusServer({
        connectionString: CONNECTION_STRING,
        replyTimeToLiveInMs: 120_000,
      });
      const { app } = await startMicroservice(streamController(), { strategy });
      try {
        const replies = await withSdk(async (sdk) => {
          const receiver = sdk.createReceiver("itest.stream.reply", { receiveMode: "receiveAndDelete" });
          const sender = sdk.createSender("itest.stream");
          // As a 1.2.0 client sends it: older clients get a single reply.
          await sender.sendMessages({
            body: { runId, kind: "progress" },
            messageId: `ttl-${runId}`,
            replyTo: "itest.stream.reply",
            applicationProperties: { "nestjs-sb-request-id": `ttl-${runId}` },
          });
          await sender.close();
          const got = [];
          for (let i = 0; i < 20 && got.length < 3; i++) {
            const batch = await receiver.receiveMessages(3, { maxWaitTimeInMs: 1_000 });
            got.push(...batch.filter((m) => m.correlationId === `ttl-${runId}`));
          }
          await receiver.close();
          return got;
        });
        // Three values; the end comes in the same tick as the last one, on it.
        assert.deepEqual(
          replies.map((r) => [r.body, r.applicationProperties["nestjs-sb-is-disposed"]]),
          [
            ["10%", false],
            ["50%", false],
            ["100%", true],
          ]
        );
        for (const reply of replies) assert.equal(reply.timeToLive, 120_000);
      } finally {
        await app.close();
      }
    });

    test("a request from a client before 1.2.0 gets a single reply", async () => {
      // 1.1.0 clients send no nestjs-sb-request-id, and take any message on
      // their reply queue as the answer to their next request.
      const { app } = await startMicroservice(streamController());
      try {
        const replies = await withSdk(async (sdk) => {
          const receiver = sdk.createReceiver("itest.stream.reply", { receiveMode: "receiveAndDelete" });
          const sender = sdk.createSender("itest.stream");
          await sender.sendMessages({
            body: { runId, kind: "progress" },
            messageId: `legacy-${runId}`,
            replyTo: "itest.stream.reply",
          });
          await sender.close();
          const got = [];
          // The whole stream takes 600 ms: wait well past its end.
          for (let i = 0; i < 4; i++) {
            const batch = await receiver.receiveMessages(5, { maxWaitTimeInMs: 1_000 });
            got.push(...batch.filter((m) => m.correlationId === `legacy-${runId}`));
          }
          await receiver.close();
          return got;
        });
        assert.deepEqual(
          replies.map((r) => [r.body, r.applicationProperties["nestjs-sb-is-disposed"]]),
          [["10%", true]]
        );
      } finally {
        await app.close();
      }
    });

    test("close() stops waiting after closeTimeoutInMs; the message comes back", async () => {
      // itest.closetimeout has a 5 s lock.
      const started = deferred("the handler to start");
      const controller = defineController({
        stuck: {
          decorator: Queue({ queueName: "itest.closetimeout", receiveMode: "peekLock" }),
          fn: (message) => {
            if (message.body?.runId !== runId) return undefined;
            started.resolve(message.deliveryCount);
            return new Promise(() => {}); // never settles
          },
        },
      });
      const logger = captureLogger();
      const strategy = new AzureServiceBusServer({
        connectionString: CONNECTION_STRING,
        closeTimeoutInMs: 1_000,
      });
      const { app } = await startMicroservice(controller, { logger, strategy });
      await sendRaw("itest.closetimeout", { runId, kind: "stuck" });
      const firstDelivery = await started.promise;
      const closing = Date.now();
      assert.notEqual(await Promise.race([app.close(), timeoutAfter(10_000)]), "timeout");
      assert.ok(Date.now() - closing < 8_000, `close() took ${Date.now() - closing} ms`);
      assert.match(
        String(logger.entries.find((e) => e.level === "warn")?.message),
        /closeTimeoutInMs/
      );
      // Not settled: delivered again once the lock expires.
      const again = await withSdk(async (sdk) => {
        const receiver = sdk.createReceiver("itest.closetimeout");
        for (let i = 0; i < 20; i++) {
          const [message] = await receiver.receiveMessages(1, { maxWaitTimeInMs: 1_000 });
          if (message?.body?.runId === runId) {
            await receiver.completeMessage(message);
            await receiver.close();
            return message;
          }
          if (message) await receiver.completeMessage(message);
        }
        await receiver.close();
        return undefined;
      });
      assert.ok(again, "the message was not delivered again");
      assert.equal(again.deliveryCount, firstDelivery + 1);
    });

    test("a reply that is not to a request is dead-lettered, not bounced", async () => {
      const client = new AzureServiceBusClient({
        connectionString: CONNECTION_STRING,
        replyTimeoutInMs: 15_000,
      });
      const logger = captureLogger();
      client.logger = logger;
      // Nobody answers itest.junk: the request only keeps a reply receiver open.
      const pending = outcomeOf(client.send({ name: "itest.junk" }, { body: { runId } }), 20_000);
      try {
        await delay(1_500);
        await sendRaw("itest.junk.reply", { runId, kind: "junk" }, { correlationId: `junk-${runId}` });
        const dead = await withSdk(async (sdk) => {
          const dlq = sdk.createReceiver("itest.junk.reply", {
            subQueueType: "deadLetter",
            receiveMode: "receiveAndDelete",
          });
          const got = [];
          for (let i = 0; i < 10 && got.length === 0; i++) {
            got.push(
              ...(await dlq.receiveMessages(10, { maxWaitTimeInMs: 1_000 })).filter(
                (m) => m.body?.runId === runId
              )
            );
          }
          await dlq.close();
          return got;
        });
        assert.equal(dead.length, 1);
        assert.equal(dead[0].deadLetterReason, "InvalidCorrelationId");
        assert.ok(dead[0].deliveryCount <= 1, `delivered ${dead[0].deliveryCount} times`);
        assert.equal(
          logger.entries.filter((e) => /Dead-lettered a reply/.test(String(e.message))).length,
          1
        );
      } finally {
        await client.close();
        await pending;
        await drain("itest.junk");
      }
    });

    test("util.inspect() of a connected client and server hides the key", async () => {
      const { inspect } = require("node:util");
      const key = /SharedAccessKey=([^;]+)/.exec(CONNECTION_STRING)[1];
      const { app, server } = await startMicroservice(echoController("itest.rpc"));
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      client.logger = captureLogger();
      try {
        const reply = await outcomeOf(
          client.send({ name: "itest.rpc" }, { body: { n: 1, runId } }),
          20_000
        );
        assert.equal(reply.value?.n, 1);
        for (const target of [client, server]) {
          const shown = inspect(target, { depth: Infinity });
          assert.ok(!shown.includes(key), "the key is shown");
          assert.match(shown, /SharedAccessKey=<redacted>/);
        }
      } finally {
        await client.close();
        await app.close();
      }
    });

    test("the process exits on its own after close() (no open handles)", async () => {
      const { code, output } = await runChild("./exit-check.js", 30_000);
      assert.equal(code, 0, `child did not exit cleanly:\n${output()}`);
      assert.match(output(), /received/);
    });
  }
);
