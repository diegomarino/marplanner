// Code-first OpenAPI: route schemas for the daily-briefing HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas } from "./zod";
import { Weekday, authenticationBackoffResponse } from "./common";

export const AutoPrintTrigger = component(
  "AutoPrintTrigger",
  z.enum(["morning_complete"]).nullable()
);

export const BlockType = component(
  "BlockType",
  z.enum([
    "calendar",
    "chores",
    "shotgun",
    "message",
    "streak",
    "today",
    "weather",
    "meals",
    "birthday",
    "reminders",
    "dadJoke",
    "wordOfDay",
    "animalFact",
    "numberFact",
    "onThisDay",
    "quoteOfDay",
    "trivia",
    "riddle",
    "wouldYouRather",
    "wordSearch",
    "drawingPrompt",
    "streakText",
    "weatherText",
  ])
);

export const BlockScope = component("BlockScope", z.enum(["shared", "member"]));

export const BlockParams = component(
  "BlockParams",
  z.strictObject({
    level: z.enum(["L1", "L2", "L3", "L4"]).optional(),
    difficulty: z.string().optional(),
    language: z
      .string()
      .meta({ description: "validated against corpus availability (FR-009)" })
      .optional(),
  }),
  {
    description:
      "Closed per-instance params (mirrors settings.ts ALLOWED_PARAM_KEYS; unknown keys are rejected 400 by validateParams —  fold closed this schema to match).",
  }
);

export const BlockInstance = component(
  "BlockInstance",
  z.strictObject({
    type: BlockType,
    scope: BlockScope,
    status: z.enum(["ok", "failed"]),
    data: z
      .unknown()
      .meta({ description: "Frozen block data, present for successful blocks." })
      .optional(),
    error: z.string().optional(),
    index: z.int().min(1).optional(),
    title: z.string().optional(),
    language: z.string().optional(),
    params: BlockParams.optional(),
  })
);

export const BlockOrderInstance = component(
  "BlockOrderInstance",
  z.strictObject({ type: z.string(), params: BlockParams.optional() })
);

export const BriefingStatus = component(
  "BriefingStatus",
  z.enum(["pending", "ready", "partial", "failed", "render-failed"])
);

export const MemberIdentitySnapshot = component(
  "MemberIdentitySnapshot",
  z.strictObject({ id: z.string(), displayName: z.string() })
);

export const BriefingPayload = component(
  "BriefingPayload",
  z.strictObject({
    schemaVersion: z.literal([1, 2]).meta({ type: "integer" }),
    member: MemberIdentitySnapshot,
    date: z.string().meta({ description: "YYYY-MM-DD household-tz business date" }),
    blocks: z.array(BlockInstance),
  }),
  {
    allOf: [
      {
        if: { properties: { schemaVersion: { const: 1 } }, required: ["schemaVersion"] },
        then: {
          properties: {
            blocks: {
              items: {
                properties: {
                  type: { enum: ["calendar", "reminders", "chores", "meals", "weather"] },
                },
              },
            },
          },
        },
        else: {
          properties: {
            blocks: {
              items: {
                properties: {
                  type: {
                    enum: [
                      "shotgun",
                      "message",
                      "streak",
                      "today",
                      "weather",
                      "meals",
                      "birthday",
                      "reminders",
                      "dadJoke",
                      "wordOfDay",
                      "animalFact",
                      "numberFact",
                      "onThisDay",
                      "quoteOfDay",
                      "trivia",
                      "riddle",
                      "wouldYouRather",
                      "wordSearch",
                      "drawingPrompt",
                      "streakText",
                      "weatherText",
                    ],
                  },
                },
              },
            },
          },
        },
      },
    ],
  }
);

export const Briefing = component(
  "Briefing",
  z.strictObject({
    id: z.string(),
    memberId: z.string(),
    date: z.string(),
    status: BriefingStatus,
    payload: BriefingPayload,
    createdAt: z.int(),
    updatedAt: z.int(),
  })
);

export const BriefingHistoryEntry = component(
  "BriefingHistoryEntry",
  z.strictObject({ id: z.string(), date: z.string(), status: BriefingStatus, updatedAt: z.int() })
);

