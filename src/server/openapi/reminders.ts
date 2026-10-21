// Code-first OpenAPI: route schemas for the reminders HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { ErrorSchema, PluginUnavailable, Weekday, authenticationBackoffResponse } from "./common";

export const CalendarGatedAssignmentInput = component(
  "CalendarGatedAssignmentInput",
  z.strictObject({
    memberId: z.string().min(1).regex(new RegExp("\\S")),
    weekdays: z.array(z.unknown()).max(0).optional(),
  })
);

export const DryRunInput = component(
  "DryRunInput",
  z.strictObject({
    memberId: z.string(),
    date: z.string().meta({ description: "YYYY-MM-DD, household-local strict calendar date." }),
  }),
  { description: "POST /api/reminders/{id}/dry-run body (handler-enforced allow-list, #397)." }
);

export const DryRunReason = component(
  "DryRunReason",
  z.enum(["no_assigned_events", "matched_but_unassigned", "query_miss"]),
  {
    description:
      "The 3 mutually-exclusive reasons a calendar_gated rule would NOT emit (present iff wouldEmit=false), computed from up to 3 getEvents probes A/B/C. Precedence: no_assigned_events (probe A empty) -> matched_but_unassigned (probe C non-empty, gate probe B empty) -> query_miss (probe C empty) — matched_but_unassigned is checked BEFORE query_miss so it is reachable (finding #2).\n",
  }
);

export const DryRunResult = component(
  "DryRunResult",
  z.looseObject({ wouldEmit: z.boolean(), reason: DryRunReason.optional() }),
  {
    description:
      "The verdict: would this calendar_gated rule emit for (memberId, date), and if not, why. wouldEmit=true iff the gate probe (member's assigned events matching the query) is non-empty; reason is present iff wouldEmit=false.\n",
  }
);

export const QueryFields = component(
  "QueryFields",
  z.array(z.enum(["title", "description", "location"])).min(1)
);

export const ReminderAssignment = component(
  "ReminderAssignment",
  z.strictObject({
    id: z.string(),
    memberId: z.string(),
    weekdays: z.array(Weekday).min(0),
    active: z.boolean(),
  })
);

export const Reminder = component(
  "Reminder",
  z.strictObject({
    id: z.string(),
    kind: z
      .enum(["scheduled", "calendar_gated"])
      .meta({ description: "immutable after creation." }),
    targetingMode: z
      .enum(["apply_to_all", "specific"])
      .meta({ description: "editable through PATCH (FR-019); kind is immutable." }),
    text: z.string().min(1).meta({ description: "parent-authored, stored as authored." }),
    weekdays: z.xor([z.array(Weekday).min(1), z.null()]).meta({
      description:
        "rule-level weekday set for apply_to_all; null for specific (per-member weekdays live on each assignment). Cross-field discriminant (INV-09).\n",
    }),
    active: z.boolean(),
    assignments: z.array(ReminderAssignment).meta({
      description:
        "active assignments embedded in GET reads (the member x weekday matrix source); populated for specific-mode rules, empty array for apply_to_all.\n",
    }),
    query: z.string().nullable().optional(),
    queryFields: z.union([QueryFields, z.null()]).optional(),
  }),
  {
    description:
      "Stored discriminated rule. Scheduled specific assignments carry non-empty weekdays; calendar-gated assignments carry empty weekdays and a query. Active-member and uniqueness invariants are enforced by the service.",
    allOf: [
      {
        if: { properties: { kind: { const: "scheduled" } }, required: ["kind"] },
        then: {
          properties: {
            query: { type: "null" },
            queryFields: { type: "null" },
            assignments: { items: { properties: { weekdays: { minItems: 1 } } } },
          },
          if: {
            properties: { targetingMode: { const: "apply_to_all" } },
            required: ["targetingMode"],
          },
          then: { properties: { weekdays: { type: "array", minItems: 1 } } },
          else: { properties: { weekdays: { type: "null" } } },
        },
        else: {
          properties: {
            weekdays: { type: "null" },
            query: { type: "string", minLength: 1, pattern: "\\S" },
            queryFields: { $ref: "#/components/schemas/QueryFields" },
            assignments: { items: { properties: { weekdays: { maxItems: 0 } } } },
          },
        },
      },
      {
        if: {
          properties: { targetingMode: { const: "apply_to_all" } },
          required: ["targetingMode"],
        },
        then: { properties: { assignments: { maxItems: 0 } } },
      },
    ],
  }
);

