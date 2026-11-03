"use strict";
// Child process for the unit test "the process exits on its own after the
// client's close() cancels a send that hangs". The fake send keeps a 60 s
// timer, as the SDK's send does while it waits for the broker, and clears it
// only when its abortSignal fires. close() must cancel it: waiting for it, or
// closing the connection under it, keeps this process alive for a minute.
require("reflect-metadata");
const { lastValueFrom } = require("rxjs");

const { AzureServiceBusClient } = require("../dist");

async function main() {
  const client = new AzureServiceBusClient({ connectionString: "fake", closeTimeoutInMs: 200 });
  client.logger = { error() {}, warn() {}, log() {}, debug() {}, verbose() {} };
  client.sbClient = {
    createSender: () => ({
      sendMessages: (messages, options) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("operation timeout")), 60_000);
          options?.abortSignal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          });
        }),
      close: async () => {},
    }),
    close: async () => {},
  };

  const sent = lastValueFrom(client.emit({ name: "events" }, { body: 1 }), {
    defaultValue: undefined,
  }).then(
    () => "ok",
    (err) => `error: ${err.message}`
  );
  await new Promise((resolve) => setImmediate(resolve));
  await client.close();
  console.log("closed");
  console.log(`send=${await sent}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
