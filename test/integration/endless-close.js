"use strict";
// Child process for the "endless response" integration tests: a handler
// answers with a response that never ends, the client gets its first value,
// and then the microservice closes. The process must exit on its own: a
// response still subscribed after close() (its timer) would keep it alive.
//
// argv[2] is the client: "1.2.0" (this package's client; close() cuts the
// response after closeTimeoutInMs) or "1.1.0" (a raw request without
// nestjs-sb-request-id, as those clients send it; the response must stop
// after its single reply, so close() does not wait at all).
const { ServiceBusClient } = require("@azure/service-bus");
const { firstValueFrom, interval } = require("rxjs");

const { AzureServiceBusClient, AzureServiceBusServer, Queue } = require("../../dist");
const {
  CONNECTION_STRING,
  captureLogger,
  defineController,
  startMicroservice,
} = require("./helpers.js");

async function drain(sdk, entity) {
  const receiver = sdk.createReceiver(entity, { receiveMode: "receiveAndDelete" });
  const got = [];
  for (let batch; (batch = await receiver.receiveMessages(50, { maxWaitTimeInMs: 500 })).length > 0; ) {
    got.push(...batch);
  }
  await receiver.close();
  return got;
}

async function main() {
  const legacy = process.argv[2] === "1.1.0";
  const runId = process.env.SB_EXIT_RUN_ID;
  const sdk = new ServiceBusClient(CONNECTION_STRING);
  await drain(sdk, "itest.stream.reply");
  const controller = defineController({
    endless: {
      decorator: Queue({ queueName: "itest.stream", receiveMode: "peekLock" }),
      fn: () => interval(100),
    },
  });
  const logger = captureLogger();
  const strategy = new AzureServiceBusServer({
    connectionString: CONNECTION_STRING,
    closeTimeoutInMs: legacy ? 20_000 : 1_000,
  });
  const { app } = await startMicroservice(controller, { logger, strategy });
  try {
    if (legacy) {
      const messageId = `legacy-endless-${runId}`;
      const sender = sdk.createSender("itest.stream");
      // Short-lived, so that it never reaches a handler of a later run.
      await sender.sendMessages({
        body: { runId },
        messageId,
        replyTo: "itest.stream.reply",
        timeToLive: 10_000,
      });
      await sender.close();
      const receiver = sdk.createReceiver("itest.stream.reply", { receiveMode: "receiveAndDelete" });
      const [reply] = await receiver.receiveMessages(1, { maxWaitTimeInMs: 15_000 });
      await receiver.close();
      console.log(`first=${reply?.correlationId === messageId ? reply.body : "none"}`);
    } else {
      const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
      client.logger = captureLogger();
      const first = await firstValueFrom(
        client.send({ name: "itest.stream" }, { body: { runId }, timeToLive: 10_000 })
      );
      console.log(`first=${first}`);
      await client.close();
    }
    // Long enough for a few more values, had the response gone on.
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    const started = Date.now();
    await app.close();
    console.log(`closed in ${Date.now() - started} ms`);
    for (const entry of logger.entries.filter((e) => e.level === "warn")) {
      console.log(`warn: ${entry.message}`);
    }
  }
  // A 1.1.0 client must have got exactly one reply.
  const leftovers = await drain(sdk, "itest.stream.reply");
  if (legacy) console.log(`replies=${1 + leftovers.length}`);
  await sdk.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
