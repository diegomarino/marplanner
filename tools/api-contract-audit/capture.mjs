// Synthetic tests only. Capture through Fastify's native instrumentation event.
import { closeSync, openSync, writeSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import { afterAll, expect } from "vitest";
import { captureRoute } from "./capture-route.mjs";

const initialization = channel("fastify.initialization");
// appendFileSync delegates to the exported fs.writeFileSync, which tests may spy on.
function appendObservation(line) {
  const fd = openSync(process.env.MP_CONTRACT_OBSERVATIONS, "a");
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}
function capture({ fastify }) {
  const requests = new WeakMap();
  fastify.addHook("preValidation", (request, _reply, done) => {
    requests.set(request, request.body === undefined ? undefined : structuredClone(request.body));
    done();
  });
  fastify.addHook("onSend", (request, reply, payload, done) => {
    const type = String(reply.getHeader("content-type") ?? "");
    // Streams and binary payloads require separate transport checks.
    if (payload == null || typeof payload === "string") {
      appendObservation(
        JSON.stringify({
          method: request.method,
          route: captureRoute({
            method: request.method,
            route: request.routeOptions.url,
            url: request.url,
            status: reply.statusCode,
            contentType: type,
            payload,
          }),
          status: reply.statusCode,
          test: expect.getState().currentTestName,
          contentType: type,
          requestContentType: request.headers["content-type"],
          requestBody: request.headers["content-type"]?.includes("application/json")
            ? requests.get(request)
            : undefined,
          body:
            type.includes("application/json") && payload ? JSON.parse(payload) : (payload ?? ""),
        }) + "\n"
      );
    }
    done(null, payload);
  });
}
initialization.subscribe(capture);
afterAll(() => initialization.unsubscribe(capture));
