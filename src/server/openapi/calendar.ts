// Code-first OpenAPI: route schemas for the calendar HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { ErrorSchema, authenticationBackoffResponse } from "./common";

export const AssignmentReplace = component(
  "AssignmentReplace",
  z.strictObject({
    memberIds: z.array(z.string()).meta({
      description: "Full replacement set; each MUST be an active member (FR-006). Atomic replace.",
    }),
  })
);

export const EventEditInput = component(
  "EventEditInput",
  z.strictObject({
    title: z.string().min(1).optional(),
    allDay: z.boolean().optional(),
    startDate: z
      .string()
      .regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$"))
      .meta({ description: "All-day half-open start (required when allDay=true; else null)." })
      .optional(),
    endDate: z
      .string()
      .regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$"))
      .meta({
        description:
          "All-day exclusive end; MUST be > startDate (start==end rejected). *(FR-004/05)*",
      })
      .optional(),
    startUtc: z
      .string()
      .meta({
        format: "date-time",
        description: "Timed start instant (required when allDay=false; else null). *(ADR-062)*",
      })
      .optional(),
    endUtc: z
      .string()
      .meta({ format: "date-time", description: "Timed end instant; MUST be >= startUtc." })
      .optional(),
    tzid: z
      .string()
      .meta({
        description:
          "IANA timezone the timed event was authored in (required when allDay=false). *(ADR-062)*",
        example: "Europe/Madrid",
      })
      .optional(),
    rrule: z
      .string()
      .nullable()
      .meta({
        description:
          "RFC-5545 RRULE; null = single occurrence. Supported subset: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, WKST; anything else (sub-daily FREQ, BYHOUR/BYMINUTE/BYSECOND, BYSETPOS, BYYEARDAY, BYWEEKNO, a BYMONTH/BYMONTHDAY pair that never occurs) is a 400.",
        example: "FREQ=WEEKLY;BYDAY=MO",
      })
      .optional(),
    exdates: z
      .array(z.string())
      .meta({
        description: "Excluded occurrences; preserved across an rrule edit (FR-014). Default [].",
      })
      .optional(),
    description: z
      .string()
      .max(4000)
      .nullable()
      .meta({ description: "Free text about the event; blank or null stores none." })
      .optional(),
    location: z
      .string()
      .max(300)
      .nullable()
      .meta({ description: "Where the event takes place; blank or null stores none." })
      .optional(),
  }),
  {
    description:
      "Partial edit. The server validates the merged stored state, including date shape, range and recurrence.",
  }
);

export const EventInput = component(
  "EventInput",
  z
    .strictObject({
      title: z.string().min(1),
      allDay: z.boolean(),
      startDate: z
        .string()
        .regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$"))
        .meta({ description: "All-day half-open start (required when allDay=true; else null)." })
        .optional(),
      endDate: z
        .string()
        .regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$"))
        .meta({
          description:
            "All-day exclusive end; MUST be > startDate (start==end rejected). *(FR-004/05)*",
        })
        .optional(),
      startUtc: z
        .string()
        .meta({
          format: "date-time",
          description: "Timed start instant (required when allDay=false; else null). *(ADR-062)*",
        })
        .optional(),
      endUtc: z
        .string()
        .meta({ format: "date-time", description: "Timed end instant; MUST be >= startUtc." })
        .optional(),
      tzid: z
        .string()
        .meta({
          description:
            "IANA timezone the timed event was authored in (required when allDay=false). *(ADR-062)*",
          example: "Europe/Madrid",
        })
        .optional(),
      rrule: z
        .string()
        .nullable()
        .meta({
          description:
            "RFC-5545 RRULE; null = single occurrence. Supported subset: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, WKST; anything else (sub-daily FREQ, BYHOUR/BYMINUTE/BYSECOND, BYSETPOS, BYYEARDAY, BYWEEKNO, a BYMONTH/BYMONTHDAY pair that never occurs) is a 400.",
          example: "FREQ=WEEKLY;BYDAY=MO",
        })
        .optional(),
      exdates: z
        .array(z.string())
        .meta({
          description: "Excluded occurrences; preserved across an rrule edit (FR-014). Default [].",
        })
        .optional(),
      description: z
        .string()
        .max(4000)
        .nullable()
        .meta({ description: "Free text about the event; blank or null stores none." })
        .optional(),
      location: z
        .string()
        .max(300)
        .nullable()
        .meta({ description: "Where the event takes place; blank or null stores none." })
        .optional(),
    })
    .meta({
      oneOf: [
        {
          properties: { allDay: { const: true } },
          required: ["startDate", "endDate"],
          not: {
            anyOf: [{ required: ["startUtc"] }, { required: ["endUtc"] }, { required: ["tzid"] }],
          },
        },
        {
          properties: { allDay: { const: false } },
          required: ["startUtc", "endUtc", "tzid"],
          not: { anyOf: [{ required: ["startDate"] }, { required: ["endDate"] }] },
        },
      ],
    }),
  {
    description:
      "Create payload. Exactly one date shape is required according to allDay; ranges, timezone and recurrence are validated by the service.",
  }
);

