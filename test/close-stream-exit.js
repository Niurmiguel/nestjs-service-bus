"use strict";
// Child process for the unit test "the process exits on its own after close()
// cuts an endless response": a handler answers a request with a response that
// never ends, close() gives up on it after closeTimeoutInMs, and the process
// must then exit on its own. A response still subscribed after close() (its
// timer) would keep it alive for ever.
require("reflect-metadata");
const { interval } = require("rxjs");

const { AzureServiceBusServer } = require("../dist");
const { SB_REQUEST_ID_PROPERTY } = require("../dist/azure-service-bus.constants");

async function main() {
  const server = new AzureServiceBusServer({ connectionString: "fake", closeTimeoutInMs: 100 });
  server.logger = { error() {}, warn() {}, log() {}, debug() {}, verbose() {} };
  let handlers;
  const receiver = {
    receiveMode: "peekLock",
    entityPath: "rpc",
    subscribe(h) {
      handlers = h;
      return { close: async () => {} };
    },
    completeMessage: async () => {},
    abandonMessage: async () => {},
    close: async () => {},
  };
  server.createServiceBusClient = () => ({
    createReceiver: () => receiver,
    createSender: () => ({ sendMessages: async () => {}, close: async () => {} }),
    close: async () => {},
  });
  server.addHandler({ type: "queue", metaOptions: { queueName: "rpc" } }, async () => interval(50), false);
  await new Promise((resolve, reject) => server.listen((err) => (err ? reject(err) : resolve())));
  await handlers.processMessage({
    body: null,
    messageId: "m-1",
    replyTo: "rpc.reply",
    applicationProperties: { [SB_REQUEST_ID_PROPERTY]: "req-1" },
  });
  await server.close();
  console.log("closed");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