export const BriefingHistoryResponse = component(
  "BriefingHistoryResponse",
  z.strictObject({
    today: z.string().meta({ description: "household-timezone business date (YYYY-MM-DD)." }),
    entries: z.array(BriefingHistoryEntry).max(30),
  })
);

export const BriefingPreviewRendering = component(
  "BriefingPreviewRendering",
  z.strictObject({ status: z.enum(["rendering"]) })
);

export const BriefingPrintResponse = component(
  "BriefingPrintResponse",
  z.strictObject({
    jobId: z.string(),
    enqueued: z.boolean().meta({
      description: "false when a job for this briefing was already waiting and was reused.",
    }),
  })
);

export const PrintedStatus = component(
  "PrintedStatus",
  z.enum(["completed", "failed", "none", "unavailable"]),
  {
    description:
      "Derived (research D11) — see this file's own `/api/daily-briefing/{memberId}/{date}` GET description for the full derivation. Never stored as Printing's own canonical state.",
  }
);

export const BriefingReadResultV2 = component(
  "BriefingReadResultV2",
  z.xor([
    z.strictObject({ generated: z.literal(false) }),
    z.strictObject({
      generated: z.literal(true),
      briefing: Briefing,
      printedStatus: PrintedStatus,
    }),
  ]),
  { description: "Pure read result with derived printed status for generated briefings." }
);

export const BriefingSchedule = component(
  "BriefingSchedule",
  z.strictObject({ memberId: z.string(), weekdays: z.array(Weekday) })
);

export const BriefingScheduleInput = component(
  "BriefingScheduleInput",
  z.strictObject({ weekdays: z.array(Weekday) })
);

export const CorpusLanguageUnavailableErrorResponse = component(
  "CorpusLanguageUnavailableErrorResponse",
  z.strictObject({ error: z.enum(["corpus_language_unavailable"]), message: z.string() })
);

export const DailyBriefingSettingsInput = component(
  "DailyBriefingSettingsInput",
  z.strictObject({
    generationTime: z.string().meta({ description: "strict 24h HH:MM" }).optional(),
    autoPrintTrigger: AutoPrintTrigger.optional(),
  })
);

export const DailyBriefingSettingsSnapshot = component(
  "DailyBriefingSettingsSnapshot",
  z.strictObject({
    generationTime: z.string().meta({ description: "strict 24h HH:MM" }),
    autoPrintTrigger: AutoPrintTrigger,
    updatedAt: z.int().nullable().meta({ description: "epoch-ms; null when no row exists yet" }),
  })
);

export const MemberBlockSettings = component(
  "MemberBlockSettings",
  z.strictObject({
    memberId: z.string(),
    blockType: z.string(),
    enabled: z.boolean(),
    weekdays: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .min(0)
      .nullable()
      .meta({
        description:
          "`null` = all days (no mask). A present array is validated against the canonical mon..sun set — an unknown value is rejected 400, never silently dropped, so the persisted set always round-trips to EXACTLY what was accepted. `[]` (minItems: 0) is a distinct, legitimate third state from `null`: the block is masked out on every weekday, i.e. it never runs — 's generation-time weekday mask must not treat `[]` and `null` as equivalent (P2-3, batch-B review).",
      }),
    params: z.xor([BlockParams, z.null()]),
    updatedAt: z.int().nullable(),
  })
);

export const DailyBriefingSettingsView = component(
  "DailyBriefingSettingsView",
  z.strictObject({
    generationTime: z.string(),
    autoPrintTrigger: AutoPrintTrigger,
    blockOrder: z.array(BlockOrderInstance),
    memberBlockSettings: z.array(MemberBlockSettings),
    memberSchedules: z.array(BriefingSchedule).meta({
      description: "stored weekday pause schedules; members without one run every day (FR-023).",
    }),
  })
);

export const FastifyParseErrorResponse = component(
  "FastifyParseErrorResponse",
  z.strictObject({
    statusCode: z.literal([400]).meta({ type: "integer" }),
    code: z.enum(["FST_ERR_CTP_INVALID_JSON_BODY", "FST_ERR_CTP_EMPTY_JSON_BODY"]),
    error: z.enum(["Bad Request"]),
    message: z.string(),
  })
);

