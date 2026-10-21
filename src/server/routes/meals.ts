import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  createRecipe,
  editRecipe,
  listRecipes,
  getRecipe,
  searchRecipes,
  deleteRecipe,
  getRecipeDependents,
  createMealPlan,
  listMealPlans,
  getMealPlan,
  editMealPlan,
  listPlanEntries,
  createEntry,
  editEntry,
  deleteEntry,
  getMenu,
  getWeekMenu,
  MealValidationError,
  MealNotFoundError,
} from "../modules/meals/index";
import { mealsSchemas } from "../openapi/meals";
import { documented } from "../openapi/zod";

/** Thin meals route handlers (assembly seam + recipe CRUD +
 * one-off entry edit/delete, informed-cascade recipe delete, and dependent
 * counts + meal plans/recurring entries/week view) —
 * POST/GET /api/recipes, GET/PATCH/DELETE /api/recipes/:id,
 * GET /api/recipes/:id/dependents, POST/GET /api/meal-plans,
 * GET/PATCH /api/meal-plans/:id, GET /api/meal-plans/:id/entries,
 * POST/PATCH/DELETE /api/meal-entries(id), GET /api/menu, GET /api/menu/week.
 * Meal plans are deactivate-only — there is NO delete route (Clarifications).
 */
export async function mealsRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/recipes — create a recipe
  app.post(
    "/api/recipes",
    documented(mealsSchemas.createRecipe),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const recipe = createRecipe(request.body);
        return reply.code(201).send(recipe);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/recipes?search= — list all recipes, or search by name (JS-normalized)
  app.get(
    "/api/recipes",
    documented(mealsSchemas.listRecipes),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { search } = request.query as { search?: unknown };
        const recipes =
          typeof search === "string" && search.trim().length > 0
            ? searchRecipes(search)
            : listRecipes();
        return reply.code(200).send(recipes);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/recipes/:id — fetch one recipe
  app.get(
    "/api/recipes/:id",
    documented(mealsSchemas.getRecipe),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const recipe = getRecipe(id);
        return reply.code(200).send(recipe);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // PATCH /api/recipes/:id — partial edit, strict update-by-id (FR-005)
  app.patch(
    "/api/recipes/:id",
    documented(mealsSchemas.editRecipe),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const recipe = editRecipe(id, request.body);
        return reply.code(200).send(recipe);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // DELETE /api/recipes/:id — informed-cascade delete (recipe + referencing entries, FR-003/004)
  app.delete(
    "/api/recipes/:id",
    documented(mealsSchemas.deleteRecipe),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        deleteRecipe(id);
        return reply.code(204).send();
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/recipes/:id/dependents — split dependent counts, advisory pre-delete (AC-06)
  app.get(
    "/api/recipes/:id/dependents",
    documented(mealsSchemas.getRecipeDependents),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const counts = getRecipeDependents(id);
        return reply.code(200).send(counts);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // POST /api/meal-plans — create a meal_plan (always active)
  app.post(
    "/api/meal-plans",
    documented(mealsSchemas.createMealPlan),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const plan = createMealPlan(request.body);
        return reply.code(201).send(plan);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/meal-plans — list all meal_plans (active and inactive)
  app.get(
    "/api/meal-plans",
    documented(mealsSchemas.listMealPlans),
    async (_request: FastifyRequest, reply: FastifyReply) => {
      try {
        const plans = listMealPlans();
        return reply.code(200).send(plans);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/meal-plans/:id — fetch one meal_plan
  app.get(
    "/api/meal-plans/:id",
    documented(mealsSchemas.getMealPlan),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const plan = getMealPlan(id);
        return reply.code(200).send(plan);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // PATCH /api/meal-plans/:id — rename and/or activate/deactivate (allow-list name/active)
  app.patch(
    "/api/meal-plans/:id",
    documented(mealsSchemas.editMealPlan),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const plan = editMealPlan(id, request.body);
        return reply.code(200).send(plan);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/meal-plans/:id/entries — a plan's recurring entries, incl. an inactive plan's
  app.get(
    "/api/meal-plans/:id/entries",
    documented(mealsSchemas.listPlanEntries),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const entries = listPlanEntries(id);
        return reply.code(200).send(entries);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // POST /api/meal-entries — add an entry, recurring or one-off (recipeId xor note)
  app.post(
    "/api/meal-entries",
    documented(mealsSchemas.createMealEntry),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const entry = createEntry(request.body);
        return reply.code(201).send(entry);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // PATCH /api/meal-entries/:id — content-only edit (recipeId xor note, Clarifications)
  app.patch(
    "/api/meal-entries/:id",
    documented(mealsSchemas.editMealEntry),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const entry = editEntry(id, request.body);
        return reply.code(200).send(entry);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // DELETE /api/meal-entries/:id — idempotent (double-delete -> 404, FR-021 LWW)
  app.delete(
    "/api/meal-entries/:id",
    documented(mealsSchemas.deleteMealEntry),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        deleteEntry(id);
        return reply.code(204).send();
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/menu?date=&slot= — derived day menu (recurring+one-off union; tombstone for a missing recipe, INV-09)
  app.get(
    "/api/menu",
    documented(mealsSchemas.getMenu),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { date, slot } = request.query as { date?: unknown; slot?: unknown };
        const menu = getMenu(date, slot);
        return reply.code(200).send(menu);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );

  // GET /api/menu/week?date= — derived week grid, 7 local dates from weekStartDay+tz
  app.get(
    "/api/menu/week",
    documented(mealsSchemas.getWeekMenu),
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { date } = request.query as { date?: unknown };
        const week = getWeekMenu(date);
        return reply.code(200).send(week);
      } catch (err) {
        return handleMealError(err, reply);
      }
    }
  );
}

// ── Error handling helper ────────────────────────────────────────────────

function handleMealError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof MealNotFoundError) {
    return reply.code(404).send({ error: "not_found", message: err.message });
  }
  if (err instanceof MealValidationError) {
    return reply.code(400).send({ error: "validation_error", message: err.message });
  }
  // Unexpected error
  console.error("Unexpected error in meal handler:", err);
  return reply.code(500).send({ error: "internal_error", message: "An unexpected error occurred" });
}
