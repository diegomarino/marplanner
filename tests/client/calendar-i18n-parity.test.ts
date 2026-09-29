import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

describe("calendar-i18n-parity", () => {
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

  it("calendar.* label keys resolve in both languages", () => {
    expect(messages.en["calendar.title"]).toBe("Calendar");
    expect(messages.en["calendar.description"]).toBe(
      "View and manage household events — timed or all-day, recurring or one-off."
    );
    expect(messages.en["calendar.loading"]).toBe("Loading calendar…");
    expect(messages.en["calendar.error"]).toBe("Failed to load calendar events.");
    expect(messages.en["calendar.noEvents"]).toBe("No events for this period.");
    expect(messages.en["calendar.createTitle"]).toBe("Event title");
    expect(messages.en["calendar.placeholderTitle"]).toBe("Enter event title");
    expect(messages.en["calendar.startTime"]).toBe("Start time");
    expect(messages.en["calendar.endTime"]).toBe("End time");
    expect(messages.en["calendar.startDate"]).toBe("Start date");
    expect(messages.en["calendar.endDate"]).toBe("End date");
    expect(messages.en["calendar.allDay"]).toBe("All-day event");
    expect(messages.en["calendar.placeholderTime"]).toBe("--:--");
    expect(messages.en["calendar.createEvent"]).toBe("Create Event");
    expect(messages.en["calendar.cancel"]).toBe("Cancel");
    expect(messages.en["calendar.creating"]).toBe("Creating…");
    expect(messages.en["calendar.edit"]).toBe("Edit");
    expect(messages.en["calendar.delete"]).toBe("Delete");
    expect(messages.en["calendar.editTitle"]).toBe("Event title");
    expect(messages.en["calendar.deleteConfirm"]).toBe("Delete this event?");
    expect(messages.en["calendar.editError"]).toBe("Failed to save changes.");
    expect(messages.en["calendar.deleteError"]).toBe("Failed to delete event.");
    expect(messages.en["calendar.deleting"]).toBe("Deleting…");
    expect(messages.en["calendar.assignTo"]).toBe("Assign to member");
    expect(messages.en["calendar.editAssignment"]).toBe("Edit assignment");
    expect(messages.en["calendar.noAssignments"]).toBe("Unassigned");
    expect(messages.en["calendar.selectMember"]).toBe("Select member…");
    expect(messages.en["calendar.save"]).toBe("Save");
    expect(messages.en["calendar.updating"]).toBe("Updating…");
    expect(messages.en["calendar.loadingMembers"]).toBe("Loading members…");
    expect(messages.en["calendar.deleteNoLongerAvailable"]).toBe("Event no longer available.");
    expect(messages.en["calendar.assignmentError"]).toBe("Failed to update assignment.");
    expect(messages.en["calendar.errorLoadingMembers"]).toBe("Failed to load members.");
    expect(messages.en["calendar.month"]).toBe("Month");
    expect(messages.en["calendar.week"]).toBe("Week");
    expect(messages.en["calendar.allDayFilter"]).toBe("All-day events");

    expect(messages.es["calendar.title"]).toBe("Calendario");
    expect(messages.es["calendar.description"]).toBe(
      "Ver y gestionar eventos del hogar — programados o de día completo, repetitivos o únicos."
    );
    expect(messages.es["calendar.loading"]).toBe("Cargando calendario…");
    expect(messages.es["calendar.error"]).toBe("Error al cargar eventos del calendario.");
    expect(messages.es["calendar.noEvents"]).toBe("No hay eventos para este período.");
    expect(messages.es["calendar.createTitle"]).toBe("Título del evento");
    expect(messages.es["calendar.placeholderTitle"]).toBe("Ingresar título del evento");
    expect(messages.es["calendar.startTime"]).toBe("Hora de inicio");
    expect(messages.es["calendar.endTime"]).toBe("Hora de finalización");
    expect(messages.es["calendar.startDate"]).toBe("Fecha de inicio");
    expect(messages.es["calendar.endDate"]).toBe("Fecha de finalización");
    expect(messages.es["calendar.allDay"]).toBe("Evento de día completo");
    expect(messages.es["calendar.placeholderTime"]).toBe("--:--");
    expect(messages.es["calendar.createEvent"]).toBe("Crear Evento");
    expect(messages.es["calendar.cancel"]).toBe("Cancelar");
    expect(messages.es["calendar.creating"]).toBe("Creando…");
    expect(messages.es["calendar.edit"]).toBe("Editar");
    expect(messages.es["calendar.delete"]).toBe("Eliminar");
    expect(messages.es["calendar.editTitle"]).toBe("Título del evento");
    expect(messages.es["calendar.deleteConfirm"]).toBe("¿Eliminar este evento?");
    expect(messages.es["calendar.editError"]).toBe("Error al guardar los cambios.");
    expect(messages.es["calendar.deleteError"]).toBe("Error al eliminar el evento.");
    expect(messages.es["calendar.deleting"]).toBe("Eliminando…");
    expect(messages.es["calendar.assignTo"]).toBe("Asignar a miembro");
    expect(messages.es["calendar.editAssignment"]).toBe("Editar asignación");
    expect(messages.es["calendar.noAssignments"]).toBe("Sin asignar");
    expect(messages.es["calendar.selectMember"]).toBe("Seleccionar miembro…");
    expect(messages.es["calendar.save"]).toBe("Guardar");
    expect(messages.es["calendar.updating"]).toBe("Actualizando…");
    expect(messages.es["calendar.loadingMembers"]).toBe("Cargando miembros…");
    expect(messages.es["calendar.deleteNoLongerAvailable"]).toBe("Evento ya no disponible.");
    expect(messages.es["calendar.assignmentError"]).toBe("Error al actualizar asignación.");
    expect(messages.es["calendar.errorLoadingMembers"]).toBe("Error al cargar miembros.");
    expect(messages.es["calendar.month"]).toBe("Mes");
    expect(messages.es["calendar.week"]).toBe("Semana");
    expect(messages.es["calendar.allDayFilter"]).toBe("Eventos de día completo");
  });

  it("Admin Calendar source labels, phases, and safe errors have English and Spanish entries", () => {
    const keys = [
      "admin.nav.calendar",
      "calendar.admin.title",
      "calendar.admin.externalCalendars",
      "calendar.admin.emojiHighlights",
      "calendar.admin.sourceName",
      "calendar.admin.feedUrl",
      "calendar.admin.provider",
      "calendar.admin.providerGeneric",
      "calendar.admin.providerGoogle",
      "calendar.admin.providerMicrosoft",
      "calendar.admin.providerApple",
      "calendar.admin.addSource",
      "calendar.admin.enabled",
      "calendar.admin.syncNow",
      "calendar.admin.deleteSource",
      "calendar.admin.phase.requesting",
      "calendar.admin.phase.downloading",
      "calendar.admin.phase.parsing",
      "calendar.admin.phase.reconciling",
      "calendar.admin.phase.succeeded",
      "calendar.admin.phase.failed",
      "calendar.admin.error.timeout",
      "calendar.admin.error.unavailable",
    ] as const;
    for (const key of keys) {
      expect(messages.en[key]).toBeTruthy();
      expect(messages.es[key]).toBeTruthy();
      if (!key.startsWith("calendar.admin.provider") || key === "calendar.admin.providerGeneric") {
        expect(messages.en[key]).not.toBe(messages.es[key]);
      }
    }
  });

  it("highlight authoring, drag, confirmation, and failure text has bilingual parity", () => {
    const keys = [
      "emoji",
      "keywords",
      "addRule",
      "loadingRules",
      "loadRulesError",
      "ruleActionError",
      "reorderError",
      "dragRule",
      "dragInstructions",
      "dragStarted",
      "dragOver",
      "dragEnded",
      "dragCancelled",
      "movedRule",
      "deleteRule",
      "deleteRuleConfirm",
      "deleteRuleDescription",
    ] as const;
    for (const key of keys) {
      const messageKey = `calendar.admin.${key}` as const;
      expect(messages.en[messageKey]).toBeTruthy();
      expect(messages.es[messageKey]).toBeTruthy();
      if (key !== "emoji") expect(messages.en[messageKey]).not.toBe(messages.es[messageKey]);
    }
  });
});
