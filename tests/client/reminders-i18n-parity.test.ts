import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

/** — reminders i18n parity (closes).
 * Locks the en/es catalog parity for the reminders admin surface: every
 * `reminders.*` key plus `admin.nav.remindersManagement` must exist in BOTH
 * locales and resolve to a non-empty string. Developer/diagnostic text (e.g.
 * the server's console.error strings) is not part of this catalog and stays
 * English by design — this test only covers user-facing i18n keys.
 */
describe("reminders-i18n-parity", () => {
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

  it("reminders.*/admin.nav.remindersManagement keys have identical coverage in en and es (both directions)", () => {
    const isRemindersKey = (key: string) =>
      key.startsWith("reminders.") || key === "admin.nav.remindersManagement";

    const enKeys = Object.keys(messages.en).filter(isRemindersKey);
    const esKeys = Object.keys(messages.es).filter(isRemindersKey);

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

  it("reminders.*/admin.nav.remindersManagement keys resolve to a non-empty string in both languages", () => {
    const isRemindersKey = (key: string) =>
      key.startsWith("reminders.") || key === "admin.nav.remindersManagement";

    const enKeys = Object.keys(messages.en).filter(isRemindersKey);

    for (const key of enKeys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  it("reminders.*/admin.nav.remindersManagement keys resolve to the expected strings in both languages", () => {
    expect(messages.en["admin.nav.remindersManagement"]).toBe("Reminders Management");
    expect(messages.en["reminders.management.title"]).toBe("Reminders Management");
    expect(messages.en["reminders.management.description"]).toBe(
      "Author scheduled reminders — apply to all members on shared weekdays, or target specific members on their own weekdays via the assignment matrix."
    );
    expect(messages.en["reminders.management.loading"]).toBe("Loading…");
    expect(messages.en["reminders.management.error"]).toBe("Failed to load reminders.");
    expect(messages.en["reminders.management.createTitle"]).toBe("Create Reminder");
    expect(messages.en["reminders.management.textPlaceholder"]).toBe("Reminder text");
    expect(messages.en["reminders.management.list"]).toBe("Reminders");
    expect(messages.en["reminders.management.noReminders"]).toBe("No reminders found.");
    expect(messages.en["reminders.management.targetingApplyToAll"]).toBe("All members");
    expect(messages.en["reminders.management.targetingSpecific"]).toBe("Specific members");
    expect(messages.en["reminders.action.create"]).toBe("Create Reminder");
    expect(messages.en["reminders.action.edit"]).toBe("Edit");
    expect(messages.en["reminders.action.save"]).toBe("Save");
    expect(messages.en["reminders.action.cancel"]).toBe("Cancel");
    expect(messages.en["reminders.action.delete"]).toBe("Delete");
    expect(messages.en["reminders.action.deleteConfirm"]).toBe("Delete this reminder?");
    expect(messages.en["reminders.action.activate"]).toBe("Activate");
    expect(messages.en["reminders.action.deactivate"]).toBe("Deactivate");
    expect(messages.en["reminders.status.active"]).toBe("Active");
    expect(messages.en["reminders.status.inactive"]).toBe("Inactive");
    expect(messages.en["reminders.weekday.mon"]).toBe("Mon");
    expect(messages.en["reminders.weekday.tue"]).toBe("Tue");
    expect(messages.en["reminders.weekday.wed"]).toBe("Wed");
    expect(messages.en["reminders.weekday.thu"]).toBe("Thu");
    expect(messages.en["reminders.weekday.fri"]).toBe("Fri");
    expect(messages.en["reminders.weekday.sat"]).toBe("Sat");
    expect(messages.en["reminders.weekday.sun"]).toBe("Sun");
    expect(messages.en["reminders.matrix.title"]).toBe("Assignment matrix");
    expect(messages.en["reminders.matrix.toggleShow"]).toBe("Assignments");
    expect(messages.en["reminders.matrix.close"]).toBe("Close");
    expect(messages.en["reminders.matrix.member"]).toBe("Member");
    expect(messages.en["reminders.matrix.noActiveMembers"]).toBe("No active members.");
    expect(messages.en["reminders.matrix.save"]).toBe("Save Assignments");
    expect(messages.en["reminders.matrix.error"]).toBe("Failed to save assignments.");
    expect(messages.en["reminders.matrix.emptySetError"]).toBe(
      "Select at least one weekday for at least one member."
    );
    expect(messages.en["reminders.matrix.weekdaysRequiredError"]).toBe(
      "Select at least one weekday."
    );

    expect(messages.es["admin.nav.remindersManagement"]).toBe("Gestión de Recordatorios");
    expect(messages.es["reminders.management.title"]).toBe("Gestión de Recordatorios");
    expect(messages.es["reminders.management.description"]).toBe(
      "Crea recordatorios programados — aplica a todos los miembros en días compartidos, o dirige a miembros específicos en sus propios días mediante la matriz de asignación."
    );
    expect(messages.es["reminders.management.loading"]).toBe("Cargando…");
    expect(messages.es["reminders.management.error"]).toBe("Error al cargar recordatorios.");
    expect(messages.es["reminders.management.createTitle"]).toBe("Crear Recordatorio");
    expect(messages.es["reminders.management.textPlaceholder"]).toBe("Texto del recordatorio");
    expect(messages.es["reminders.management.list"]).toBe("Recordatorios");
    expect(messages.es["reminders.management.noReminders"]).toBe(
      "No se encontraron recordatorios."
    );
    expect(messages.es["reminders.management.targetingApplyToAll"]).toBe("Todos los miembros");
    expect(messages.es["reminders.management.targetingSpecific"]).toBe("Miembros específicos");
    expect(messages.es["reminders.action.create"]).toBe("Crear Recordatorio");
    expect(messages.es["reminders.action.edit"]).toBe("Editar");
    expect(messages.es["reminders.action.save"]).toBe("Guardar");
    expect(messages.es["reminders.action.cancel"]).toBe("Cancelar");
    expect(messages.es["reminders.action.delete"]).toBe("Eliminar");
    expect(messages.es["reminders.action.deleteConfirm"]).toBe("¿Eliminar este recordatorio?");
    expect(messages.es["reminders.action.activate"]).toBe("Activar");
    expect(messages.es["reminders.action.deactivate"]).toBe("Desactivar");
    expect(messages.es["reminders.status.active"]).toBe("Activo");
    expect(messages.es["reminders.status.inactive"]).toBe("Inactivo");
    expect(messages.es["reminders.weekday.mon"]).toBe("Lun");
    expect(messages.es["reminders.weekday.tue"]).toBe("Mar");
    expect(messages.es["reminders.weekday.wed"]).toBe("Mié");
    expect(messages.es["reminders.weekday.thu"]).toBe("Jue");
    expect(messages.es["reminders.weekday.fri"]).toBe("Vie");
    expect(messages.es["reminders.weekday.sat"]).toBe("Sáb");
    expect(messages.es["reminders.weekday.sun"]).toBe("Dom");
    expect(messages.es["reminders.matrix.title"]).toBe("Matriz de asignación");
    expect(messages.es["reminders.matrix.toggleShow"]).toBe("Asignaciones");
    expect(messages.es["reminders.matrix.close"]).toBe("Cerrar");
    expect(messages.es["reminders.matrix.member"]).toBe("Miembro");
    expect(messages.es["reminders.matrix.noActiveMembers"]).toBe("No hay miembros activos.");
    expect(messages.es["reminders.matrix.save"]).toBe("Guardar Asignaciones");
    expect(messages.es["reminders.matrix.error"]).toBe("Error al guardar las asignaciones.");
    expect(messages.es["reminders.matrix.emptySetError"]).toBe(
      "Selecciona al menos un día de la semana para al menos un miembro."
    );
    expect(messages.es["reminders.matrix.weekdaysRequiredError"]).toBe(
      "Selecciona al menos un día de la semana."
    );
  });
});
