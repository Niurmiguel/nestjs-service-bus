"use strict";
// Shared helpers for the emulator integration tests. Run against the compiled
// output in dist/ (`npm run test:integration` builds first).
require("reflect-metadata");

const { Controller, Module } = require("@nestjs/common");
const { NestFactory } = require("@nestjs/core");
const { Ctx, Payload } = require("@nestjs/microservices");

const { AzureServiceBusServer } = require("../../dist");

// Public, documented connection string of the local emulator (not a secret):
// https://learn.microsoft.com/azure/service-bus-messaging/test-locally-with-service-bus-emulator
const CONNECTION_STRING =
  process.env.SB_EMULATOR_CONNECTION_STRING ||
  "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;";
const HEALTH_URL =
  process.env.SB_EMULATOR_HEALTH_URL || "http://127.0.0.1:5300/health";

/** Resolves to true only if the emulator answers its health check as healthy. */
async function emulatorAvailable() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return res.ok && body?.status === "healthy";
  } catch {
    // Not running, not reachable or not healthy yet: the suite is skipped.
    return false;
  }
}

/** Collects what Nest logs, so tests can assert on errors without printing them. */
function captureLogger() {
  const entries = [];
  const push = (level) => (message, ...rest) => entries.push({ level, message, rest });
  return {
    entries,
    errors: () => entries.filter((e) => e.level === "error"),
    log: push("log"),
    error: push("error"),
    warn: push("warn"),
    debug: push("debug"),
    verbose: push("verbose"),
    fatal: push("fatal"),
  };
}

/**
 * Declares a Nest controller from plain functions. `handlers` maps a method
 * name to `{ decorator, fn }`, where `decorator` is e.g. `Subscription({...})`.
 * Every handler gets `(@Payload() message, @Ctx() context)`, as a TypeScript
 * user would declare it (plain JS has no parameter decorators).
 */
function defineController(handlers) {
  class Handlers {}
  for (const [name, { decorator, fn }] of Object.entries(handlers)) {
    Object.defineProperty(Handlers.prototype, name, {
      value: fn,
      writable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(Handlers.prototype, name);
    Payload()(Handlers.prototype, name, 0);
    Ctx()(Handlers.prototype, name, 1);
    decorator(Handlers.prototype, name, descriptor);
  }
  Controller()(Handlers);
  return Handlers;
}

/** Starts a Nest microservice that uses this transport with `controller`. */
async function startMicroservice(controller, { logger = captureLogger(), strategy } = {}) {
  class AppModule {}
  Module({ controllers: [controller] })(AppModule);

  const server =
    strategy || new AzureServiceBusServer({ connectionString: CONNECTION_STRING });
  const app = await NestFactory.createMicroservice(AppModule, {
    strategy: server,
    logger,
  });
  await app.listen();
  return { app, server, logger };
}

/** A promise you resolve from outside, failing after `ms` with `label`. */
function deferred(label, ms = 15_000) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = setTimeout(
    () => reject(new Error(`timed out after ${ms} ms waiting for ${label}`)),
    ms
  );
  timer.unref();
  promise.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer)
  );
  return { promise, resolve, reject };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves to "timeout" after `ms` without keeping the process alive. */
const timeoutAfter = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms, "timeout").unref());

/** Unique per run, so messages left over from a previous run are ignored. */
const runId = `${process.pid}-${Date.now()}`;

module.exports = {
  CONNECTION_STRING,
  captureLogger,
  defineController,
  deferred,
  delay,
  emulatorAvailable,
  runId,
  startMicroservice,
  timeoutAfter,
};
