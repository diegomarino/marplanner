import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ReminderInput, ReminderEditInput } from "../../shared";
import {
  createReminder,
  listReminders,
  getReminder,
  editReminder,
  deleteReminder,
  replaceAssignments,
  getReminders,
  dryRun,
  ReminderValidationError,
  ReminderNotFoundError,
} from "../modules/reminders/index";
import { WindowError } from "../modules/calendar/index";
import { remindersSchemas } from "../openapi/reminders";
import { documented } from "../openapi/zod";

/** Thin reminders route handlers (assembly + apply_to_all CRUD +
 * specific path).
 * The full CRUD (list/get/edit/delete), create (apply_to_all + specific),
 * the assignment set-replace, and the live-emission-read. Error mapping
 * follows the Members/Calendar precedent: typed errors → HTTP status.
 */
export async function remindersRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/reminders — list all reminder rules
  app.get(
    "/api/reminders",
    documented(remindersSchemas.getReminders),
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const reminders = listReminders();
        return reply.code(200).send(reminders);
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );

  // POST /api/reminders — create a scheduled or calendar_gated reminder (widened 009)
  app.post<{ Body: ReminderInput }>(
    "/api/reminders",
    documented(remindersSchemas.postReminders),
    async (request: FastifyRequest<{ Body: ReminderInput }>, reply: FastifyReply) => {
      try {
        const reminder = createReminder(request.body);
        return reply.code(201).send(reminder);
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );

  // GET /api/reminders/:id — fetch one reminder rule
  app.get(
    "/api/reminders/:id",
    documented(remindersSchemas.getRemindersById),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const reminder = getReminder(id);
        return reply.code(200).send(reminder);
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );

  // PATCH /api/reminders/:id — edit text/active/(apply_to_all)weekdays/(calendar_gated)query+queryFields (widened 009)
  app.patch<{ Body: ReminderEditInput }>(
    "/api/reminders/:id",
    documented(remindersSchemas.patchRemindersById),
    async (request: FastifyRequest<{ Body: ReminderEditInput }>, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const reminder = editReminder(id, request.body);
        return reply.code(200).send(reminder);
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );

  // DELETE /api/reminders/:id — hard-delete a reminder rule
  app.delete(
    "/api/reminders/:id",
    documented(remindersSchemas.deleteRemindersById),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        deleteReminder(id);
        return reply.code(204).send();
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );

  // PUT /api/reminders/:id/assignments — atomic full-set replace (specific only)
  app.put(
    "/api/reminders/:id/assignments",
    documented(remindersSchemas.putRemindersByIdAssignments),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const assignments = replaceAssignments(id, request.body);
        return reply.code(200).send(assignments);
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );

  // GET /api/reminders/emissions?memberId=&date= — live emission read
  app.get(
    "/api/reminders/emissions",
    documented(remindersSchemas.getRemindersEmissions),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { memberId, date } = request.query as { memberId?: unknown; date?: unknown };
        const emissions = getReminders(memberId, date);
        return reply.code(200).send(emissions);
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );

  // POST /api/reminders/:id/dry-run — would this calendar_gated rule emit for (memberId,date), and why not
  app.post(
    "/api/reminders/:id/dry-run",
    documented(remindersSchemas.postRemindersByIdDryRun),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const result = dryRun(id, request.body);
        return reply.code(200).send(result);
      } catch (err) {
        return handleReminderError(err, reply);
      }
    }
  );
}

// ── Error handling helper ────────────────────────────────────────────────

function handleReminderError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof ReminderNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof ReminderValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  if (err instanceof WindowError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  // Unexpected error
  console.error("Unexpected error in reminder handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