export const ForbiddenErrorResponse = component(
  "ForbiddenErrorResponse",
  z.strictObject({
    error: z.enum(["forbidden"]),
    message: z.string(),
    code: z
      .string()
      .meta({
        description:
          "machine code from the shared auth boundary/capability seam (src/server/auth/boundary.ts + src/server/auth/capability.ts, fix #682) — `credential_invalid` (dead key: revoked/expired) or `scope_denied` (live key, denied on scope grounds) on a 403 from these cross-cutting preHandlers; optional here since older/other 403 emitters may not set it.",
      })
      .optional(),
  })
);

export const GenerateAllInput = component(
  "GenerateAllInput",
  z.strictObject({
    date: z
      .string()
      .nullable()
      .meta({
        description:
          "optional YYYY-MM-DD household-tz business date; defaults to household-tz today.",
      })
      .optional(),
  })
);

export const GenerateAllResponse = component(
  "GenerateAllResponse",
  z.xor([
    z.looseObject({
      status: z.enum(["completed"]),
      count: z.int(),
      generated: z.array(z.looseObject({ memberId: z.string(), status: BriefingStatus })),
    }),
    z.looseObject({ status: z.enum(["already_running"]) }),
  ]),
  {
    description:
      " US2: routed through the background-jobs scheduler's shared in-flight guard. `already_running` means a same-job run (scheduled, catch-up, or another manual call) was already in flight — no generation happened and no duplicate rows were written.\n",
  }
);

export const GenerateInput = component(
  "GenerateInput",
  z.strictObject({
    memberId: z.string(),
    date: z
      .string()
      .nullable()
      .meta({
        description:
          "optional YYYY-MM-DD household-tz business date; defaults to household-tz today.",
      })
      .optional(),
  })
);

export const GenerateSkippedResponse = component(
  "GenerateSkippedResponse",
  z.strictObject({
    skipped: z.literal(true),
    reason: z.enum(["paused"]),
    memberId: z.string(),
    date: z.string(),
  })
);

export const InternalErrorResponse = component(
  "InternalErrorResponse",
  z.strictObject({ error: z.enum(["internal_error"]), message: z.string() })
);

export const MemberBlockSettingsInput = component(
  "MemberBlockSettingsInput",
  z.strictObject({
    enabled: z.boolean().optional(),
    weekdays: z
      .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
      .min(0)
      .nullable()
      .meta({
        description:
          "`null` = all days (no mask). A present array is validated against the canonical mon..sun set — an unknown value is rejected 400, never silently dropped, so the persisted set always round-trips to EXACTLY what was accepted. `[]` (minItems: 0) is a distinct, legitimate third state from `null`: the block is masked out on every weekday, i.e. it never runs — 's generation-time weekday mask must not treat `[]` and `null` as equivalent (P2-3, batch-B review).",
      })
      .optional(),
    params: z.xor([BlockParams, z.null()]).optional(),
  })
);

export const NotFoundErrorResponse = component(
  "NotFoundErrorResponse",
  z.strictObject({ error: z.enum(["not_found"]), message: z.string() })
);

export const OptInInput = component("OptInInput", z.strictObject({ enabled: z.boolean() }));

export const OptInState = component(
  "OptInState",
  z.looseObject({ memberId: z.string(), enabled: z.boolean() })
);

export const PrintableRasterMissingErrorResponse = component(
  "PrintableRasterMissingErrorResponse",
  z.strictObject({ error: z.enum(["printable_raster_missing"]), message: z.string() })
);

export const PrintingPluginInactiveErrorResponse = component(
  "PrintingPluginInactiveErrorResponse",
  z.strictObject({ error: z.enum(["plugin_inactive"]), message: z.string() })
);

export const UnauthorizedErrorResponse = component(
  "UnauthorizedErrorResponse",
  z.strictObject({
    error: z.enum(["unauthorized"]),
    message: z.string(),
    code: z
      .string()
      .meta({
        description:
          "machine code from the shared auth boundary (src/server/auth/boundary.ts, fix #682) — always `credential_invalid` on a 401 from this cross-cutting preHandler; optional here since older/other 401 emitters may not set it.",
      })
      .optional(),
  })
);

export const ValidationErrorResponse = component(
  "ValidationErrorResponse",
  z.strictObject({ error: z.enum(["validation_error"]), message: z.string() })
);

