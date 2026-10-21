/** `documented()` keeps route schemas documentation-only: a status listed in the schema must not
 * change the bytes Fastify sends. Each case registers a documented route and a schemaless twin
 * and requires byte-identical bodies — the twin is the pre-code-first behaviour. */
import Fastify, { type FastifyInstance, type RouteHandlerMethod } from "fastify";
import { describe, expect, it } from "vitest";
import { ErrorSchema } from "../../src/server/openapi/common.js";
import { documented } from "../../src/server/openapi/zod.js";

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ErrorSchema } },
});

const schema = {
  operationId: "documentedErrorsProbe",
  tags: ["test"],
  response: {
    200: errorResponse("ok"),
    400: errorResponse("bad request"),
    409: errorResponse("conflict"),
    500: errorResponse("internal"),
  },
};

async function withTwins(
  method: "GET" | "POST",
  handler: RouteHandlerMethod,
  run: (app: FastifyInstance) => Promise<void>
): Promise<void> {
  const app = Fastify();
  app.route({ method, url: "/plain", handler });
  app.route({ method, url: "/documented", handler, ...documented(schema) });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

async function expectSameResponse(
  app: FastifyInstance,
  request: { method: "GET" | "POST"; headers?: Record<string, string>; payload?: string },
  status: number
): Promise<void> {
  const plain = await app.inject({ ...request, url: "/plain" });
  const documentedResponse = await app.inject({ ...request, url: "/documented" });
  expect(plain.statusCode).toBe(status);
  expect(documentedResponse.statusCode).toBe(status);
  expect(documentedResponse.body).toBe(plain.body);
  expect(documentedResponse.headers["content-type"]).toBe(plain.headers["content-type"]);
}

describe("documented() route schemas do not change Fastify error bodies", () => {
  it("a thrown Error at a documented 500 keeps Fastify's error envelope", async () => {
    await withTwins(
      "GET",
      async () => {
        throw new Error("synthetic failure");
      },
      async (app) => {
        await expectSameResponse(app, { method: "GET" }, 500);
        const body = JSON.parse((await app.inject({ method: "GET", url: "/documented" })).body);
        expect(body).toEqual({
          statusCode: 500,
          error: "Internal Server Error",
          message: "synthetic failure",
        });
      }
    );
  });

  it("a thrown Error carrying a code and statusCode keeps both at a documented status", async () => {
    await withTwins(
      "GET",
      async () => {
        throw Object.assign(new Error("already taken"), { statusCode: 409, code: "E_TAKEN" });
      },
      async (app) => {
        await expectSameResponse(app, { method: "GET" }, 409);
      }
    );
  });

  it("Fastify's malformed-JSON rejection at a documented 400 keeps its error envelope", async () => {
    await withTwins(
      "POST",
      async () => ({ ok: true }),
      async (app) => {
        const request = {
          method: "POST" as const,
          headers: { "content-type": "application/json" },
          payload: "{bad",
        };
        await expectSameResponse(app, request, 400);
        const body = JSON.parse((await app.inject({ ...request, url: "/documented" })).body);
        expect(body.code).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
      }
    );
  });

  it("a plain-object reply at a documented status is sent unchanged", async () => {
    await withTwins(
      "GET",
      async (_request, reply) =>
        reply.code(400).send({ error: "validation_error", message: "bad input" }),
      async (app) => {
        await expectSameResponse(app, { method: "GET" }, 400);
      }
    );
  });
});
