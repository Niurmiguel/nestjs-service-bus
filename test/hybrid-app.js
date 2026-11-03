"use strict";
// A NestJS hybrid application (an HTTP application with microservices
// connected to it) for the tests, without an HTTP platform package.
//
// The HTTP side is a stub: it serves nothing and is never listened on. What
// the tests exercise is what Nest does for real in a hybrid application: one
// ListenersController registering the handlers of every controller on every
// connected server, and startAllMicroservices() calling listen() on each.
require("reflect-metadata");

const net = require("node:net");
const { AbstractHttpAdapter, NestFactory } = require("@nestjs/core");

/** The HTTP adapter calls Nest makes while creating, initializing and closing an app. */
class StubHttpAdapter extends AbstractHttpAdapter {
  constructor() {
    super({});
  }
  initHttpServer() {
    this.httpServer = {};
  }
  getHttpServer() {
    return this.httpServer;
  }
  getType() {
    return "stub";
  }
  registerParserMiddleware() {}
  setNotFoundHandler() {}
  setErrorHandler() {}
  async close() {}
}

/** A TCP port free right now, for a Nest TCP microservice. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Creates a hybrid application with `module` and connects `microservices`
 * (each the options of `connectMicroservice()`), then starts them all.
 */
async function startHybridApp(module, microservices, { logger } = {}) {
  const app = await NestFactory.create(module, new StubHttpAdapter(), {
    logger: logger ?? false,
  });
  for (const options of microservices) {
    app.connectMicroservice(options, { inheritAppConfig: true });
  }
  try {
    await app.startAllMicroservices();
    await app.init();
  } catch (err) {
    await app.close().catch(() => undefined);
    throw err;
  }
  return app;
}

module.exports = { StubHttpAdapter, freePort, startHybridApp };
