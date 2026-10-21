// Code-first OpenAPI: route schemas for the members HTTP surface.
// These zod schemas are the single source of truth for docs/api/openapi.json
// (npm run generate:openapi). They document the HTTP contract; validation stays in
// src/server/modules/* so error envelopes remain byte-compatible.
import { z } from "zod";
import { component, defineRouteSchemas } from "./zod";
import { AuthForbidden, ErrorSchema, authenticationBackoffResponse } from "./common";

export const BirthDate = component(
  "BirthDate",
  z.looseObject({
    month: z.int().min(1).max(12),
    day: z.int().min(1).max(31).meta({ description: "calendar-valid for the month (app layer)" }),
    year: z
      .int()
      .nullable()
      .meta({
        description: "present only when known; null = no age, never invented (MEMBERS-AC-07)",
      })
      .optional(),
  }),
  {
    description:
      "Month/day always present when set; year optional. Feb 29 allowed with a null year.\n",
  }
);

export const MemberColorKey = component(
  "MemberColorKey",
  z.enum(["blue", "sky", "teal", "green", "lime", "amber", "orange", "red", "pink", "violet"]),
  { description: "Curated screen identity only; never a CSS value or a monochrome print input." }
);

export const CreateMemberRequest = component(
  "CreateMemberRequest",
  z.strictObject({
    displayName: z.string().min(1),
    colorKey: MemberColorKey.meta({
      description:
        "Optional explicit key. If omitted, choose the first unused active-member key in palette order, or active-member count modulo ten after exhaustion. Archived members do not reserve keys. An explicit key that another active member holds is rejected (400) while any key is still unused.",
    }).optional(),
    role: z.enum(["parent", "child"]).meta({ description: "admin is rejected (MEMBERS-AC-01)" }),
    birthDate: z
      .xor([BirthDate, z.null()])
      .meta({ description: "optional birth date; null or absent = no birth date set." })
      .optional(),
  })
);

export const Member = component(
  "Member",
  z.looseObject({
    id: z
      .xor([
        z.string().meta({ format: "uuid" }),
        z.string().regex(new RegExp("^demo:member:[a-z0-9][a-z0-9-]*$")),
      ])
      .meta({
        description:
          "Public creation generates UUIDs; the maintained public seed uses stable demo:member identities. Restores preserve those identities.",
      }),
    displayName: z.string(),
    colorKey: MemberColorKey,
    role: z.enum(["parent", "child"]),
    lifecycle: z
      .enum(["active", "archived"])
      .meta({ description: "archive/restore transitions implemented (MEMBERS-INV-04)" }),
    birthDate: z
      .xor([BirthDate, z.null()])
      .meta({ description: "null/absent when unset (FR-009a clear)." })
      .optional(),
    createdAt: z.int(),
    updatedAt: z.int(),
  })
);

export const UpdateMemberRequest = component(
  "UpdateMemberRequest",
  z.strictObject({
    displayName: z.string().min(1).optional(),
    colorKey: MemberColorKey.meta({
      description:
        "A curated key; duplicates are allowed. Omission preserves the existing key, as do archive and restore.",
    }).optional(),
    role: z.enum(["parent", "child"]).optional(),
    birthDate: z
      .xor([BirthDate, z.null()])
      .meta({
        description:
          "null explicitly clears the birth date (FR-009a). Omitted fields are unchanged.",
      })
      .optional(),
  }),
  {
    minProperties: 1,
    description: "Partial profile update. Must include at least one field; role=admin rejected.",
  }
);

export const membersSchemas = defineRouteSchemas({
  /** GET /api/members */
  listMembers: {
    operationId: "listMembers",
    tags: ["members"],
    summary: "List all members (active and archived).",
    description:
      "Default (no lifecycle param or lifecycle=active) returns ACTIVE members only. lifecycle=archived → archived only; lifecycle=all → all members. Any other value returns 400 (invalid filter).\n",
    security: [{ deviceKeyCookie: [] }],
    querystring: z.object({
      lifecycle: z
        .enum(["active", "archived", "all"])
        .meta({ default: "active", description: "Filter by lifecycle (active/archived/all)." })
        .optional(),
    }),
    response: {
      200: {
        description: "The member list.",
        content: { "application/json": { schema: z.array(Member) } },
      },
      400: {
        description: "Invalid lifecycle filter.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "No/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      403: {
        description:
          "Revoked/expired credential or denied capability; code distinguishes credential loss from scope denial.",
        content: { "application/json": { schema: AuthForbidden } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/members */
  createMember: {
    operationId: "createMember",
    tags: ["members"],
    summary: "Create a Member (optionally with a birth date and colour key).",
    description:
      "One member profile in a single transaction, no Daily Briefing side effects. role=admin rejected.",
    security: [{ deviceKeyCookie: [] }],
    body: CreateMemberRequest,
    response: {
      201: {
        description: "Created (lifecycle active).",
        content: { "application/json": { schema: Member } },
      },
      400: {
        description:
          "Validation error — role=admin, unknown role, blank name, invalid birth date or colour key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "No/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** PATCH /api/members/{id} */
  updateMember: {
    operationId: "updateMember",
    tags: ["members"],
    summary: "Edit a member profile (displayName, role, colorKey, birthDate incl. clear).",
    description:
      "Partial update. Send `birthDate:null` to clear the birth date (FR-009a). No downstream side effects. Returns 404 if member not found; 400 for validation errors (invalid date, role=admin, no fields to update).\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string().meta({ format: "uuid" }) }),
    body: UpdateMemberRequest,
    response: {
      200: { description: "Updated member.", content: { "application/json": { schema: Member } } },
      400: {
        description: "Validation error (invalid date, role=admin, no fields).",
        content: { "application/json": { schema: ErrorSchema } },
      },
      401: {
        description: "No/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No member with that id.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/members/{id}/archive */
  archiveMember: {
    operationId: "archiveMember",
    tags: ["members"],
    summary: "Archive a member (active → archived). Idempotent.",
    description:
      "Single-row atomic transition; never a hard delete (MEMBERS-INV-04). Re-archiving an already archived member is a no-op success (returns current state without updating updated_at).\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string().meta({ format: "uuid" }) }),
    response: {
      200: {
        description: "Member archived (or already archived — no-op).",
        content: { "application/json": { schema: Member } },
      },
      401: {
        description: "No/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No member with that id.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
  /** POST /api/members/{id}/restore */
  restoreMember: {
    operationId: "restoreMember",
    tags: ["members"],
    summary: "Restore an archived member (archived → active). Idempotent.",
    description:
      "Reverses archive (FR-004). Re-restoring an already active member is a no-op success (returns current state without updating updated_at). An archived member holds no colour key: if another active member took theirs meanwhile, the restored member's `colorKey` becomes the first unused one.\n",
    security: [{ deviceKeyCookie: [] }],
    params: z.object({ id: z.string().meta({ format: "uuid" }) }),
    response: {
      200: {
        description: "Member restored (or already active — no-op).",
        content: { "application/json": { schema: Member } },
      },
      401: {
        description: "No/invalid device key.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      404: {
        description: "No member with that id.",
        content: { "application/json": { schema: ErrorSchema } },
      },
      429: authenticationBackoffResponse,
    },
  },
});
