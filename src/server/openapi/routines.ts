// Code-first OpenAPI: route schemas for the routines HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas, noContent } from "./zod";
import { ErrorSchema, authenticationBackoffResponse } from "./common";

export const Assignment = component(
  "Assignment",
  z.strictObject({
    id: z.string(),
    memberId: z.string(),
    weekdays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])),
    active: z.boolean(),
  })
);

export const AssignmentUpsert = component(
  "AssignmentUpsert",
  z.strictObject({
    weekdays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])),
    active: z.boolean().meta({ default: true }).optional(),
  }),
  {
    description:
      "Upsert (create-or-edit) the one logical assignment row for (routineId, memberId) — reactivation reuses the existing row (FR-005). memberId MUST be an active child at write time (INV-01/FR-001).\n",
  }
);

export const BoardChore = component(
  "BoardChore",
  z.strictObject({
    id: z.string(),
    name: z.string(),
    completed: z.boolean(),
    icon: z.string().nullable(),
  })
);

export const BoardDayPeriod = component(
  "BoardDayPeriod",
  z.strictObject({
    id: z.enum(["morning", "afternoon", "evening", "night"]),
    labelKey: z.string().meta({ description: "i18n key, not display text (DAY-PERIODS-INV-04)." }),
    chores: z.array(BoardChore),
  }),
  {
    description:
      "One of the four fixed periods, always present even when chores is empty (DAY-PERIODS-AC-05).",
  }
);

export const BoardColumn = component(
  "BoardColumn",
  z.strictObject({
    memberId: z.string(),
    displayName: z.string(),
    dayPeriods: z.array(BoardDayPeriod),
    streak: z.int().nullable().meta({
      description:
        "Consecutive qualifying days ending at the most recent one (FR-013). Present (a number, possibly 0) ONLY when the requested date is today; null for any other date — the suppression (FR-014, INV-09) is enforced server-side, not left to the client to hide.\n",
    }),
    todayProgress: z
      .looseObject({ completed: z.int().optional(), total: z.int().optional() })
      .nullable()
      .meta({ description: "Same today-only suppression as streak (FR-014)." }),
  }),
  { description: "One active child's column (FR-017/FR-018)." }
);

export const Chore = component(
  "Chore",
  z.strictObject({
    id: z.string(),
    routineId: z.string(),
    name: z.string().min(1),
    sortOrder: z.int().min(0),
    active: z.boolean(),
    icon: z.string().nullable(),
  })
);

export const ChoreEditInput = component(
  "ChoreEditInput",
  z.strictObject({
    name: z.string().min(1).optional(),
    routineId: z.string().optional(),
    active: z.boolean().optional(),
    icon: z.string().nullable().optional(),
  }),
  { description: "name, routineId (move to a different routine, FR-019), and/or active." }
);

export const ChoreInput = component(
  "ChoreInput",
  z.strictObject({ name: z.string().min(1), icon: z.string().nullable().optional() })
);

export const ChoreOrderInput = component(
  "ChoreOrderInput",
  z.strictObject({
    choreIds: z.array(z.string()).meta({
      description:
        "Full ordered list of the routine's active chore ids (atomic replace, FR-005/FR-006).",
    }),
  })
);

export const CompletionInput = component(
  "CompletionInput",
  z.strictObject({
    memberId: z.string(),
    date: z.string().regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$")),
  })
);

export const RouteError = component(
  "RouteError",
  z.strictObject({ error: z.enum(["not_found", "internal_error"]), message: z.string() })
);

export const Routine = component(
  "Routine",
  z.strictObject({
    id: z.string(),
    name: z.string().min(1),
    dayPeriodId: z
      .string()
      .meta({ description: "Day period the routine belongs to; PATCH may move it (FR-015)." }),
    active: z.boolean(),
  })
);

export const RoutineEditInput = component(
  "RoutineEditInput",
  z.strictObject({
    name: z.string().min(1).optional(),
    active: z.boolean().optional(),
    dayPeriodId: z
      .string()
      .min(1)
      .meta({
        description:
          "Moves the routine to another existing day period; blank or unknown values are rejected (FR-015).",
      })
      .optional(),
  }),
  { description: "Edit payload — any of name, active and dayPeriodId (FR-015)." }
);

export const RoutineInput = component(
  "RoutineInput",
  z.strictObject({
    name: z.string().min(1),
    dayPeriodId: z.string().meta({ description: "must reference an existing day_periods.id." }),
  }),
  { description: "Create payload." }
);

