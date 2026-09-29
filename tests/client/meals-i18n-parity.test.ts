import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

/** — meals i18n parity (closes).
 * Locks the en/es catalog parity for the meals admin + family surfaces: every
 * `meals.*` key plus `admin.nav.mealsManagement` must exist in BOTH locales
 * and resolve to a non-empty string. Developer/diagnostic text stays English
 * by design — this test only covers user-facing i18n keys.
 */
describe("meals-i18n-parity", () => {
  it("en and es catalogs have identical keys (both directions)", () => {
    const enKeys = Object.keys(messages.en);
    const esKeys = Object.keys(messages.es);

    expect(enKeys).toHaveLength(esKeys.length);

    for (const key of enKeys) {
      expect(esKeys).toContain(key);
    }

    for (const key of esKeys) {
      expect(enKeys).toContain(key);
    }
  });

  it("meals.*/admin.nav.mealsManagement keys have identical coverage in en and es (both directions)", () => {
    const isMealsKey = (key: string) =>
      key.startsWith("meals.") || key === "admin.nav.mealsManagement";

    const enKeys = Object.keys(messages.en).filter(isMealsKey);
    const esKeys = Object.keys(messages.es).filter(isMealsKey);

    // Sanity: this module actually added keys in this namespace.
    expect(enKeys.length).toBeGreaterThan(0);
    expect(enKeys).toHaveLength(esKeys.length);

    for (const key of enKeys) {
      expect(esKeys).toContain(key);
    }

    for (const key of esKeys) {
      expect(enKeys).toContain(key);
    }
  });

  it("meals.*/admin.nav.mealsManagement keys resolve to a non-empty string in both languages", () => {
    const isMealsKey = (key: string) =>
      key.startsWith("meals.") || key === "admin.nav.mealsManagement";

    const enKeys = Object.keys(messages.en).filter(isMealsKey);

    for (const key of enKeys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  it("meals.*/admin.nav.mealsManagement keys resolve to the expected strings in both languages", () => {
    expect(messages.en["admin.nav.mealsManagement"]).toBe("Meals Management");
    expect(messages.en["meals.management.title"]).toBe("Meals Management");
    expect(messages.en["meals.management.description"]).toBe(
      "Manage recipes, author one-off meal entries, and view the derived daily menu."
    );
    expect(messages.en["meals.management.loading"]).toBe("Loading…");
    expect(messages.en["meals.management.error"]).toBe("Failed to load meals data.");
    expect(messages.en["meals.recipes.title"]).toBe("Recipes");
    expect(messages.en["meals.recipes.searchPlaceholder"]).toBe("Search recipes…");
    expect(messages.en["meals.recipes.noRecipes"]).toBe("No recipes found.");
    expect(messages.en["meals.recipes.createTitle"]).toBe("Create Recipe");
    expect(messages.en["meals.recipes.namePlaceholder"]).toBe("Recipe name");
    expect(messages.en["meals.recipes.ingredientsLabel"]).toBe("Ingredients (one per line)");
    expect(messages.en["meals.recipes.instructionsLabel"]).toBe("Instructions");
    expect(messages.en["meals.recipes.slotsLabel"]).toBe("Slots");
    expect(messages.en["meals.recipes.slotsHint"]).toBe(
      "Leave all unchecked to allow this recipe in every slot."
    );
    expect(messages.en["meals.recipes.deleteConfirmSimple"]).toBe("Delete this recipe?");
    expect(messages.en["meals.recipes.deleteConfirmPrefix"]).toBe("This recipe is referenced by");
    expect(messages.en["meals.recipes.deleteConfirmRecurringLabel"]).toBe("recurring entries");
    expect(messages.en["meals.recipes.deleteConfirmOneOffLabel"]).toBe("one-off entries");
    expect(messages.en["meals.recipes.deleteConfirmSuffix"]).toBe(
      "Deleting it will also delete these entries. Continue?"
    );
    expect(messages.en["meals.slot.breakfast"]).toBe("Breakfast");
    expect(messages.en["meals.slot.lunch"]).toBe("Lunch");
    expect(messages.en["meals.slot.snack"]).toBe("Snack");
    expect(messages.en["meals.slot.dinner"]).toBe("Dinner");
    expect(messages.en["meals.action.create"]).toBe("Create");
    expect(messages.en["meals.action.edit"]).toBe("Edit");
    expect(messages.en["meals.action.save"]).toBe("Save");
    expect(messages.en["meals.action.cancel"]).toBe("Cancel");
    expect(messages.en["meals.action.delete"]).toBe("Delete");
    expect(messages.en["meals.entries.title"]).toBe("Add One-off Entry");
    expect(messages.en["meals.entries.dateLabel"]).toBe("Date");
    expect(messages.en["meals.entries.slotLabel"]).toBe("Slot");
    expect(messages.en["meals.entries.contentModeRecipe"]).toBe("Recipe");
    expect(messages.en["meals.entries.contentModeNote"]).toBe("Note");
    expect(messages.en["meals.entries.recipeSelectPlaceholder"]).toBe("Select a recipe…");
    expect(messages.en["meals.entries.notePlaceholder"]).toBe("Entry note");
    expect(messages.en["meals.entries.noRecipesForSlot"]).toBe(
      "No recipes available for this slot."
    );
    expect(messages.en["meals.entries.action.add"]).toBe("Add Entry");
    expect(messages.en["meals.entries.error"]).toBe("Failed to add entry.");
    expect(messages.en["meals.menu.title"]).toBe("Day Menu");
    expect(messages.en["meals.menu.dateLabel"]).toBe("Date");
    expect(messages.en["meals.menu.slotFilterLabel"]).toBe("Slot");
    expect(messages.en["meals.menu.slotFilterAll"]).toBe("All slots");
    expect(messages.en["meals.menu.loading"]).toBe("Loading…");
    expect(messages.en["meals.menu.error"]).toBe("Failed to load the menu.");
    expect(messages.en["meals.menu.empty"]).toBe("No entries for this day.");
    expect(messages.en["meals.menu.tombstoneLabel"]).toBe("Deleted recipe");
    expect(messages.en["meals.plan.title"]).toBe("Meal Plans");
    expect(messages.en["meals.plan.createTitle"]).toBe("Create Meal Plan");
    expect(messages.en["meals.plan.namePlaceholder"]).toBe("Plan name");
    expect(messages.en["meals.plan.loading"]).toBe("Loading…");
    expect(messages.en["meals.plan.noPlans"]).toBe("No meal plans found.");
    expect(messages.en["meals.plan.error"]).toBe("Failed to load meal plans.");
    expect(messages.en["meals.plan.statusActive"]).toBe("Active");
    expect(messages.en["meals.plan.statusInactive"]).toBe("Inactive");
    expect(messages.en["meals.plan.action.activate"]).toBe("Activate");
    expect(messages.en["meals.plan.action.deactivate"]).toBe("Deactivate");
    expect(messages.en["meals.plan.hideEntries"]).toBe("Hide Entries");
    expect(messages.en["meals.plan.showEntries"]).toBe("Show Entries");
    expect(messages.en["meals.plan.entriesEmpty"]).toBe("No entries in this plan.");
    expect(messages.en["meals.plan.entriesError"]).toBe("Failed to update plan entries.");
    expect(messages.en["meals.plan.entryDeleteConfirm"]).toBe("Delete this entry?");
    expect(messages.en["meals.plan.selectLabel"]).toBe("Meal Plan");
    expect(messages.en["meals.plan.selectPlaceholder"]).toBe("Select a meal plan…");
    expect(messages.en["meals.plan.weekdayLabel"]).toBe("Weekday");
    expect(messages.en["meals.plan.noPlansForRecurring"]).toBe(
      "Create a meal plan first to add recurring entries."
    );
    expect(messages.en["meals.plan.recurringEntryTitle"]).toBe("Add Recurring Entry");
    expect(messages.en["meals.plan.recurringEntryAction"]).toBe("Add Recurring Entry");
    expect(messages.en["meals.plan.weekday.mon"]).toBe("Mon");
    expect(messages.en["meals.plan.weekday.tue"]).toBe("Tue");
    expect(messages.en["meals.plan.weekday.wed"]).toBe("Wed");
    expect(messages.en["meals.plan.weekday.thu"]).toBe("Thu");
    expect(messages.en["meals.plan.weekday.fri"]).toBe("Fri");
    expect(messages.en["meals.plan.weekday.sat"]).toBe("Sat");
    expect(messages.en["meals.plan.weekday.sun"]).toBe("Sun");
    expect(messages.en["meals.week.title"]).toBe("Week Menu");
    expect(messages.en["meals.week.dateLabel"]).toBe("Week of");
    expect(messages.en["meals.week.loading"]).toBe("Loading…");
    expect(messages.en["meals.week.error"]).toBe("Failed to load the week menu.");
    expect(messages.en["meals.week.empty"]).toBe("No entries for this week.");
    expect(messages.en["meals.board.title"]).toBe("Today's Menu");
    expect(messages.en["meals.board.loading"]).toBe("Loading…");
    expect(messages.en["meals.board.error"]).toBe("Failed to load today's menu.");
    expect(messages.en["meals.board.emptySlot"]).toBe("Nothing planned.");

    expect(messages.es["admin.nav.mealsManagement"]).toBe("Gestión de Comidas");
    expect(messages.es["meals.management.title"]).toBe("Gestión de Comidas");
    expect(messages.es["meals.management.description"]).toBe(
      "Gestiona recetas, crea entradas puntuales y visualiza el menú diario derivado."
    );
    expect(messages.es["meals.management.loading"]).toBe("Cargando…");
    expect(messages.es["meals.management.error"]).toBe("Error al cargar los datos de comidas.");
    expect(messages.es["meals.recipes.title"]).toBe("Recetas");
    expect(messages.es["meals.recipes.searchPlaceholder"]).toBe("Buscar recetas…");
    expect(messages.es["meals.recipes.noRecipes"]).toBe("No se encontraron recetas.");
    expect(messages.es["meals.recipes.createTitle"]).toBe("Crear Receta");
    expect(messages.es["meals.recipes.namePlaceholder"]).toBe("Nombre de la receta");
    expect(messages.es["meals.recipes.ingredientsLabel"]).toBe("Ingredientes (uno por línea)");
    expect(messages.es["meals.recipes.instructionsLabel"]).toBe("Instrucciones");
    expect(messages.es["meals.recipes.slotsLabel"]).toBe("Franjas");
    expect(messages.es["meals.recipes.slotsHint"]).toBe(
      "Deja todo sin marcar para permitir esta receta en cualquier franja."
    );
    expect(messages.es["meals.recipes.deleteConfirmSimple"]).toBe("¿Eliminar esta receta?");
    expect(messages.es["meals.recipes.deleteConfirmPrefix"]).toBe(
      "Esta receta está referenciada por"
    );
    expect(messages.es["meals.recipes.deleteConfirmRecurringLabel"]).toBe("entradas recurrentes");
    expect(messages.es["meals.recipes.deleteConfirmOneOffLabel"]).toBe("entradas puntuales");
    expect(messages.es["meals.recipes.deleteConfirmSuffix"]).toBe(
      "Al eliminarla también se eliminarán estas entradas. ¿Continuar?"
    );
    expect(messages.es["meals.slot.breakfast"]).toBe("Desayuno");
    expect(messages.es["meals.slot.lunch"]).toBe("Comida");
    expect(messages.es["meals.slot.snack"]).toBe("Merienda");
    expect(messages.es["meals.slot.dinner"]).toBe("Cena");
    expect(messages.es["meals.action.create"]).toBe("Crear");
    expect(messages.es["meals.action.edit"]).toBe("Editar");
    expect(messages.es["meals.action.save"]).toBe("Guardar");
    expect(messages.es["meals.action.cancel"]).toBe("Cancelar");
    expect(messages.es["meals.action.delete"]).toBe("Eliminar");
    expect(messages.es["meals.entries.title"]).toBe("Añadir Entrada Puntual");
    expect(messages.es["meals.entries.dateLabel"]).toBe("Fecha");
    expect(messages.es["meals.entries.slotLabel"]).toBe("Franja");
    expect(messages.es["meals.entries.contentModeRecipe"]).toBe("Receta");
    expect(messages.es["meals.entries.contentModeNote"]).toBe("Nota");
    expect(messages.es["meals.entries.recipeSelectPlaceholder"]).toBe("Seleccionar una receta…");
    expect(messages.es["meals.entries.notePlaceholder"]).toBe("Nota de la entrada");
    expect(messages.es["meals.entries.noRecipesForSlot"]).toBe(
      "No hay recetas disponibles para esta franja."
    );
    expect(messages.es["meals.entries.action.add"]).toBe("Añadir Entrada");
    expect(messages.es["meals.entries.error"]).toBe("Error al añadir la entrada.");
    expect(messages.es["meals.menu.title"]).toBe("Menú del Día");
    expect(messages.es["meals.menu.dateLabel"]).toBe("Fecha");
    expect(messages.es["meals.menu.slotFilterLabel"]).toBe("Franja");
    expect(messages.es["meals.menu.slotFilterAll"]).toBe("Todas las franjas");
    expect(messages.es["meals.menu.loading"]).toBe("Cargando…");
    expect(messages.es["meals.menu.error"]).toBe("Error al cargar el menú.");
    expect(messages.es["meals.menu.empty"]).toBe("No hay entradas para este día.");
    expect(messages.es["meals.menu.tombstoneLabel"]).toBe("Receta eliminada");
    expect(messages.es["meals.plan.title"]).toBe("Planes de Comidas");
    expect(messages.es["meals.plan.createTitle"]).toBe("Crear Plan de Comidas");
    expect(messages.es["meals.plan.namePlaceholder"]).toBe("Nombre del plan");
    expect(messages.es["meals.plan.loading"]).toBe("Cargando…");
    expect(messages.es["meals.plan.noPlans"]).toBe("No se encontraron planes de comidas.");
    expect(messages.es["meals.plan.error"]).toBe("Error al cargar los planes de comidas.");
    expect(messages.es["meals.plan.statusActive"]).toBe("Activo");
    expect(messages.es["meals.plan.statusInactive"]).toBe("Inactivo");
    expect(messages.es["meals.plan.action.activate"]).toBe("Activar");
    expect(messages.es["meals.plan.action.deactivate"]).toBe("Desactivar");
    expect(messages.es["meals.plan.hideEntries"]).toBe("Ocultar Entradas");
    expect(messages.es["meals.plan.showEntries"]).toBe("Mostrar Entradas");
    expect(messages.es["meals.plan.entriesEmpty"]).toBe("No hay entradas en este plan.");
    expect(messages.es["meals.plan.entriesError"]).toBe(
      "Error al actualizar las entradas del plan."
    );
    expect(messages.es["meals.plan.entryDeleteConfirm"]).toBe("¿Eliminar esta entrada?");
    expect(messages.es["meals.plan.selectLabel"]).toBe("Plan de Comidas");
    expect(messages.es["meals.plan.selectPlaceholder"]).toBe("Seleccionar un plan de comidas…");
    expect(messages.es["meals.plan.weekdayLabel"]).toBe("Día de la semana");
    expect(messages.es["meals.plan.noPlansForRecurring"]).toBe(
      "Crea un plan de comidas primero para añadir entradas recurrentes."
    );
    expect(messages.es["meals.plan.recurringEntryTitle"]).toBe("Añadir Entrada Recurrente");
    expect(messages.es["meals.plan.recurringEntryAction"]).toBe("Añadir Entrada Recurrente");
    expect(messages.es["meals.plan.weekday.mon"]).toBe("Lun");
    expect(messages.es["meals.plan.weekday.tue"]).toBe("Mar");
    expect(messages.es["meals.plan.weekday.wed"]).toBe("Mié");
    expect(messages.es["meals.plan.weekday.thu"]).toBe("Jue");
    expect(messages.es["meals.plan.weekday.fri"]).toBe("Vie");
    expect(messages.es["meals.plan.weekday.sat"]).toBe("Sáb");
    expect(messages.es["meals.plan.weekday.sun"]).toBe("Dom");
    expect(messages.es["meals.week.title"]).toBe("Menú Semanal");
    expect(messages.es["meals.week.dateLabel"]).toBe("Semana de");
    expect(messages.es["meals.week.loading"]).toBe("Cargando…");
    expect(messages.es["meals.week.error"]).toBe("Error al cargar el menú semanal.");
    expect(messages.es["meals.week.empty"]).toBe("No hay entradas para esta semana.");
    expect(messages.es["meals.board.title"]).toBe("Menú de Hoy");
    expect(messages.es["meals.board.loading"]).toBe("Cargando…");
    expect(messages.es["meals.board.error"]).toBe("Error al cargar el menú de hoy.");
    expect(messages.es["meals.board.emptySlot"]).toBe("Nada planeado.");
  });
});
