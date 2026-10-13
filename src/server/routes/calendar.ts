import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  getEvents as getEventsService,
  createEvent as createEventService,
  replaceAssignments as replaceAssignmentsService,
  deleteEvent as deleteEventService,
  editEvent as editEventService,
  listExternalSources as listExternalSourcesService,
  upsertExternalSource as upsertExternalSourceService,
  NotFoundError,
} from "../modules/calendar/index";
import {
  getExternalSourcePhase,
  isExternalSourceDeleting,
  isExternalSourceReplacing,
  startExternalSourceSynchronization,
  type CalendarFeedDependencies,
} from "../modules/calendar/sync-coordinator";
import type { ExternalSourcePublic } from "../../shared";
import {
  deleteExternalSource,
  setExternalSourceEnabled,
} from "../modules/calendar/external-sources";
import {
  createHighlightRule,
  deleteHighlightRule,
  HighlightValidationError,
  listHighlightRules,
  reorderHighlightRules,
  setHighlightRuleEnabled,
} from "../modules/calendar/highlights";

const EXTERNAL_SOURCE_UPSERT_KEYS = new Set(["name", "provider", "feedUrl", "pollIntervalMin"]);
const EXTERNAL_SOURCE_UPSERT_REQUIRED_KEYS = ["name", "provider", "feedUrl"] as const;

function isExternalSourceUpsertBody(value: unknown): value is {
  name: unknown;
  provider: unknown;
  feedUrl: unknown;
  pollIntervalMin?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => EXTERNAL_SOURCE_UPSERT_KEYS.has(key)) &&
    EXTERNAL_SOURCE_UPSERT_REQUIRED_KEYS.every((key) => Object.hasOwn(value, key))
  );
}

function withPhase(source: ExternalSourcePublic): ExternalSourcePublic {
  return { ...source, phase: getExternalSourcePhase(source.id) };
}

