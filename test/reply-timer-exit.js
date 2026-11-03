"use strict";
// Child process for the unit test "a finished send() leaves no timer behind":
// one send() with a long replyTimeoutInMs gets its reply, the client closes,
// and the process must then exit on its own, at once. A reply timer that is
// not cleared would keep it alive for the whole timeout.
require("reflect-metadata");
const { lastValueFrom } = require("rxjs");

const { AzureServiceBusClient } = require("../dist");
const {
  SB_REPLY_DISPOSED_PROPERTY,
  SB_REPLY_TYPE_PROPERTY,
} = require("../dist/azure-service-bus.constants");

async function main() {
  const client = new AzureServiceBusClient({
    connectionString: "fake",
    replyTimeoutInMs: 60_000,
  });
  client.logger = { error() {}, warn() {}, log() {}, debug() {}, verbose() {} };
  let deliver;
  const subscribed = new Promise((resolve) => (deliver = resolve));
  client.sbClient = {
    createSender: () => ({ sendMessages: async () => {}, close: async () => {} }),
    createReceiver: () => {
      const receiver = {
        subscribe(handlers) {
          deliver(handlers);
          return { close: async () => {} };
        },
        completeMessage: async () => {},
        close: async () => {},
      };
      return receiver;
    },
    close: async () => {},
  };
  // Capture the request id from the sent message.
  let requestId;
  const createSender = client.sbClient.createSender;
  client.sbClient.createSender = (name) => {
    const sender = createSender(name);
    sender.sendMessages = async (messages) => {
      requestId = messages[0].messageId;
    };
    return sender;
  };

  const reply = lastValueFrom(client.send({ name: "rpc" }, { body: 1 }));
  const handlers = await subscribed;
  while (!requestId) await new Promise((resolve) => setImmediate(resolve));
  await handlers.processMessage({
    correlationId: requestId,
    body: "ok",
    applicationProperties: {
      [SB_REPLY_TYPE_PROPERTY]: "response",
      [SB_REPLY_DISPOSED_PROPERTY]: true,
    },
  });
  console.log(`reply=${await reply}`);
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
