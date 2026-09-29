import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  enqueueTestPrint,
  claimJob,
  getPayload,
  ackJob,
  failJob,
  listJobs,
  registerPrinterCapability,
  isPrintingPluginActive,
  PrintJobNotFoundError,
  PrintLeaseStaleError,
  PrintCapabilityMissingError,
  PrintingPluginInactiveError,
  PrintRenderFailureError,
  PrintValidationError,
} from "../modules/printing/index";
import { AUTH_CREDENTIAL_INVALID_CODE } from "../../shared";
import type { PrintFailureErrorCode } from "../../shared";

/** Authenticated printing routes pass request.apiKeyId through capability registration
 * and every claim. Printer-capability denial is distinct from API-key scope denial.
 * The plugin gate and core state machine fence inactive work and stale leases.
 * Domain failures map to the closed error envelopes in docs/api/printing/openapi.yaml.
 */
export async function printingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/printing/test-print", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body === undefined ? {} : request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Request body must be an object" });
    }
    const unknownKeys = Object.keys(body).filter((key) => key !== "targetDate");
    if (unknownKeys.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Unsupported field(s) in test-print body: ${unknownKeys.join(", ")}`,
      });
    }
    const { targetDate } = body as { targetDate?: unknown };
    if (targetDate !== undefined && typeof targetDate !== "string") {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "targetDate must be a string" });
    }
    try {
      const result = enqueueTestPrint(Date.now(), targetDate as string | undefined);
      return reply.code(200).send(result);
    } catch (err) {
      return handlePrintingError(err, reply);
    }
  });

  app.get("/api/printing/jobs", async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = listJobs(Date.now());
    return reply.code(200).send(result);
  });

  // FR-013: the client-side plugin-state read family-facing surfaces gate on.
  // `PrintExecutor` (kiosk-wide, mounted unconditionally by Shell.tsx) and the admin nav entry
  // for `PrintingManagement` both hide when `active: false` — no capability gate here, matching
  // this file's own `/jobs` GET precedent (a plain read, not a printer-session action).
  app.get("/api/printing/status", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send({ active: isPrintingPluginActive() });
  });

  app.post("/api/printing/capability", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isPrintingPluginActive()) {
      return reply
        .code(409)
        .send({ error: "plugin_inactive", message: "Printing plugin is inactive" });
    }
    const sessionKeyId = getSessionKeyId(request);
    if (!sessionKeyId) {
      return reply.code(403).send({
        error: "forbidden",
        message: "No authenticated API key",
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    }
    registerPrinterCapability(sessionKeyId, Date.now());
    return reply.code(200).send({ registered: true });
  });

  app.post("/api/printing/claim", async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionKeyId = getSessionKeyId(request);
    if (!sessionKeyId) {
      return reply.code(403).send({
        error: "forbidden",
        message: "No authenticated API key",
        code: AUTH_CREDENTIAL_INVALID_CODE,
      });
    }
    try {
      const claimed = claimJob(Date.now(), sessionKeyId);
      if (!claimed) return reply.code(204).send();
      return reply.code(200).send(claimed);
    } catch (err) {
      return handlePrintingError(err, reply);
    }
  });

  app.get(
    "/api/printing/jobs/:id/payload",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const { leaseToken } = request.query as { leaseToken?: string };
      if (!leaseToken) {
        return reply
          .code(409)
          .send({ error: "stale_lease", message: "leaseToken query parameter is required" });
      }
      try {
        const payload = getPayload(id, leaseToken, Date.now());
        return reply.code(200).header("content-type", "application/octet-stream").send(payload);
      } catch (err) {
        return handlePrintingError(err, reply);
      }
    }
  );

  app.post("/api/printing/jobs/:id/ack", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { leaseToken } = (request.body ?? {}) as { leaseToken?: string };
    if (!leaseToken) {
      return reply
        .code(409)
        .send({ error: "stale_lease", message: "leaseToken is required in the request body" });
    }
    try {
      const job = ackJob(id, leaseToken, Date.now());
      return reply.code(200).send(job);
    } catch (err) {
      return handlePrintingError(err, reply);
    }
  });

  app.post("/api/printing/jobs/:id/fail", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const body = request.body === undefined ? {} : request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Request body must be an object" });
    }
    const ALLOWED_KEYS = new Set(["leaseToken", "reason", "permanentCode"]);
    const unknownKeys = Object.keys(body).filter((key) => !ALLOWED_KEYS.has(key));
    if (unknownKeys.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Unsupported field(s) in fail body: ${unknownKeys.join(", ")}`,
      });
    }
    const { leaseToken, reason, permanentCode } = body as {
      leaseToken?: unknown;
      reason?: unknown;
      permanentCode?: unknown;
    };
    // Missing/malformed leaseToken maps the SAME way as ack/payload above (409 stale_lease) —
    // matching this file's own established convention for the lease-token gate, not a separate
    // 400 class of error.
    if (typeof leaseToken !== "string" || leaseToken.length === 0) {
      return reply
        .code(409)
        .send({ error: "stale_lease", message: "leaseToken is required in the request body" });
    }
    if (typeof reason !== "string" || reason.length === 0) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "reason is required and must be a string" });
    }
    const PERMANENT_CODES: PrintFailureErrorCode[] = [
      "render_failure",
      "unsupported_transport",
      "secure_context",
    ];
    if (
      permanentCode !== undefined &&
      permanentCode !== null &&
      !PERMANENT_CODES.includes(permanentCode as PrintFailureErrorCode)
    ) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Invalid permanentCode "${String(permanentCode)}"`,
      });
    }
    try {
      const job = failJob(
        id,
        leaseToken,
        Date.now(),
        reason,
        permanentCode as PrintFailureErrorCode | null | undefined
      );
      return reply.code(200).send(job);
    } catch (err) {
      return handlePrintingError(err, reply);
    }
  });
}

/** `authBoundary` (app.ts) attaches `apiKeyId` to every authenticated `/api/*` request before any
 * route handler runs — mirrors `src/server/auth/capability.ts`'s own extraction (the rework
 * this module studied). Returns `undefined` only in the defensive case that should never occur on a
 * route reached past `authBoundary`. */
function getSessionKeyId(request: FastifyRequest): string | undefined {
  return (request as FastifyRequest & { apiKeyId?: string }).apiKeyId;
}

function handlePrintingError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof PrintJobNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof PrintLeaseStaleError) {
    return reply.code(409).send({ error: "stale_lease", message: err.message });
  }
  if (err instanceof PrintingPluginInactiveError) {
    return reply.code(409).send({ error: "plugin_inactive", message: err.message });
  }
  if (err instanceof PrintCapabilityMissingError) {
    return reply.code(403).send({ error: "forbidden", message: err.message, code: err.code });
  }
  if (err instanceof PrintRenderFailureError) {
    return reply.code(422).send({ error: "render_failure", message: err.message, code: err.code });
  }
  if (err instanceof PrintValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  // Unexpected error
  console.error("Unexpected error in printing handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