export const ExternalSourceErrorCode = component(
  "ExternalSourceErrorCode",
  z.enum([
    "unsafe_url",
    "unavailable",
    "timeout",
    "too_large",
    "invalid_calendar",
    "parse_failed",
    "reconcile_failed",
  ])
);

export const ExternalSourcePatch = component(
  "ExternalSourcePatch",
  z.strictObject({ enabled: z.boolean() })
);

export const ExternalSourceProvider = component(
  "ExternalSourceProvider",
  z.enum(["google", "microsoft", "apple", "ics_generic"])
);

export const SynchronizationPhase = component(
  "SynchronizationPhase",
  z.enum(["requesting", "downloading", "parsing", "reconciling", "succeeded", "failed"])
);

export const ExternalSourcePublic = component(
  "ExternalSourcePublic",
  z.strictObject({
    id: z.string(),
    name: z.string(),
    provider: ExternalSourceProvider,
    maskedUrl: z
      .string()
      .meta({ description: "Origin plus masked path; no credentials or token." }),
    enabled: z.boolean(),
    pollIntervalMin: z.int().min(1).max(1440),
    phase: z.union([SynchronizationPhase, z.null()]),
    lastAttemptAt: z.int().nullable().meta({ format: "int64" }),
    lastSuccessAt: z.int().nullable().meta({ format: "int64" }),
    lastErrorCode: z.union([ExternalSourceErrorCode, z.null()]),
    consecutiveFailures: z.int().min(0),
    lastImportedCount: z.int().min(0),
    lastSkippedCount: z.int().min(0),
  })
);

export const ExternalSourcePut = component(
  "ExternalSourcePut",
  z.strictObject({
    name: z.string().min(1).max(120),
    provider: z.string().meta({ description: "Unknown values normalize to ics_generic." }),
    feedUrl: z
      .string()
      .meta({ format: "uri", description: "Write-only HTTP(S) URL. Raw value is never returned." }),
    pollIntervalMin: z.int().min(1).max(1440).meta({ default: 15 }).optional(),
  })
);

export const FeedItem = component(
  "FeedItem",
  z.strictObject({
    id: z.string().meta({ description: "master event id" }),
    occurrenceStart: z.string().meta({
      description: "This occurrence's start — an instant (timed) or a YYYY-MM-DD (all-day).",
    }),
    occurrenceEnd: z.string().optional(),
    source: z
      .enum(["local", "external"])
      .meta({ description: "local household-managed or external imported occurrence" }),
    title: z.string(),
    allDay: z.boolean(),
    tzid: z.string().nullable().meta({ description: "timed only" }).optional(),
    assignedTo: z
      .array(z.string())
      .meta({ description: "Resolved active-member ids (series-level)." }),
    decoratedTitle: z
      .string()
      .nullable()
      .meta({
        description: "Read-time highlight decoration (emoji prefix); never rewrites stored title.",
      })
      .optional(),
    provider: z
      .string()
      .nullable()
      .meta({ description: "Display-only external provider when source=external; null for local." })
      .optional(),
    sourceRef: z
      .string()
      .nullable()
      .meta({
        description: "Masked external source origin (`protocol//host/***`); null for local.",
      })
      .optional(),
    description: z
      .string()
      .meta({
        description:
          "Plain text about the event — household-authored for local, as the feed sent it for external. Omitted when there is none.",
      })
      .optional(),
    location: z
      .string()
      .meta({ description: "Where the event takes place; omitted when there is none." })
      .optional(),
  }),
  { description: "One EXPANDED occurrence (not a master) returned by getEvents." }
);

export const HighlightRule = component(
  "HighlightRule",
  z.strictObject({
    id: z.string(),
    emoji: z.string(),
    keywords: z.array(z.string()),
    enabled: z.boolean(),
    priority: z.int().min(0),
  })
);