export const ReminderAssignmentInput = component(
  "ReminderAssignmentInput",
  z.strictObject({
    memberId: z.string().min(1).regex(new RegExp("\\S")),
    weekdays: z.array(Weekday).min(1),
  })
);

export const ReminderAssignmentSetInput = component(
  "ReminderAssignmentSetInput",
  z.strictObject({
    assignments: z.array(z.xor([ReminderAssignmentInput, CalendarGatedAssignmentInput])).min(1),
  }),
  {
    description:
      "The full desired active assignment set for a specific-mode rule. Applied atomically (last-write-wins, no If-Match/409 — deferred #395): members present are upserted, members absent are deactivated. MUST be non-empty (a specific rule may not drop to zero active assignments — INV-02).\n The stored rule kind determines whether weekdays must be non-empty (scheduled) or absent/empty (calendar_gated).",
  }
);

export const ReminderEditInput = component(
  "ReminderEditInput",
  z.strictObject({
    text: z.string().min(1).regex(new RegExp("\\S")).optional(),
    weekdays: z.array(Weekday).min(1).optional(),
    active: z.boolean().optional(),
    targetingMode: z.enum(["apply_to_all", "specific"]).optional(),
    assignments: z
      .array(z.xor([ReminderAssignmentInput, CalendarGatedAssignmentInput]))
      .min(1)
      .meta({
        description:
          "full desired set; accepted only when the resulting targetingMode is specific.",
      })
      .optional(),
    query: z.string().min(1).regex(new RegExp("\\S")).optional(),
    queryFields: QueryFields.optional(),
  }),
  {
    description:
      "Partial edit; kind is immutable. targetingMode may switch between apply_to_all and specific. Switching to specific requires assignments; switching a scheduled rule to apply_to_all requires weekdays; a calendar_gated rule switching to apply_to_all needs nothing extra. Weekdays are valid only when the resulting mode is apply_to_all on a scheduled rule; assignments only when the resulting mode is specific (full-set replace). Query fields only on stored calendar_gated rules. These state-dependent constraints are enforced by the service; a rejected edit persists nothing. Switching to apply_to_all deactivates (never deletes) the rule's active assignments.",
    minProperties: 1,
    not: {
      allOf: [
        { required: ["weekdays"] },
        { anyOf: [{ required: ["query"] }, { required: ["queryFields"] }] },
      ],
    },
  }
);

export const ReminderEmission = component(
  "ReminderEmission",
  z.strictObject({ id: z.string(), text: z.string() }),
  {
    description:
      "one emitting reminder for a (member,date); ordering/priority deferred to Daily Briefing.",
  }
);

export const ReminderInput = component(
  "ReminderInput",
  z.strictObject({
    kind: z.enum(["scheduled", "calendar_gated"]),
    targetingMode: z.enum(["apply_to_all", "specific"]),
    text: z.string().min(1).regex(new RegExp("\\S")),
    weekdays: z
      .array(Weekday)
      .min(1)
      .meta({ description: "required iff targetingMode=apply_to_all; rejected for specific." })
      .optional(),
    assignments: z
      .array(z.xor([ReminderAssignmentInput, CalendarGatedAssignmentInput]))
      .min(1)
      .meta({ description: "required iff targetingMode=specific; rejected for apply_to_all." })
      .optional(),
    query: z.string().min(1).regex(new RegExp("\\S")).optional(),
    queryFields: QueryFields.optional(),
  }),
  {
    description:
      "Scheduled rules require weekday targeting; calendar-gated rules require a query and membership-only targeting. Active-member and duplicate checks are enforced by the service.",
    allOf: [
      {
        if: { properties: { kind: { const: "scheduled" } }, required: ["kind"] },
        then: {
          not: { anyOf: [{ required: ["query"] }, { required: ["queryFields"] }] },
          if: {
            properties: { targetingMode: { const: "apply_to_all" } },
            required: ["targetingMode"],
          },
          then: { required: ["weekdays"], not: { required: ["assignments"] } },
          else: {
            required: ["assignments"],
            not: { required: ["weekdays"] },
            properties: {
              assignments: { items: { $ref: "#/components/schemas/ReminderAssignmentInput" } },
            },
          },
        },
        else: {
          required: ["query"],
          not: { required: ["weekdays"] },
          properties: {
            assignments: { items: { $ref: "#/components/schemas/CalendarGatedAssignmentInput" } },
          },
          if: { properties: { targetingMode: { const: "specific" } }, required: ["targetingMode"] },
          then: { required: ["assignments"] },
          else: { not: { required: ["assignments"] } },
        },
      },
    ],
  }
);

