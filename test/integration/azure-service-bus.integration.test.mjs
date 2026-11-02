// Integration tests against the Azure Service Bus emulator.
//
// Optional: `npm test` never runs them. `npm run test:integration` runs them
// and skips the whole suite when the emulator is not reachable, unless
// SB_EMULATOR_REQUIRED=1 (CI), where a missing emulator is a failure.
// How to start the emulator: see docker-compose.yml next to this file.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
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
    /** Raw SDK client, used to send test messages and inspect entities. */
    let sdk;

    before(() => {
      sdk = new ServiceBusClient(CONNECTION_STRING);
    });

    after(async () => {
      await sdk?.close();
    });

    async function sendRaw(entity, body, extra = {}) {
      const sender = sdk.createSender(entity);
      try {
        await sender.sendMessages({ body, ...extra });
      } finally {
        await sender.close();
      }
    }

    /** Messages still in `entity` that belong to this run (peek does not consume). */
    async function remaining(entity) {
      const receiver = sdk.createReceiver(entity);
      try {
        const peeked = await receiver.peekMessages(50);
        return peeked.filter((m) => m.body?.runId === runId);
      } finally {
        await receiver.close();
      }
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
        const drain = sdk.createReceiver("itest.topic", "itest.sub", {
          receiveMode: "receiveAndDelete",
        });
        await drain.receiveMessages(10, { maxWaitTimeInMs: 1000 });
        await drain.close();
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

    test("send() from the client gets the handler's reply (request-response)", async () => {
      const controller = defineController({
        sum: {
          decorator: Queue({ queueName: "itest.rpc", receiveMode: "receiveAndDelete" }),
          fn: (message, ctx) => {
            assert.ok(ctx instanceof AzureServiceBusContext);
            return message.body.a + message.body.b;
          },
        },
      });
      const { app } = await startMicroservice(controller);
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      try {
        // firstValueFrom: the client never completes the reply stream (it
        // emits the reply without isDisposed), so lastValueFrom would hang.
        const reply = await firstValueFrom(
          client.send({ name: "itest.rpc" }, { body: { a: 2, b: 3 } })
        );
        assert.equal(reply, 5);
      } finally {
        await client.close();
        await app.close();
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
            if (message.deliveryCount === 1) {
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
      assert.deepEqual(deliveries, [1, 2]);
      assert.deepEqual(logger.errors(), []);
      assert.deepEqual(await remaining("itest.peeklock"), []);
    });

    test("peekLock: a handler error abandons the message and it is redelivered", async () => {
      const deliveries = [];
      const done = deferred("the redelivery");
      const controller = defineController({
        onFlaky: {
          decorator: Queue({ queueName: "itest.peeklock", receiveMode: "peekLock" }),
          fn: async (message) => {
            if (message.body?.runId !== runId) return;
            deliveries.push(message.deliveryCount);
            if (message.deliveryCount === 1) throw new Error("first attempt fails");
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
      assert.deepEqual(deliveries, [1, 2]);
      // The second delivery succeeded, so it was auto-completed.
      assert.deepEqual(await remaining("itest.peeklock"), []);
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

    test("the process exits on its own after close() (no open handles)", async () => {
      const script = fileURLToPath(new URL("./exit-check.js", import.meta.url));
      const child = spawn(process.execPath, [script], {
        env: { ...process.env, SB_EXIT_RUN_ID: runId },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));

      const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
      const timeout = timeoutAfter(30_000);
      const result = await Promise.race([exited, timeout]);
      if (result === "timeout") child.kill("SIGKILL");
      assert.equal(result, 0, `child did not exit cleanly:\n${output}`);
      assert.match(output, /received/);
    });
  }
);
