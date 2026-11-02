"use strict";
// Child process for the "exits on its own" integration test: starts a
// microservice and a client, round-trips one message, closes both and then
// does NOT call process.exit(). If any socket, timer or receiver is left
// open, this process stays alive and the parent test fails on its timeout.
const { firstValueFrom } = require("rxjs");

const { AzureServiceBusClient, Queue } = require("../../dist");
const {
  CONNECTION_STRING,
  defineController,
  deferred,
  startMicroservice,
} = require("./helpers.js");

async function main() {
  const runId = process.env.SB_EXIT_RUN_ID;
  const got = deferred("the message on itest.exit", 20_000);
  const controller = defineController({
    onExit: {
      decorator: Queue({ queueName: "itest.exit", receiveMode: "peekLock" }),
      fn: (message) => {
        if (message.body?.runId === runId) got.resolve();
      },
    },
  });

  const { app } = await startMicroservice(controller);
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  try {
    await firstValueFrom(client.emit({ name: "itest.exit" }, { body: { runId } }), {
      defaultValue: undefined,
    });
    await got.promise;
    console.log("received");
  } finally {
    await client.close();
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
