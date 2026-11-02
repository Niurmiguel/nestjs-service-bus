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

    test(
      "send(): the process exits on its own after close()",
      {
        todo:
          "publish() in the client does not await sendMessages() nor the closes in its " +
          "teardown: the send keeps retrying on a closed sender, holds the process " +
          "open and ends as an unhandled rejection (~90 s on the emulator)",
      },
      async () => {
        const { code, output } = await requestReply;
        assert.equal(code, 0, output());
      }
    );

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
      {
        todo:
          "Nest's exception filter turns a handler error into an errored Observable that " +
          "handleEvent() never awaits, so the message is completed, not abandoned",
      },
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