export const dailyBriefingSchemas = defineRouteSchemas({
  /** PUT /api/daily-briefing/block-order */
  putDailyBriefingBlockOrder: {
    operationId: "putDailyBriefingBlockOrder",
    tags: ["daily-briefing"],
    summary: "Replace the ordered block-instance list (admin).",
    description:
      "Body is the ordered array itself (not wrapped). A type may repeat with distinct params (INV-05/ADR-044). Unknown types are REJECTED 400 at this write boundary (stricter than v1's silent-ignore); applies from the next generation only (FR-022).",
    security: [{ deviceKeyCookie: [] }],
    body: z.array(BlockOrderInstance),
    response: {
      200: {
        description: "the validated, persisted block order.",
        content: {
          "application/json": {
            schema: z.strictObject({ blockOrder: z.array(BlockOrderInstance) }),
          },
        },
      },
      400: {
        description:
          "not an array, an unknown block type, a malformed entry, or an unavailable `params.language` (400 `corpus_language_unavailable`, FR-009).",
        content: {
          "application/json": {
            schema: z.xor([
              ValidationErrorResponse,
              CorpusLanguageUnavailableErrorResponse,
              FastifyParseErrorResponse,
            ]),
          },
        },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** PUT /api/daily-briefing/block-settings/{memberId}/{blockType} */
  putDailyBriefingBlockSettingsByMemberIdByBlockType: {
    operationId: "putDailyBriefingBlockSettingsByMemberIdByBlockType",
    tags: ["daily-briefing"],
    summary: "Set one member's per-block settings — enabled/weekdays/params (admin).",
    description:
      'Partial update: an omitted field keeps its current persisted value, or the FR-013 default-resolution value (every type enabled EXCEPT `onThisDay`) for a row that does not exist yet. `weekdays: null` means "all days"; `params.language` is validated against on-disk corpus availability for `blockType` (FR-008/FR-009).',
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ memberId: z.string(), blockType: z.string() }),
    body: MemberBlockSettingsInput,
    response: {
      200: {
        description: "the updated per-member per-block settings.",
        content: { "application/json": { schema: MemberBlockSettings } },
      },
      400: {
        description:
          "an unknown block type, an inactive/nonexistent member, a bad weekday, or an unavailable `params.language` (400 `corpus_language_unavailable`, FR-009).",
        content: {
          "application/json": {
            schema: z.xor([
              ValidationErrorResponse,
              CorpusLanguageUnavailableErrorResponse,
              FastifyParseErrorResponse,
            ]),
          },
        },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** POST /api/daily-briefing/generate */
  postDailyBriefingGenerate: {
    operationId: "postDailyBriefingGenerate",
    tags: ["daily-briefing"],
    summary: "Manually generate a briefing for one opted-in active member/date (admin).",
    security: [{ deviceKeyCookie: [] }],
    body: GenerateInput,
    response: {
      200: {
        description:
          "generated briefing, or skipped because the member is paused on that weekday (FR-024).",
        content: { "application/json": { schema: z.xor([Briefing, GenerateSkippedResponse]) } },
      },
      400: {
        description: "invalid input, invalid date, inactive member, or member not opted-in.",
        content: {
          "application/json": {
            schema: z.xor([ValidationErrorResponse, FastifyParseErrorResponse]),
          },
        },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** POST /api/daily-briefing/generate-all */
  postDailyBriefingGenerateAll: {
    operationId: "postDailyBriefingGenerateAll",
    tags: ["daily-briefing"],
    summary: "Generate briefings for every active opted-in member (admin).",
    description:
      'Eligibility is active AND explicitly opted-in; opted-in archived members are skipped. The request date is strictly validated before candidate enumeration. Runs through the background-jobs scheduler\'s shared in-flight guard ( US2, ADR-014): a same-job run already in flight (scheduled, catch-up, or another manual call) returns `{status:"already_running"}` at 200 instead of racing a second generation.\n',
    security: [{ deviceKeyCookie: [] }],
    body: GenerateAllInput,
    "x-mp-body-optional": true,
    response: {
      200: {
        description: "generated briefing summary, or an already_running guard response.",
        content: { "application/json": { schema: GenerateAllResponse } },
      },
      400: {
        description: "invalid date or unknown request property.",
        content: {
          "application/json": {
            schema: z.xor([ValidationErrorResponse, FastifyParseErrorResponse]),
          },
        },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** GET /api/daily-briefing/history/{memberId} */
  getDailyBriefingHistoryByMemberId: {
    operationId: "getDailyBriefingHistoryByMemberId",
    tags: ["daily-briefing"],
    summary: "List a member's latest briefings, newest first (admin, FR-026).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ memberId: z.string() }),
    response: {
      200: {
        description: "household today plus at most 30 history entries; a pure read.",
        content: { "application/json": { schema: BriefingHistoryResponse } },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** GET /api/daily-briefing/opt-in */
  getDailyBriefingOptIn: {
    operationId: "getDailyBriefingOptIn",
    tags: ["daily-briefing"],
    summary: "List persisted Daily Briefing opt-in states (admin).",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "explicit per-member opt-in states; absent rows remain opt-out by default.",
        content: { "application/json": { schema: z.array(OptInState) } },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** PUT /api/daily-briefing/opt-in/{memberId} */
  putDailyBriefingOptInByMemberId: {
    operationId: "putDailyBriefingOptInByMemberId",
    tags: ["daily-briefing"],
    summary: "Set a member's Daily Briefing opt-in (admin).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ memberId: z.string() }),
    body: OptInInput,
    response: {
      200: {
        description: "updated opt-in state.",
        content: { "application/json": { schema: OptInState } },
      },
      400: {
        description: "invalid input or inactive member.",
        content: {
          "application/json": {
            schema: z.xor([ValidationErrorResponse, FastifyParseErrorResponse]),
          },
        },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** PUT /api/daily-briefing/schedule/{memberId} */
  putDailyBriefingScheduleByMemberId: {
    operationId: "putDailyBriefingScheduleByMemberId",
    tags: ["daily-briefing"],
    summary: "Set a member's weekday pause schedule (admin, FR-023/FR-025).",
    description: "Never regenerates or invalidates briefings. An empty list pauses every day.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ memberId: z.string() }),
    body: BriefingScheduleInput,
    response: {
      200: {
        description: "the stored schedule, canonical order.",
        content: { "application/json": { schema: BriefingSchedule } },
      },
      400: {
        description: "bad weekday, missing weekdays, unknown field, or inactive member.",
        content: {
          "application/json": {
            schema: z.xor([ValidationErrorResponse, FastifyParseErrorResponse]),
          },
        },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** GET /api/daily-briefing/settings */
  getDailyBriefingSettings: {
    operationId: "getDailyBriefingSettings",
    tags: ["daily-briefing"],
    summary: "Read block order + schedule + trigger binding + per-member block settings (admin).",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "the current settings snapshot (documented defaults when no row exists yet).",
        content: { "application/json": { schema: DailyBriefingSettingsView } },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** PUT /api/daily-briefing/settings */
  putDailyBriefingSettings: {
    operationId: "putDailyBriefingSettings",
    tags: ["daily-briefing"],
    summary: "Update generation_time and/or the auto-print trigger binding (admin).",
    description:
      "Partial update: an omitted field keeps its current value. `autoPrintTrigger: null` explicitly clears the binding (the contract's trigger-binding model — there is deliberately no boolean `autoPrint` flag). Never regenerates or invalidates existing briefings (FR-022).",
    security: [{ deviceKeyCookie: [] }],
    body: DailyBriefingSettingsInput,
    response: {
      200: {
        description: "the updated settings snapshot.",
        content: { "application/json": { schema: DailyBriefingSettingsSnapshot } },
      },
      400: {
        description: "invalid HH:MM, unknown trigger kind, or an unsupported field.",
        content: {
          "application/json": {
            schema: z.xor([ValidationErrorResponse, FastifyParseErrorResponse]),
          },
        },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** GET /api/daily-briefing/{memberId}/{date} */
  getDailyBriefingByMemberIdByDate: {
    operationId: "getDailyBriefingByMemberIdByDate",
    tags: ["daily-briefing"],
    summary: "Read a briefing (family/kiosk) — 019  adds `printedStatus`.",
    description:
      "Pure read (FR-010) — never creates a row. `printedStatus` is DERIVED, never Printing's own canonical state: `completed`/`failed` when Printing is active and either the local event-cache (fresh) or a read-time fallback query against Printing (FR-005/AC-04 dropped-event recovery) resolves one; `none` when Printing is active but no printable output has ever completed or dead-lettered for this member/date; `unavailable` when the Printing plugin itself is inactive (FR-007/AC-11 — distinct from `none`). Regeneration (a second call to `POST /api/daily-briefing/generate` for the same member/date) preserves the briefing id, atomically supersedes the prior Printing record for this output (FR-002/FR-003/FR-004, one transaction — research D4  fold), and enqueues no print job itself. `Briefing`/`BriefingPayload`/`BlockInstance` (the envelope v2 21-block registry) are documented locally and synchronized with the daily-briefing contract.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ memberId: z.string(), date: z.string() }),
    response: {
      200: {
        description:
          "the read result; `printedStatus` is present only when `generated: true` (a missing briefing carries no printed-status at all).",
        content: { "application/json": { schema: BriefingReadResultV2 } },
      },
      400: {
        description: "Invalid strict calendar date.",
        content: { "application/json": { schema: ValidationErrorResponse } },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** GET /api/daily-briefing/{memberId}/{date}/preview.png */
  getDailyBriefingByMemberIdByDatePreviewPng: {
    operationId: "getDailyBriefingByMemberIdByDatePreviewPng",
    tags: ["daily-briefing"],
    summary: "Stored render PNG (admin preview).",
    description:
      'Serves the SAME `png` column pressedslip wrote at generation time (schema.ts: "admin/preview surface only") — never re-decodes the packed 1-bit raster, never re-renders. A pure read: a missing row is not generated on demand (FR-010).',
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ memberId: z.string(), date: z.string() }),
    response: {
      200: {
        description: "the stored render, as a PNG.",
        content: { "image/png": { schema: z.string().meta({ contentEncoding: "base64" }) } },
      },
      202: {
        description:
          "a generation for this member/date is in flight and no PNG is stored yet (FR-028).",
        content: { "application/json": { schema: BriefingPreviewRendering } },
      },
      400: {
        description: "an invalid date.",
        content: { "application/json": { schema: ValidationErrorResponse } },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      404: {
        description: "no briefing exists for this member/date.",
        content: { "application/json": { schema: NotFoundErrorResponse } },
      },
      409: {
        description:
          "the briefing exists but never got a printable raster (Printing inactive at generation, or a catastrophic render — D5).",
        content: { "application/json": { schema: PrintableRasterMissingErrorResponse } },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
  /** POST /api/daily-briefing/{memberId}/{date}/print */
  postDailyBriefingByMemberIdByDatePrint: {
    operationId: "postDailyBriefingByMemberIdByDatePrint",
    tags: ["daily-briefing"],
    summary: "Send a stored briefing to the printer queue (admin, FR-027).",
    description:
      "Enqueues through Printing's producer seam under the record key `daily-briefing:<memberId>:manual:<date>`, targeting the household today. A job still waiting is reused; an already printed record is superseded and enqueued again.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ memberId: z.string(), date: z.string() }),
    response: {
      200: {
        description: "queued (or the waiting job reused).",
        content: { "application/json": { schema: BriefingPrintResponse } },
      },
      400: {
        description: "invalid date or inactive member.",
        content: { "application/json": { schema: ValidationErrorResponse } },
      },
      401: {
        description: "missing or invalid device key.",
        content: { "application/json": { schema: UnauthorizedErrorResponse } },
      },
      403: {
        description: "revoked or expired device key.",
        content: { "application/json": { schema: ForbiddenErrorResponse } },
      },
      404: {
        description: "no briefing for this member/date.",
        content: { "application/json": { schema: NotFoundErrorResponse } },
      },
      409: {
        description: "Printing plugin inactive, or the briefing has no printable raster.",
        content: {
          "application/json": {
            schema: z.xor([
              PrintingPluginInactiveErrorResponse,
              PrintableRasterMissingErrorResponse,
            ]),
          },
        },
      },
      429: authenticationBackoffResponse,
      500: {
        description: "unexpected server error.",
        content: { "application/json": { schema: InternalErrorResponse } },
      },
    },
  },
});