export const remindersSchemas = defineRouteSchemas({
  /** GET /api/reminders */
  getReminders: {
    operationId: "getReminders",
    tags: ["reminders"],
    summary: "List all reminder rules (+ their assignments). Admin surface.",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: {
        description: "all reminders",
        content: { "application/json": { schema: z.array(Reminder) } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
      503: {
        description: "The owning plugin is inactive or unavailable.",
        content: { "application/json": { schema: PluginUnavailable } },
      },
    },
  },
  /** POST /api/reminders */
  postReminders: {
    operationId: "postReminders",
    tags: ["reminders"],
    summary: "Create a scheduled reminder (apply_to_all, or specific + assignments), atomically.",
    security: [{ deviceKeyCookie: [] }],
    body: ReminderInput,
    response: {
      201: { description: "created", content: { "application/json": { schema: Reminder } } },
      400: {
        description:
          "invalid kind/targetingMode, blank text, empty/non-canonical weekdays, zero/inactive-member assignments, or a query/queryFields field",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/reminders/emissions */
  getRemindersEmissions: {
    operationId: "getRemindersEmissions",
    tags: ["reminders"],
    summary:
      "Outbound read — scheduled reminders emitting for (member,date). Daily-Briefing consumer interface.",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      memberId: z.string(),
      date: z.string().meta({ description: "strict YYYY-MM-DD" }),
    }),
    response: {
      200: {
        description: "emitting reminders (empty if member inactive or none apply)",
        content: { "application/json": { schema: z.array(ReminderEmission) } },
      },
      400: {
        description: "invalid/impossible date",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("unauthorized"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/reminders/{id} */
  getRemindersById: {
    operationId: "getRemindersById",
    tags: ["reminders"],
    summary: "One reminder rule + its assignments.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: { description: "reminder", content: { "application/json": { schema: Reminder } } },
      404: { description: "not found", content: { "application/json": { schema: ErrorSchema } } },
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/reminders/{id} */
  patchRemindersById: {
    operationId: "patchRemindersById",
    tags: ["reminders"],
    summary:
      "Edit text/active/weekdays/query and switch targetingMode (assignments for specific). kind immutable (FR-013).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: ReminderEditInput,
    response: {
      200: { description: "updated", content: { "application/json": { schema: Reminder } } },
      400: {
        description:
          "kind in body, invalid targetingMode, missing weekdays/assignments for the switch, or invalid field",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: { description: "not found", content: { "application/json": { schema: ErrorSchema } } },
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/reminders/{id} */
  deleteRemindersById: {
    operationId: "deleteRemindersById",
    tags: ["reminders"],
    summary:
      "Hard-delete a reminder rule (genuine removal, distinct from active:false). Cascades to its reminder_assignment rows (ON DELETE CASCADE).\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("deleted"),
      404: { description: "not found", content: { "application/json": { schema: ErrorSchema } } },
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/reminders/{id}/assignments */
  putRemindersByIdAssignments: {
    operationId: "putRemindersByIdAssignments",
    tags: ["reminders"],
    summary:
      "Atomic full-set replace of a specific-mode rule's assignments (the admin matrix \"save\"). Replaces the entire active assignment set in ONE transaction — upsert the members present, deactivate those absent (deactivate, never hard-delete). Last-write- wins (no If-Match/409 optimistic concurrency — deferred #395). The ONLY assignment- write operation, so a multi-member edit (add one, remove another, change weekdays) commits or rolls back as a whole — no partial per-row writes. An empty set is rejected (a specific rule may not drop to zero active assignments — use the rule's active:false to silence instead; FR-005/INV-02). apply_to_all rules reject this endpoint (they carry no assignments).\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: ReminderAssignmentSetInput,
    response: {
      200: {
        description: "the resulting active assignment set",
        content: { "application/json": { schema: z.array(ReminderAssignment) } },
      },
      400: {
        description: "apply_to_all rule, empty set, inactive member, or non-canonical weekday",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "reminder not found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/reminders/{id}/dry-run */
  postRemindersByIdDryRun: {
    operationId: "postRemindersByIdDryRun",
    tags: ["reminders"],
    summary:
      "Dry-run / explain (009,) — would this calendar_gated rule emit for (memberId, date), and if not, why (the 3 mutually-exclusive reasons, FR-008). 400 if the stored rule is not calendar_gated (a scheduled rule's emission is not opaque).\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: DryRunInput,
    response: {
      200: { description: "verdict", content: { "application/json": { schema: DryRunResult } } },
      400: {
        description: "bad memberId/date/body, or the rule is not kind=calendar_gated",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "rule not found",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
});