export async function calendarRoutes(
  app: FastifyInstance,
  calendarFeedDependencies: CalendarFeedDependencies = {}
): Promise<void> {
  app.get("/api/calendar/highlight-rules", async (request, reply) => {
    try {
      return reply.code(200).send(listHighlightRules());
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.post("/api/calendar/highlight-rules", async (request, reply) => {
    try {
      return reply.code(201).send(createHighlightRule(request.body));
    } catch (error) {
      if (error instanceof HighlightValidationError)
        return reply.code(400).send({ error: error.message });
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.put("/api/calendar/highlight-rules/reorder", async (request, reply) => {
    try {
      const body = request.body;
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !Object.hasOwn(body, "orderedIds")
      )
        return reply.code(400).send({ error: "invalid_highlight_order" });
      return reply
        .code(200)
        .send(reorderHighlightRules((body as { orderedIds: unknown }).orderedIds));
    } catch (error) {
      if (error instanceof HighlightValidationError)
        return reply.code(400).send({ error: error.message });
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.patch("/api/calendar/highlight-rules/:id", async (request, reply) => {
    const body = request.body;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { enabled?: unknown }).enabled !== "boolean"
    )
      return reply.code(400).send({ error: "invalid_highlight_rule" });
    try {
      const { id } = request.params as { id: string };
      const rule = setHighlightRuleEnabled(id, (body as { enabled: boolean }).enabled);
      return rule
        ? reply.code(200).send(rule)
        : reply.code(404).send({ error: "highlight_rule_not_found" });
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.delete("/api/calendar/highlight-rules/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return deleteHighlightRule(id)
        ? reply.code(204).send()
        : reply.code(404).send({ error: "highlight_rule_not_found" });
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.get("/api/calendar/external-sources", async (request, reply) => {
    try {
      return reply.code(200).send(listExternalSourcesService().map(withPhase));
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.put(
    "/api/calendar/external-sources/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const body = request.body;
        if (!isExternalSourceUpsertBody(body))
          return reply.code(400).send({ error: "invalid_external_source" });
        const source = await upsertExternalSourceService(
          {
            id,
            name: body.name as string,
            provider: body.provider as string,
            feedUrl: body.feedUrl as string,
            pollIntervalMin: body.pollIntervalMin as number | undefined,
          },
          calendarFeedDependencies
        );
        void startExternalSourceSynchronization(id, calendarFeedDependencies);
        return reply.code(202).send(withPhase(source));
      } catch (error: unknown) {
        const err = error as { name?: string; message?: string };
        if (err.name === "ValidationError") return reply.code(400).send({ error: err.message });
        request.log.error(error);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  app.patch(
    "/api/calendar/external-sources/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body;
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        typeof (body as { enabled?: unknown }).enabled !== "boolean"
      )
        return reply.code(400).send({ error: "invalid_external_source" });
      try {
        const { id } = request.params as { id: string };
        const source = setExternalSourceEnabled(id, (body as { enabled: boolean }).enabled);
        return source
          ? reply.code(200).send(withPhase(source))
          : reply.code(404).send({ error: "external_source_not_found" });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  app.delete(
    "/api/calendar/external-sources/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        return (await deleteExternalSource(id))
          ? reply.code(204).send()
          : reply.code(404).send({ error: "external_source_not_found" });
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  app.post(
    "/api/calendar/external-sources/:id/sync",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const source = listExternalSourcesService().find((candidate) => candidate.id === id);
        if (!source) return reply.code(404).send({ error: "external_source_not_found" });
        if (!source.enabled || isExternalSourceDeleting(id) || isExternalSourceReplacing(id))
          return reply.code(409).send({ error: "external_source_disabled" });
        void startExternalSourceSynchronization(id, calendarFeedDependencies);
        return reply.code(202).send(withPhase(source));
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  app.get<{
    Querystring: {
      source?: string;
      assignedTo?: string;
      query?: string;
      queryFields?: string[];
      from?: string;
      to?: string;
    };
  }>(
    "/api/calendar/events",
    async (
      request: FastifyRequest<{
        Querystring: {
          source?: string;
          assignedTo?: string;
          query?: string;
          queryFields?: string[];
          from?: string;
          to?: string;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const { source = "all", assignedTo, query, queryFields, from, to } = request.query;

        if (!from || !to) {
          return reply.code(400).send({ error: "Missing required parameters 'from' and 'to'" });
        }

        const items = getEventsService({
          source,
          assignedTo,
          query,
          queryFields: queryFields
            ? Array.isArray(queryFields)
              ? queryFields
              : [queryFields]
            : undefined,
          range: { from, to },
        });

        return reply.code(200).send(items);
      } catch (e: any) {
        if (e.name === "ValidationError" || e.name === "WindowError") {
          return reply.code(400).send({ error: e.message });
        }
        // Unexpected failure (DB, recurrence expansion, stored-JSON parse) must NOT be
        // masked as a client 400 — surface it as 500 so it is observable.
        request.log.error(e);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  app.post<{
    Body: {
      title: string;
      allDay: boolean;
      startDate?: string;
      endDate?: string;
      startUtc?: string;
      endUtc?: string;
      tzid?: string;
      rrule?: string | null;
      exdates?: string[];
      description?: string | null;
      location?: string | null;
    };
  }>(
    "/api/calendar/events",
    async (
      request: FastifyRequest<{
        Body: {
          title: string;
          allDay: boolean;
          startDate?: string;
          endDate?: string;
          startUtc?: string;
          endUtc?: string;
          tzid?: string;
          rrule?: string | null;
          exdates?: string[];
          description?: string | null;
          location?: string | null;
        };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const input = request.body;
        const result = createEventService(input);
        return reply.code(201).send(result);
      } catch (e: any) {
        if (e.name === "ValidationError" || e.name === "WindowError") {
          return reply.code(400).send({ error: e.message });
        }
        // Unexpected failure (DB, recurrence expansion, stored-JSON parse) must NOT be
        // masked as a client 400 — surface it as 500 so it is observable.
        request.log.error(e);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );

  app.patch("/api/calendar/events/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      const body = request.body as Partial<{
        title: string;
        allDay: boolean;
        startDate?: string;
        endDate?: string;
        startUtc?: string;
        endUtc?: string;
        tzid?: string;
        rrule?: string | null;
        exdates?: string[];
      }>;

      const result = editEventService(id, body);
      return reply.code(200).send(result);
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err.name === "ValidationError" || err.name === "WindowError") {
        return reply.code(400).send({ error: err.message });
      }
      if (err instanceof NotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      request.log.error(e);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.delete("/api/calendar/events/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };

    try {
      deleteEventService(id);
      return reply.code(204).send();
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err instanceof NotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      request.log.error(e);
      return reply.code(500).send({ error: "Internal server error" });
    }
  });

  app.put(
    "/api/calendar/events/:id/assignments",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };

      try {
        // Fix 3: validate the body inside the try block
        const body = request.body as { memberIds?: unknown };
        if (typeof body !== "object" || body === null || !Array.isArray(body.memberIds)) {
          return reply
            .code(400)
            .send({ error: "Invalid request body: memberIds must be an array" });
        }

        const result = replaceAssignmentsService(id, body.memberIds);

        // Return the real FeedItem from the service
        return reply.code(200).send(result);
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (
          err.name === "ValidationError" ||
          err.name === "WindowError" ||
          err.name === "MemberReferenceError"
        ) {
          return reply.code(400).send({ error: err.message });
        }
        if (err instanceof NotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        request.log.error(e);
        return reply.code(500).send({ error: "Internal server error" });
      }
    }
  );
}