export const routinesSchemas = defineRouteSchemas({
  /** GET /api/chores/board */
  getChoresBoard: {
    operationId: "getChoresBoard",
    tags: ["chores"],
    summary:
      "The household board (FR-017/FR-018) — one column per active child, all four day periods always present (DAY-PERIODS-AC-05), streak/progress today-only (FR-014). No PIN required (FR-019).\n",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      date: z
        .string()
        .regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$"))
        .meta({ description: "household-local date; strict-valid (INV-03/AC-05)." }),
    }),
    response: {
      200: { description: "OK", content: { "application/json": { schema: z.array(BoardColumn) } } },
      400: {
        description: "malformed or impossible date",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/chores/{id} */
  getChoresById: {
    operationId: "getChoresById",
    tags: ["chores"],
    summary:
      "Fetch one chore by id — tolerant of soft-deleted rows (FR-007/INV-08: a soft-deleted chore stays readable for history). The single-fetch companion to the active-only list in GET /api/routines/{id}/chores.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: {
        description: "OK — active or soft-deleted",
        content: { "application/json": { schema: Chore } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such chore ever existed"),
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/chores/{id} */
  patchChoresById: {
    operationId: "patchChoresById",
    tags: ["chores"],
    summary: "Edit a chore's name and/or move it to a different routine (FR-019), and/or active.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: ChoreEditInput,
    response: {
      200: { description: "updated", content: { "application/json": { schema: Chore } } },
      400: { description: "validation", content: { "application/json": { schema: ErrorSchema } } },
      401: noContent("missing/invalid device key"),
      404: noContent("no such chore"),
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/chores/{id} */
  deleteChoresById: {
    operationId: "deleteChoresById",
    tags: ["chores"],
    summary: "Soft-delete a chore (INV-08).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("soft-deleted"),
      401: noContent("missing/invalid device key"),
      404: noContent("no such chore"),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/chores/{id}/completions */
  postChoresByIdCompletions: {
    operationId: "postChoresByIdCompletions",
    tags: ["chores"],
    summary: "Complete a chore for a member/date (FR-008) — idempotent, no PIN required (FR-019).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: CompletionInput,
    response: {
      204: noContent(
        "completed (or already was — idempotent); emits routines.completion_changed post-commit (FR-015)."
      ),
      400: {
        description:
          "malformed or impossible date, missing/blank memberId, or not currently markable (INV-04) — member/chore/routine/assignment state does not cover this date",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such chore"),
      429: authenticationBackoffResponse,
      500: {
        description: "Unexpected storage failure; no completion event is emitted.",
        content: { "application/json": { schema: RouteError } },
      },
    },
  },
  /** DELETE /api/chores/{id}/completions */
  deleteChoresByIdCompletions: {
    operationId: "deleteChoresByIdCompletions",
    tags: ["chores"],
    summary: "Uncomplete a chore for a member/date (FR-009) — ALWAYS allowed, idempotent, no PIN.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    querystring: z.object({
      memberId: z.string(),
      date: z.string().regex(new RegExp("^\\d{4}-\\d{2}-\\d{2}$")),
    }),
    response: {
      204: noContent(
        "uncompleted (or already was — idempotent); emits routines.completion_changed post-commit if a row existed."
      ),
      400: {
        description: "malformed or impossible date, or missing/blank memberId",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such chore"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/routines */
  getRoutines: {
    operationId: "getRoutines",
    tags: ["chores"],
    summary: "List active routines, ordered by day-period start time, then name (FR-016).",
    security: [{ deviceKeyCookie: [] }],
    response: {
      200: { description: "OK", content: { "application/json": { schema: z.array(Routine) } } },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/routines */
  postRoutines: {
    operationId: "postRoutines",
    tags: ["chores"],
    summary: "Create a routine attached to one day period.",
    security: [{ deviceKeyCookie: [] }],
    body: RoutineInput,
    response: {
      201: { description: "created", content: { "application/json": { schema: Routine } } },
      400: {
        description: "validation (bad dayPeriodId, empty name)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/routines/{id} */
  getRoutinesById: {
    operationId: "getRoutinesById",
    tags: ["chores"],
    summary:
      "Fetch one routine by id — tolerant of soft-deleted rows (FR-007/INV-08: a soft-deleted routine stays readable for history). The single-fetch companion to the active-only list in GET /api/routines.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: {
        description: "OK — active or soft-deleted",
        content: { "application/json": { schema: Routine } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such routine ever existed"),
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/routines/{id} */
  patchRoutinesById: {
    operationId: "patchRoutinesById",
    tags: ["chores"],
    summary: "Edit a routine's name, active flag and/or day period (FR-015).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: RoutineEditInput,
    response: {
      200: { description: "updated", content: { "application/json": { schema: Routine } } },
      400: {
        description: "validation (blank name, non-boolean active, blank or unknown dayPeriodId)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such routine"),
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/routines/{id} */
  deleteRoutinesById: {
    operationId: "deleteRoutinesById",
    tags: ["chores"],
    summary:
      "Soft-delete a routine (INV-08) — excluded from active reads/streak, stays historical.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      204: noContent("soft-deleted"),
      401: noContent("missing/invalid device key"),
      404: noContent("no such routine"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/routines/{id}/assignments */
  getRoutinesByIdAssignments: {
    operationId: "getRoutinesByIdAssignments",
    tags: ["chores"],
    summary: "List a routine's assignments (active and inactive, for admin history).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: { description: "OK", content: { "application/json": { schema: z.array(Assignment) } } },
      401: noContent("missing/invalid device key"),
      404: {
        description: "The requested routine does not exist.",
        content: { "application/json": { schema: RouteError } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/routines/{id}/assignments/{memberId} */
  putRoutinesByIdAssignmentsByMemberId: {
    operationId: "putRoutinesByIdAssignmentsByMemberId",
    tags: ["chores"],
    summary:
      "Upsert the routine/member assignment (FR-001/FR-002/FR-005) — reactivation reuses the row.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string(), memberId: z.string() }),
    body: AssignmentUpsert,
    response: {
      200: {
        description: "upserted (atomic)",
        content: { "application/json": { schema: Assignment } },
      },
      400: {
        description:
          "member not an active child (INV-01), or a weekday outside the 7-code enum (AC-05)",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such routine"),
      429: authenticationBackoffResponse,
    },
  },
  /** DELETE /api/routines/{id}/assignments/{memberId} */
  deleteRoutinesByIdAssignmentsByMemberId: {
    operationId: "deleteRoutinesByIdAssignmentsByMemberId",
    tags: ["chores"],
    summary:
      "Soft-deactivate the assignment (sets active=false; row is never hard-deleted, INV-08).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string(), memberId: z.string() }),
    response: {
      204: noContent("deactivated"),
      401: noContent("missing/invalid device key"),
      404: noContent("no such assignment"),
      429: authenticationBackoffResponse,
    },
  },
  /** GET /api/routines/{id}/chores */
  getRoutinesByIdChores: {
    operationId: "getRoutinesByIdChores",
    tags: ["chores"],
    summary: "List a routine's active chores, ordered.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    response: {
      200: { description: "OK", content: { "application/json": { schema: z.array(Chore) } } },
      401: noContent("missing/invalid device key"),
      404: {
        description: "The requested routine does not exist.",
        content: { "application/json": { schema: RouteError } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/routines/{id}/chores */
  postRoutinesByIdChores: {
    operationId: "postRoutinesByIdChores",
    tags: ["chores"],
    summary: "Add a chore to a routine (appended at the end of sortOrder).",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: ChoreInput,
    response: {
      201: { description: "created", content: { "application/json": { schema: Chore } } },
      400: { description: "validation", content: { "application/json": { schema: ErrorSchema } } },
      401: noContent("missing/invalid device key"),
      404: noContent("no such routine"),
      429: authenticationBackoffResponse,
    },
  },
  /** PUT /api/routines/{id}/chores/order */
  putRoutinesByIdChoresOrder: {
    operationId: "putRoutinesByIdChoresOrder",
    tags: ["chores"],
    summary:
      "Atomically reorder a routine's chores (FR-005/FR-006) — full-order replace, no partial state.",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string() }),
    body: ChoreOrderInput,
    response: {
      200: {
        description: "reordered (atomic)",
        content: { "application/json": { schema: z.array(Chore) } },
      },
      400: {
        description: "choreIds does not match the routine's active chore set",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: noContent("missing/invalid device key"),
      404: noContent("no such routine"),
      429: authenticationBackoffResponse,
    },
  },
});
