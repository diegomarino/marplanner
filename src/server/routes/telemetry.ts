import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerRoutesWithCapabilities } from "../auth/capability";
import { writeClientLog, getClientLogPage } from "../telemetry/index";
import { getBuildInfo } from "../lib/build-info";
import type { ClientLogLevel, SystemStatus } from "../../shared";

const VALID_LEVELS: ReadonlySet<string> = new Set(["debug", "info", "warn", "error"]);

/** Thin HTTP boundary for the telemetry ingest + admin-read routes. Both routes
 * declare their capability via `registerRoutesWithCapabilities` — omitting one would
 * throw at registration (fail-closed).
 * POST is ALWAYS 200 `{accepted, dropped}` for a structurally parseable body (best-effort
 * at-most-once, FR-002/FR-003); 400 only for a body that isn't `{ entries: [...] }` at all —
 * that includes an unknown TOP-LEVEL key (the contract's `ClientLogBatch` is
 * `additionalProperties: false`). Unknown keys INSIDE one entry stay a per-entry
 * drop (`writeClientLog`'s validation), never a batch-level 400.
 * GET implements the COMPLETE documented surface — level/component/from/to filters,
 * `received_at DESC, id DESC`, hard cap 50 (an unrecognized `limit` query param is silently
 * ignored, never a 400 — the server cap always wins).
 */
export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  registerRoutesWithCapabilities(app, [
    {
      method: "post",
      path: "/api/telemetry/client-log",
      capability: "telemetry:write",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body;
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return reply.code(400).send({
            error: "validation_error",
            message: "Request body must be { entries: [...] }",
          });
        }

        const bodyObj = body as Record<string, unknown>;
        const unknownTopLevelKeys = Object.keys(bodyObj).filter((key) => key !== "entries");
        if (unknownTopLevelKeys.length > 0) {
          return reply.code(400).send({
            error: "validation_error",
            message: `Unsupported field(s) in telemetry batch body: ${unknownTopLevelKeys.join(", ")}`,
          });
        }
        if (!Array.isArray(bodyObj.entries)) {
          return reply.code(400).send({
            error: "validation_error",
            message: "Request body must be { entries: [...] }",
          });
        }

        const apiKeyId = (request as FastifyRequest & { apiKeyId: string }).apiKeyId;
        const result = writeClientLog(apiKeyId, bodyObj.entries);
        return reply.code(200).send(result);
      },
    },
    {
      method: "get",
      path: "/api/telemetry/client-log",
      capability: "telemetry:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        // Only level/component/from/to/cursor are recognized. Any other query param (e.g. an
        // unknown `limit`) is silently ignored — never validated, never a 400 (the server's
        // hard cap of 50 always wins regardless of what the client asks for).
        const query = request.query as Record<string, unknown>;

        const levelRaw = query.level;
        if (
          levelRaw !== undefined &&
          (typeof levelRaw !== "string" || !VALID_LEVELS.has(levelRaw))
        ) {
          return reply
            .code(400)
            .send({ error: "validation_error", message: "Invalid level filter" });
        }
        const level = levelRaw as ClientLogLevel | undefined;

        const componentRaw = query.component;
        if (componentRaw !== undefined && typeof componentRaw !== "string") {
          return reply
            .code(400)
            .send({ error: "validation_error", message: "Invalid component filter" });
        }
        const component = componentRaw as string | undefined;

        const INVALID = Symbol("invalid");
        const parseBound = (raw: unknown): number | undefined | typeof INVALID => {
          if (raw === undefined) return undefined;
          if (typeof raw !== "string" || raw.length === 0) return INVALID;
          const num = Number(raw);
          return Number.isFinite(num) ? num : INVALID;
        };

        const from = parseBound(query.from);
        if (from === INVALID) {
          return reply
            .code(400)
            .send({ error: "validation_error", message: "Invalid from filter" });
        }
        const to = parseBound(query.to);
        if (to === INVALID) {
          return reply.code(400).send({ error: "validation_error", message: "Invalid to filter" });
        }

        const cursorRaw = query.cursor;
        if (cursorRaw !== undefined && typeof cursorRaw !== "string") {
          return reply.code(400).send({ error: "validation_error", message: "Invalid cursor" });
        }
        const cursor = cursorRaw as string | undefined;

        const page = getClientLogPage({ level, component, from, to, cursor });
        if (page === null) {
          return reply
            .code(400)
            .send({ error: "validation_error", message: "Invalid filter or cursor" });
        }
        return reply.code(200).send(page);
      },
    },
    {
      method: "get",
      path: "/api/telemetry/system-status",
      capability: "telemetry:admin",
      // Admin-only on purpose: the public /health probe must not disclose what is deployed.
      handler: async (_request: FastifyRequest, reply: FastifyReply) => {
        const status: SystemStatus = {
          status: "ok",
          checkedAt: new Date().toISOString(),
          uptimeSeconds: Math.floor(process.uptime()),
          build: getBuildInfo(),
        };
        return reply.code(200).send(status);
      },
    },
  ]);
}
