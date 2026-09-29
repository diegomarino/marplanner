import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  createRoutine,
  getRoutineById,
  editRoutine,
  softDeleteRoutine,
  listRoutines,
  createChore,
  getChoreById,
  editChore,
  softDeleteChore,
  reorderChores,
  listChores,
  upsertAssignment,
  deactivateAssignment,
  listRoutineAssignments,
  getBoard,
  completeChore,
  uncompleteChore,
  ChoreNotFoundError,
  RoutineNotFoundError,
  RoutineValidationError,
  ChoreValidationError,
  DayPeriodNotFoundError,
  AssignmentNotFoundError,
  AssignmentValidationError,
  BoardValidationError,
  CompletionValidationError,
} from "../modules/routines/index";

/** Thin routines-chores route handlers (— wiring implementation).
 * All 17 routes from `openapi.planned.yaml` are implemented here, calling
 * the module functions from `src/server/modules/routines/index.ts`.
 * Error mapping follows the Members/Calendar precedent: typed errors → HTTP status.
 */
export async function routinesRoutes(app: FastifyInstance): Promise<void> {
  // ── Routines CRUD ──────────────────────────────────────────────────────

  // GET /api/routines — list active routines
  app.get("/api/routines", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const routines = listRoutines();
      return reply.code(200).send(routines);
    } catch (err) {
      return handleRoutineError(err, reply);
    }
  });

  // POST /api/routines — create a routine
  app.post("/api/routines", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const input = request.body as unknown;
      const routine = createRoutine(input);
      return reply.code(201).send(routine);
    } catch (err) {
      return handleRoutineError(err, reply);
    }
  });

  // GET /api/routines/:id — fetch one routine by id
  app.get("/api/routines/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const routine = getRoutineById(id);
      return reply.code(200).send(routine);
    } catch (err) {
      return handleRoutineError(err, reply);
    }
  });

  // PATCH /api/routines/:id — edit a routine
  app.patch("/api/routines/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const routine = editRoutine(id, request.body);
      return reply.code(200).send(routine);
    } catch (err) {
      return handleRoutineError(err, reply);
    }
  });

  // DELETE /api/routines/:id — soft-delete a routine
  app.delete("/api/routines/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      softDeleteRoutine(id);
      return reply.code(204).send();
    } catch (err) {
      return handleRoutineError(err, reply);
    }
  });

  // ── Chores CRUD ────────────────────────────────────────────────────────

  // GET /api/routines/:id/chores — list a routine's active chores
  app.get("/api/routines/:id/chores", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const chores = listChores(id);
      return reply.code(200).send(chores);
    } catch (err) {
      return handleChoreError(err, reply);
    }
  });

  // POST /api/routines/:id/chores — add a chore
  app.post("/api/routines/:id/chores", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const chore = createChore(id, request.body);
      return reply.code(201).send(chore);
    } catch (err) {
      return handleChoreError(err, reply);
    }
  });

  // PUT /api/routines/:id/chores/order — reorder chores
  app.put(
    "/api/routines/:id/chores/order",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const chores = reorderChores(id, request.body);
        return reply.code(200).send(chores);
      } catch (err) {
        return handleChoreError(err, reply);
      }
    }
  );

  // GET /api/chores/:id — fetch one chore by id
  app.get("/api/chores/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const chore = getChoreById(id);
      return reply.code(200).send(chore);
    } catch (err) {
      return handleChoreError(err, reply);
    }
  });

  // PATCH /api/chores/:id — edit a chore
  app.patch("/api/chores/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const chore = editChore(id, request.body);
      return reply.code(200).send(chore);
    } catch (err) {
      return handleChoreError(err, reply);
    }
  });

  // DELETE /api/chores/:id — soft-delete a chore
  app.delete("/api/chores/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      softDeleteChore(id);
      return reply.code(204).send();
    } catch (err) {
      return handleChoreError(err, reply);
    }
  });

  // ── Assignments ────────────────────────────────────────────────────────

  // GET /api/routines/:id/assignments — list a routine's assignments
  app.get("/api/routines/:id/assignments", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id: routineId } = request.params as { id: string };
      const result = listRoutineAssignments(routineId);
      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof RoutineNotFoundError) {
        return reply.code(404).send({ error: "not_found", message: err.message });
      }
      console.error("Unexpected error in assignments list handler:", err);
      return reply
        .code(500)
        .send({ error: "internal_error", message: "An unexpected error occurred" });
    }
  });

  // PUT /api/routines/:id/assignments/:memberId — upsert assignment
  app.put(
    "/api/routines/:id/assignments/:memberId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id: routineId, memberId } = request.params as {
          id: string;
          memberId: string;
        };

        // Validate request body exists and has required weekday field
        const body = request.body as { weekdays?: unknown; active?: unknown } | undefined;
        if (!body) {
          return reply
            .code(400)
            .send({ error: "validation_error", message: "Request body is required" });
        }

        if (body.weekdays === undefined) {
          return reply
            .code(400)
            .send({ error: "validation_error", message: "weekdays is required" });
        }

        if (body.active !== undefined && body.active !== null && typeof body.active !== "boolean") {
          return reply
            .code(400)
            .send({ error: "validation_error", message: "active must be a boolean" });
        }

        const { weekdays, active } = body;
        const result = upsertAssignment(routineId, memberId, weekdays, active);
        return reply.code(200).send(result);
      } catch (err) {
        return handleAssignmentError(err, reply);
      }
    }
  );

  // DELETE /api/routines/:id/assignments/:memberId — deactivate assignment
  app.delete(
    "/api/routines/:id/assignments/:memberId",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id: routineId, memberId } = request.params as {
          id: string;
          memberId: string;
        };
        deactivateAssignment(routineId, memberId);
        return reply.code(204).send();
      } catch (err) {
        return handleAssignmentError(err, reply);
      }
    }
  );

  // ── Board ──────────────────────────────────────────────────────────────

  // GET /api/chores/board — the household board
  // GET /api/chores/board — the household board
  app.get("/api/chores/board", async (request: FastifyRequest, reply: FastifyReply) => {
    const date = (request.query as { date?: string }).date;
    if (!date) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Missing required query parameter: date" });
    }

    try {
      const board = getBoard(date);
      return reply.code(200).send(board);
    } catch (err) {
      if (err instanceof BoardValidationError) {
        return reply.code(400).send({ error: "validation_error", message: err.message });
      }
      // Unexpected error
      console.error("Unexpected error in board handler:", err);
      return reply
        .code(500)
        .send({ error: "internal_error", message: "An unexpected error occurred" });
    }
  });

  // POST /api/chores/:id/completions — complete a chore (gated on current markability)
  app.post("/api/chores/:id/completions", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string };
      const body = request.body as { memberId?: unknown; date?: unknown } | undefined;
      completeChore(id, body?.memberId, body?.date);
      return reply.code(204).send();
    } catch (err) {
      return handleCompletionError(err, reply);
    }
  });

  // DELETE /api/chores/:id/completions — uncomplete a chore (always allowed, FR-009/AC-01)
  app.delete(
    "/api/chores/:id/completions",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const query = request.query as { memberId?: unknown; date?: unknown };
        uncompleteChore(id, query?.memberId, query?.date);
        return reply.code(204).send();
      } catch (err) {
        return handleCompletionError(err, reply);
      }
    }
  );
}

// ── Error handling helpers ────────────────────────────────────────────────

function handleRoutineError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof RoutineNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof RoutineValidationError || err instanceof DayPeriodNotFoundError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  // Unexpected error
  console.error("Unexpected error in routine handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}

function handleChoreError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof ChoreNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof RoutineNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof ChoreValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  // Unexpected error
  console.error("Unexpected error in chore handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}

function handleCompletionError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof ChoreNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof CompletionValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  // Unexpected error — this is what the post-commit-only trap-sweep test
  // exercises: a thrown write failure must map here, never emit the event.
  console.error("Unexpected error in completion handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}

function handleAssignmentError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof AssignmentNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof AssignmentValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  if (err instanceof RoutineNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  // Unexpected error
  console.error("Unexpected error in assignment handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
