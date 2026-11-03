"use strict";
// Child process for the integration tests of the client's close() with sends
// in flight: an emit() and a send() are still being sent when the client
// closes, and the process must then exit on its own (a send left running
// under a closed connection keeps the SDK's timers, and the process, alive).
//
// argv[2] is a delay (ms) added to each AMQP transfer once the connection is
// open, as a slow network or broker would add; 0 adds none. argv[3] is the
// client's closeTimeoutInMs.
const { createRequire } = require("node:module");
const { lastValueFrom } = require("rxjs");

const { AzureServiceBusClient } = require("../../dist");
const { CONNECTION_STRING, captureLogger } = require("./helpers.js");

const sendDelayMs = Number(process.argv[2] ?? 0);
const closeTimeoutInMs = Number(process.argv[3] ?? 1_000);
let slow = false;

/**
 * Delays every transfer of the SDK's AMQP senders (rhea-promise's
 * AwaitableSender) while `slow` is set. Aborting the send ends the delay, and
 * the SDK's own send() then sees the aborted signal, as it would on a link
 * where the transfer is still waiting for the broker.
 */
function slowDownTransfers() {
  const sdkRequire = createRequire(require.resolve("@azure/service-bus"));
  const { AwaitableSender } = sdkRequire("rhea-promise");
  const send = AwaitableSender?.prototype?.send;
  if (typeof send !== "function") {
    throw new Error("rhea-promise's AwaitableSender.prototype.send was not found");
  }
  AwaitableSender.prototype.send = function (message, options) {
    if (!slow) return send.call(this, message, options);
    const signal = options?.abortSignal;
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, sendDelayMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    }).then(() => send.call(this, message, options));
  };
}

/** How an Observable of the client ends, as a line of text. */
function outcomeOf(observable) {
  return lastValueFrom(observable, { defaultValue: undefined }).then(
    () => "ok",
    (err) => `error: ${err?.message ?? err}`
  );
}

async function main() {
  const runId = process.env.SB_EXIT_RUN_ID;
  if (sendDelayMs > 0) slowDownTransfers();
  const client = new AzureServiceBusClient({ connectionString: CONNECTION_STRING, closeTimeoutInMs });
  const logger = captureLogger();
  client.logger = logger;
  // Nobody consumes itest.junk: short-lived messages.
  const message = () => ({ body: { runId }, timeToLive: 10_000 });

  // Opens the connection first, so that what is in flight at close() is the
  // transfer itself.
  await outcomeOf(client.emit({ name: "itest.junk" }, message()));
  slow = sendDelayMs > 0;
  const emitted = outcomeOf(client.emit({ name: "itest.junk" }, message()));
  const sent = outcomeOf(client.send({ name: "itest.junk" }, message()));
  await new Promise((resolve) => setTimeout(resolve, 200));

  const started = Date.now();
  await client.close();
  console.log(`close=${Date.now() - started}`);
  console.log(`emit=${await emitted}`);
  console.log(`send=${await sent}`);
  for (const entry of logger.entries.filter((e) => e.level === "warn" || e.level === "error")) {
    console.log(`${entry.level}: ${entry.message}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
