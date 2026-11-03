"use strict";
// Child process for the request-response integration test. It runs in its own
// process so that the parent can check that it exits on its own once the
// client and the microservice are closed (nothing left pending after close()).
const { lastValueFrom } = require("rxjs");

const { AzureServiceBusClient, AzureServiceBusContext, Queue } = require("../../dist");
const { CONNECTION_STRING, defineController, startMicroservice } = require("./helpers.js");

async function main() {
  const controller = defineController({
    sum: {
      decorator: Queue({ queueName: "itest.rpc", receiveMode: "receiveAndDelete" }),
      fn: (message, ctx) => {
        if (!(ctx instanceof AzureServiceBusContext)) throw new Error("no context");
        return message.body.a + message.body.b;
      },
    },
  });

  const { app } = await startMicroservice(controller);
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING });
  try {
    const reply = await lastValueFrom(
      client.send({ name: "itest.rpc" }, { body: { a: 2, b: 3 } })
    );
    console.log(`reply=${JSON.stringify(reply)}`);
  } finally {
    await client.close();
    await app.close();
    console.log("closed");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
