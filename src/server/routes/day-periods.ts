import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  DayPeriodNotFoundError,
  DayPeriodValidationError,
  editDayPeriodStart,
  listDayPeriods,
  resolveActive,
} from "../modules/day-periods";
import { readHouseholdTimezone } from "../lib/household-date";

export async function dayPeriodsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/day-periods", async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(200).send(listDayPeriods());
  });

  app.patch("/api/day-periods/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const id = (request.params as { id: string }).id;
      const body = request.body as unknown;
      const result = editDayPeriodStart(id, body);
      return reply.code(200).send(result);
    } catch (e) {
      if (e instanceof DayPeriodNotFoundError) {
        return reply.code(404).send({ error: "not_found", message: e.message });
      }
      if (e instanceof DayPeriodValidationError) {
        return reply.code(400).send({ error: "validation_error", message: e.message });
      }
      throw e;
    }
  });

  app.get("/api/day-periods/active", async (request: FastifyRequest, reply: FastifyReply) => {
    const timezone = readHouseholdTimezone();

    const nowFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    const parts = nowFormatter.formatToParts(new Date());
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
    const nowMinutes = hour * 60 + minute;

    const activeId = resolveActive(nowMinutes);

    return reply.code(200).send({ activeId });
  });
}
