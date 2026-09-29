import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { registerRoutesWithCapabilities } from "../auth/capability";
import {
  listTimeAnnouncementRules,
  createTimeAnnouncementRule,
  editTimeAnnouncementRule,
  deleteTimeAnnouncementRule,
  TimeAnnouncementValidationError,
  TimeAnnouncementNotFoundError,
  TimeAnnouncementOverlapError,
} from "../modules/time-announcements/index";

/** Thin time-announcements HTTP boundary. GET is a PLAIN authenticated
 * route — no capability declared — since the rule list is kiosk-visible (AC-07); every write
 * (POST/PATCH/DELETE) declares `time-announcements:admin` via `registerRoutesWithCapabilities`
 * (fail-closed, telemetry/backups precedent — omitting one would throw at registration). Error
 * mapping follows the reminders/daily-messages precedent: typed module errors -> HTTP status,
 * per the contract's 400/404/409 vocabulary.
 */
export async function timeAnnouncementsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/time-announcements", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rules = listTimeAnnouncementRules();
      return reply.code(200).send(rules);
    } catch (err) {
      return handleTimeAnnouncementError(err, reply);
    }
  });

  registerRoutesWithCapabilities(app, [
    {
      method: "post",
      path: "/api/time-announcements",
      capability: "time-announcements:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const rule = createTimeAnnouncementRule(request.body);
          return reply.code(201).send(rule);
        } catch (err) {
          return handleTimeAnnouncementError(err, reply);
        }
      },
    },
    {
      method: "patch",
      path: "/api/time-announcements/:id",
      capability: "time-announcements:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const { id } = request.params as { id: string };
          const rule = editTimeAnnouncementRule(id, request.body);
          return reply.code(200).send(rule);
        } catch (err) {
          return handleTimeAnnouncementError(err, reply);
        }
      },
    },
    {
      method: "delete",
      path: "/api/time-announcements/:id",
      capability: "time-announcements:admin",
      handler: async (request: FastifyRequest, reply: FastifyReply) => {
        try {
          const { id } = request.params as { id: string };
          deleteTimeAnnouncementRule(id);
          return reply.code(204).send();
        } catch (err) {
          return handleTimeAnnouncementError(err, reply);
        }
      },
    },
  ]);
}

// ── Error handling helper ────────────────────────────────────────────────

function handleTimeAnnouncementError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof TimeAnnouncementNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof TimeAnnouncementOverlapError) {
    return reply.code(409).send({ error: "active_overlap", message: err.message });
  }
  if (err instanceof TimeAnnouncementValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  // Unexpected error
  console.error("Unexpected error in time-announcements handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
