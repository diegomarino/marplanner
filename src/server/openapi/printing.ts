// Code-first OpenAPI: route schemas for the printing HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { AuthUnauthorized, PluginUnavailable, authenticationBackoffResponse } from "./common";

export const CapabilityResponse = component(
  "CapabilityResponse",
  z.strictObject({
    registered: z.boolean().meta({
      description:
        "always true on 200 — the calling session's key is now print-capable (FR-021, ADR-035)",
    }),
  })
);

export const PrintJob = component(
  "PrintJob",
  z.strictObject({
    id: z.string(),
    recordKey: z.string(),
    outputRef: z.string().meta({
      description:
        "the producer's artifact reference — the raster is fetched via the producer's registered interface at execute (ADR-041)",
    }),
    targetDate: z.string().meta({ description: "YYYY-MM-DD household date" }),
    memberId: z.string().nullable().optional(),
    state: z.enum(["pending", "claimed", "printed", "failed", "cancelled"]),
    derivedState: z
      .enum(["pending", "claimed", "printed", "failed", "cancelled", "dead-letter", "retrying"])
      .meta({ description: "read-time refinement (Constitution V)" }),
    attempts: z
      .int()
      .meta({ description: "recoverable-failure count (contract retry vocabulary)" }),
    failureReason: z.string().nullable().optional(),
    claimedAt: z.int().nullable().optional(),
    printedAt: z.int().nullable().optional(),
    createdAt: z.int(),
    updatedAt: z.int(),
  })
);

export const ClaimResponse = component(
  "ClaimResponse",
  z.strictObject({ job: PrintJob, leaseToken: z.string(), leaseExpiresAt: z.int() })
);

export const JobsListResponse = component(
  "JobsListResponse",
  z.strictObject({ jobs: z.array(PrintJob) })
);

export const PrintingErrorResponse = component(
  "PrintingErrorResponse",
  z.strictObject({
    error: z.string(),
    message: z.string().optional(),
    code: z
      .string()
      .meta({
        description:
          "machine code, present on a subset of errors: `printer_capability_missing` (403, FR-021) and `render_failure` (422, FR-017) are the two this contract maps with one; a plain 400 validation error omits it.",
      })
      .optional(),
  })
);

export const PrintingStatusResponse = component(
  "PrintingStatusResponse",
  z.strictObject({
    active: z.boolean().meta({
      description:
        "current printing-plugin-active state (INV-06); the client-side read FR-013's family-facing hiding gates on (issue 691) — PrintExecutor and the admin nav entry for PrintingManagement both hide when false",
    }),
  })
);

export const ResetTodayPrintsResponse = component(
  "ResetTodayPrintsResponse",
  z.strictObject({
    targetDate: z
      .string()
      .meta({ description: "household-local today (YYYY-MM-DD) whose print records were reset" }),
    resetRecords: z
      .int()
      .min(0)
      .meta({ description: "print records made printable again (superseded)" }),
    cancelledJobs: z.int().min(0).meta({
      description: "pending or claimed-not-yet-fetched jobs cancelled; fetched jobs finish (H2)",
    }),
  })
);

export const TestPrintResponse = component(
  "TestPrintResponse",
  z.strictObject({
    enqueued: z.boolean(),
    jobId: z.string().nullable().optional(),
    alreadyPrinted: z
      .boolean()
      .meta({ description: "true when FR-012 dedup suppressed the enqueue" })
      .optional(),
  })
);