export const HighlightRuleCreate = component(
  "HighlightRuleCreate",
  z.strictObject({
    emoji: z.string().min(1).max(32),
    keywords: z.array(z.string().min(1).max(120)).min(1).max(50),
  })
);

export const HighlightRuleOrder = component(
  "HighlightRuleOrder",
  z.strictObject({ orderedIds: z.array(z.string()).meta({ uniqueItems: true }) })
);

export const HighlightRulePatch = component(
  "HighlightRulePatch",
  z.strictObject({ enabled: z.boolean() })
);

export const calendarSchemas = defineRouteSchemas({
  /** GET /api/calendar/events */
  getCalendarEvents: {
    operationId: "getCalendarEvents",
    tags: ["calendar"],
    summary: "Read the merged feed (getEvents) — the sole cross-module read path (INV-01/AC-01).",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      source: z.enum(["all", "local", "external"]).meta({ default: "all" }).optional(),
      assignedTo: z.string().meta({ description: "member id; strict (INV-09/AC-06)" }).optional(),
      from: z.string().meta({
        description:
          "Range start: a YYYY-MM-DD household date (from its household midnight) or an ISO instant (inclusive). All-day events match by household date.",
      }),
      to: z.string().meta({
        description:
          "Range end: a YYYY-MM-DD household date, included (read up to the next household midnight, INV-03), or an exclusive ISO instant.",
      }),
      query: z
        .string()
        .meta({
          description:
            "Optional case/diacritic-insensitive substring match performed inside Calendar (default fields title+description; override with queryFields).",
        })
        .optional(),
      queryFields: z
        .array(z.enum(["title", "description", "location"]))
        .meta({
          description:
            "Optional non-empty subset of title|description|location. Invalid entries → 400.",
        })
        .optional(),
    }),
    response: {
      200: {
        description: "Expanded, merged, member-scoped occurrences within the range.",
        content: { "application/json": { schema: z.array(FeedItem) } },
      },
      400: {
        description:
          "Missing/malformed range, range outside the fixed −30d/+365d window, invalid source, or invalid queryFields entries.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/calendar/events */
  postCalendarEvents: {
    operationId: "postCalendarEvents",
    tags: ["calendar"],
    summary: "Create a local event (device-key auth; PIN is a client-only affordance gate).",
    security: [{ deviceKeyCookie: [] }],
    body: EventInput,
    response: {
      201: {
        description: "created; returns the new master event id",
        content: {
          "application/json": {
            schema: z.strictObject({ id: z.string().meta({ description: "new master event id" }) }),
          },
        },
      },
      400: {
        description: "validation (start==end, bad tzid, malformed rrule, …)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/calendar/events/{id} */
  patchCalendarEventsById: {
    operationId: "patchCalendarEventsById",
    tags: ["calendar"],
    summary: "Edit a local event's fields (single-row; rrule edit preserves exdates, FR-014).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: EventEditInput,
    response: {
      200: { description: "updated", content: { "application/json": { schema: FeedItem } } },
      400: { description: "validation", content: { "application/json": { schema: ErrorSchema } } },
      401: noContent("missing/invalid device key"),
      404: noContent("no such event"),
      409: {
        description:
          "`external_event_read_only`: the event is synchronized from an external calendar; only its participant assignments are editable.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/calendar/events/{id} */
  deleteCalendarEventsById: {
    operationId: "deleteCalendarEventsById",
    tags: ["calendar"],
    summary: "Delete a local event + its assignments atomically (FR-009, INV-07 local).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("deleted; event + all assignment rows removed in one transaction"),
      401: noContent("missing/invalid device key"),
      404: noContent("no such event"),
      409: {
        description:
          "`external_event_read_only`: the event is synchronized from an external calendar; only its participant assignments are editable.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/calendar/events/{id}/assignments */
  putCalendarEventsByIdAssignments: {
    operationId: "putCalendarEventsByIdAssignments",
    tags: ["calendar"],
    summary: "Replace an event's assignment set atomically (FR-009; strict active-member, FR-006).",
    description:
      "The response holds exactly the requested members. On an external event, a title-derived (`ext:`) assignment whose member is still requested is kept as title-derived, so later feed syncs keep owning it; every other requested member is stored as a manual assignment that survives syncs. A title-derived member left out of the set is removed until the next sync reads the title again.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: AssignmentReplace,
    response: {
      200: {
        description: "replaced (atomic)",
        content: { "application/json": { schema: FeedItem } },
      },
      400: {
        description: "a target member is not active (strict-on-write)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such event"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/calendar/external-sources */
  getCalendarExternalSources: {
    operationId: "getCalendarExternalSources",
    tags: ["calendar"],
    summary: "List safe source configuration, durable health, and transient phase.",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "Raw feed URLs and conditional validators are absent.",
        content: { "application/json": { schema: z.array(ExternalSourcePublic) } },
      },
      401: noContent("Missing or invalid device key."),
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/calendar/external-sources/{id} */
  putCalendarExternalSourcesById: {
    operationId: "putCalendarExternalSourcesById",
    tags: ["calendar"],
    summary: "Persist source configuration and start first synchronization after commit.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: ExternalSourcePut,
    response: {
      202: {
        description: "Configuration persisted and first synchronization started.",
        content: { "application/json": { schema: ExternalSourcePublic } },
      },
      400: noContent("Invalid source or unsafe URL."),
      401: noContent("Missing or invalid device key."),
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/calendar/external-sources/{id} */
  patchCalendarExternalSourcesById: {
    operationId: "patchCalendarExternalSourcesById",
    tags: ["calendar"],
    summary: "Reversibly enable or disable a source without deleting retained data.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: ExternalSourcePatch,
    response: {
      200: {
        description: "Updated source state.",
        content: { "application/json": { schema: ExternalSourcePublic } },
      },
      400: noContent("Invalid body."),
      401: noContent("Missing or invalid device key."),
      404: noContent("Source not found."),
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/calendar/external-sources/{id} */
  deleteCalendarExternalSourcesById: {
    operationId: "deleteCalendarExternalSourcesById",
    tags: ["calendar"],
    summary:
      "Permanently delete source, imported events, and external assignments under the guard.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("Deletion completed atomically."),
      401: noContent("Missing or invalid device key."),
      404: noContent("Source not found."),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/calendar/external-sources/{id}/sync */
  postCalendarExternalSourcesByIdSync: {
    operationId: "postCalendarExternalSourcesByIdSync",
    tags: ["calendar"],
    summary: "Start or observe the source's current synchronization.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      202: {
        description: "Synchronization started or an existing run is active.",
        content: { "application/json": { schema: ExternalSourcePublic } },
      },
      401: noContent("Missing or invalid device key."),
      404: noContent("Source not found."),
      409: noContent("Source is disabled."),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/calendar/highlight-rules */
  getCalendarHighlightRules: {
    operationId: "getCalendarHighlightRules",
    tags: ["calendar"],
    summary: "List highlight rules in persisted priority order.",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "Ordered rules.",
        content: { "application/json": { schema: z.array(HighlightRule) } },
      },
      401: noContent("Missing or invalid device key."),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/calendar/highlight-rules */
  postCalendarHighlightRules: {
    operationId: "postCalendarHighlightRules",
    tags: ["calendar"],
    summary: "Create an enabled highlight rule at the end of the order.",
    security: [{ deviceKeyCookie: [] }],
    body: HighlightRuleCreate,
    response: {
      201: {
        description: "Created rule.",
        content: { "application/json": { schema: HighlightRule } },
      },
      400: noContent("Invalid emoji or keywords."),
      401: noContent("Missing or invalid device key."),
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/calendar/highlight-rules/reorder */
  putCalendarHighlightRulesReorder: {
    operationId: "putCalendarHighlightRulesReorder",
    tags: ["calendar"],
    summary: "Atomically replace the complete highlight order.",
    security: [{ deviceKeyCookie: [] }],
    body: HighlightRuleOrder,
    response: {
      200: {
        description: "Complete authoritative order.",
        content: { "application/json": { schema: z.array(HighlightRule) } },
      },
      400: noContent("IDs do not exactly match the stored rule set."),
      401: noContent("Missing or invalid device key."),
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/calendar/highlight-rules/{id} */
  patchCalendarHighlightRulesById: {
    operationId: "patchCalendarHighlightRulesById",
    tags: ["calendar"],
    summary: "Enable or disable one rule.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: HighlightRulePatch,
    response: {
      200: {
        description: "Updated rule.",
        content: { "application/json": { schema: HighlightRule } },
      },
      400: noContent("Invalid body."),
      401: noContent("Missing or invalid device key."),
      404: noContent("Rule not found."),
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/calendar/highlight-rules/{id} */
  deleteCalendarHighlightRulesById: {
    operationId: "deleteCalendarHighlightRulesById",
    tags: ["calendar"],
    summary: "Delete one highlight rule and compact the remaining order atomically.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("Rule deleted."),
      401: noContent("Missing or invalid device key."),
      404: noContent("Rule not found."),
      429: authenticationBackoffResponse,
    },
  },
});
