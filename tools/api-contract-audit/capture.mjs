// Synthetic tests only. Capture through Fastify's native instrumentation event.
import { appendFileSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import { afterAll, expect } from "vitest";

const initialization = channel("fastify.initialization");
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
      appendFileSync(
        process.env.MP_CONTRACT_OBSERVATIONS,
        JSON.stringify({
          method: request.method,
          route: request.routeOptions.url,
          status: reply.statusCode,
          test: expect.getState().currentTestName,
          contentType: type,
          requestContentType: request.headers["content-type"],
          requestBody: requests.get(request),
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