export const printingSchemas = defineRouteSchemas({
  /** POST /api/printing/capability */
  postPrintingCapability: {
    operationId: "postPrintingCapability",
    tags: ["printing"],
    summary:
      "register this session as print-capable on pairing (ADR-035, FR-021 — `/claim` requires it)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "capability registered for the session's key (idempotent)",
        content: { "application/json": { schema: CapabilityResponse } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      403: {
        description:
          'defensive only, `code: "credential_invalid"` — no authenticated API key on the request (should never occur past authBoundary); this route has no OTHER 403 cause (unlike /claim below, it never checks an EXISTING capability, only writes one)',
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      409: {
        description: "printing plugin inactive (FR-013)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/printing/claim */
  postPrintingClaim: {
    operationId: "postPrintingClaim",
    tags: ["printing"],
    summary:
      "executor claim — atomic, day-scoped (research D1); requires the session's registered printer capability (FR-021, ADR-035)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "one job claimed with a fresh lease",
        content: { "application/json": { schema: ClaimResponse } },
      },
      204: noContent("nothing claimable"),
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      403: {
        description:
          'TWO causes, both `ErrorResponse`: session has no registered printer capability, `code: "printer_capability_missing"` (FR-021 — the common case); OR, defensively, no authenticated API key on the request, `code: "credential_invalid"` (should never occur past authBoundary)',
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      409: {
        description: "printing plugin inactive (FR-013)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/printing/jobs */
  getPrintingJobs: {
    operationId: "getPrintingJobs",
    tags: ["printing"],
    summary: "admin list with derived states (SC-003 visibility)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "all jobs with derived states",
        content: { "application/json": { schema: JobsListResponse } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
  /** POST /api/printing/jobs/{id}/ack */
  postPrintingJobsByIdAck: {
    operationId: "postPrintingJobsByIdAck",
    tags: ["printing"],
    summary: "byte-level success acknowledgement (ADR-019, FR-004/FR-008)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: z.strictObject({ leaseToken: z.string() }),
    response: {
      200: {
        description: "printedAt stamped, `printing.completed` emitted (idempotent per lease)",
        content: { "application/json": { schema: PrintJob } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      404: {
        description: "unknown job id",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      409: {
        description: "stale lease token — no state change (INV-05)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/printing/jobs/{id}/fail */
  postPrintingJobsByIdFail: {
    operationId: "postPrintingJobsByIdFail",
    tags: ["printing"],
    summary:
      "executor-reported transport failure — recoverable → attempts+1 and immediately re-claimable; permanent codes → dead-letter (FR-009)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: z.strictObject({
      leaseToken: z.string(),
      reason: z.string(),
      permanentCode: z
        .enum(["render_failure", "unsupported_transport", "secure_context"])
        .nullable()
        .meta({
          description:
            "present only when the executor knows the failure is permanent (contract vocabulary)",
        })
        .optional(),
    }),
    response: {
      200: {
        description: "failure recorded; lease released or job dead-lettered",
        content: { "application/json": { schema: PrintJob } },
      },
      400: {
        description: "malformed body — missing/invalid `reason` or `permanentCode`",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      404: {
        description: "unknown job id",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      409: {
        description: "stale lease token (INV-05)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/printing/jobs/{id}/payload */
  getPrintingJobsByIdPayload: {
    operationId: "getPrintingJobsByIdPayload",
    tags: ["printing"],
    summary:
      "fetch final ESC/POS bytes — raster pulled from the producer's provider and converted at fetch time (FR-017, ADR-066)",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    querystring: z.object({ leaseToken: z.string() }),
    response: {
      200: {
        description: "the job's final printer-ready ESC/POS byte stream",
        content: { "application/octet-stream": { schema: z.string().meta({ format: "binary" }) } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      404: {
        description: "unknown job id",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      409: {
        description: "stale/rotated lease token (INV-05 fencing)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      422: {
        description:
          "permanent conversion failure (`render_failure`) — job dead-letters, `printing.failed` emitted (FR-017)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/printing/reset-today */
  postPrintingResetToday: {
    operationId: "postPrintingResetToday",
    tags: ["printing"],
    summary:
      'admin "reset today\'s print" (FR-016) — supersede every print record of household-today so it can print again; cancels pending and claimed-not-yet-fetched jobs. Takes no body.',
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "today's print records were reset (zero counts when nothing existed)",
        content: { "application/json": { schema: ResetTodayPrintsResponse } },
      },
      400: {
        description: "a request body with any field",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      409: {
        description: "printing plugin inactive (FR-013)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
  /** GET /api/printing/status */
  getPrintingStatus: {
    operationId: "getPrintingStatus",
    tags: ["printing"],
    summary:
      "client-side plugin-state read (FR-013, issue 691) — no capability gate (a plain read, matching /jobs GET's own posture, not a printer-session action)",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "current plugin-active state",
        content: { "application/json": { schema: PrintingStatusResponse } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/printing/test-print */
  postPrintingTestPrint: {
    operationId: "postPrintingTestPrint",
    tags: ["printing"],
    summary:
      'admin trigger — enqueue the test printable (FR-018; dedup per FR-012). Body is OPTIONAL; an omitted/absent `targetDate` defaults to the household-local "today" (research D10).',
    security: [{ deviceKeyCookie: [] }],
    body: z.strictObject({
      targetDate: z
        .string()
        .meta({
          description:
            "override for the trigger's target date — MUST be strictly calendar-valid YYYY-MM-DD (Constitution IV); the one HTTP-reachable seam for this slice's target_date validity check",
        })
        .optional(),
    }),
    "x-mp-body-optional": true,
    response: {
      200: {
        description: "trigger evaluated — enqueued, or dedup-suppressed",
        content: { "application/json": { schema: TestPrintResponse } },
      },
      400: {
        description:
          "malformed body, or `targetDate` is not strictly calendar-valid (Constitution IV)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      401: {
        description:
          "Missing, ambiguous or invalid API credential (shared authentication boundary).",
        content: { "application/json": { schema: AuthUnauthorized } },
      },
      409: {
        description: "printing plugin inactive (FR-013)",
        content: { "application/json": { schema: PrintingErrorResponse } },
      },
      429: authenticationBackoffResponse,
    },
  },
});
