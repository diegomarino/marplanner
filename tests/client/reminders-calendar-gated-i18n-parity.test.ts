import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

/** calendar-gated reminders — calendar_gated + dry-run i18n parity
 * * Locks the en/es catalog parity for the calendar_gated authoring fields and the
 * dry-run/explain view added in calendar-gated reminders: every
 * `reminders.calendarGated.*` and `reminders.dryRun.*` key (incl. the 3
 * mutually-exclusive dry-run reason labels and the wouldEmit/wouldNotEmit
 * verdict labels) must exist in BOTH locales and resolve to a non-empty string.
 * Developer/diagnostic text is not part of this catalog and stays English by
 * design — this test only covers user-facing i18n keys
 * (calendar-gated reminders FR-010).
 */
describe("reminders-calendar-gated-i18n-parity", () => {
  const isCalendarGatedOrDryRunKey = (key: string) =>
    key.startsWith("reminders.calendarGated.") || key.startsWith("reminders.dryRun.");

  it("reminders.calendarGated.*/reminders.dryRun.* keys have identical coverage in en and es (both directions)", () => {
    const enKeys = Object.keys(messages.en).filter(isCalendarGatedOrDryRunKey);
    const esKeys = Object.keys(messages.es).filter(isCalendarGatedOrDryRunKey);

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

  it("reminders.calendarGated.*/reminders.dryRun.* keys resolve to a non-empty string in both languages", () => {
    const enKeys = Object.keys(messages.en).filter(isCalendarGatedOrDryRunKey);

    for (const key of enKeys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  it("includes the 3 mutually-exclusive dry-run reason labels plus wouldEmit/wouldNotEmit in both languages", () => {
    const dryRunVerdictKeys = [
      "reminders.dryRun.wouldEmit",
      "reminders.dryRun.wouldNotEmit",
      "reminders.dryRun.reason.no_assigned_events",
      "reminders.dryRun.reason.matched_but_unassigned",
      "reminders.dryRun.reason.query_miss",
    ] as const;

    for (const key of dryRunVerdictKeys) {
      expect(messages.en[key].length).toBeGreaterThan(0);
      expect(messages.es[key].length).toBeGreaterThan(0);
    }
  });

  it("reminders.calendarGated.*/reminders.dryRun.* keys resolve to the expected strings in both languages", () => {
    expect(messages.en["reminders.calendarGated.queryLabel"]).toBe("Match text");
    expect(messages.en["reminders.calendarGated.queryPlaceholder"]).toBe(
      "Text to match in calendar events"
    );
    expect(messages.en["reminders.calendarGated.queryFieldsLabel"]).toBe("Match fields");
    expect(messages.en["reminders.calendarGated.queryField.title"]).toBe("Title");
    expect(messages.en["reminders.calendarGated.queryField.description"]).toBe("Description");
    expect(messages.en["reminders.calendarGated.queryField.location"]).toBe("Location");
    expect(messages.en["reminders.calendarGated.membershipTitle"]).toBe("Assigned members");
    expect(messages.en["reminders.calendarGated.noActiveMembers"]).toBe("No active members.");
    expect(messages.en["reminders.calendarGated.membersRequiredError"]).toBe(
      "Select at least one member."
    );
    expect(messages.en["reminders.dryRun.toggleShow"]).toBe("Dry-run");
    expect(messages.en["reminders.dryRun.close"]).toBe("Close");
    expect(messages.en["reminders.dryRun.title"]).toBe("Dry-run / explain");
    expect(messages.en["reminders.dryRun.memberLabel"]).toBe("Member");
    expect(messages.en["reminders.dryRun.selectMember"]).toBe("Select a member");
    expect(messages.en["reminders.dryRun.dateLabel"]).toBe("Date");
    expect(messages.en["reminders.dryRun.run"]).toBe("Run");
    expect(messages.en["reminders.dryRun.running"]).toBe("Running…");
    expect(messages.en["reminders.dryRun.error"]).toBe("Failed to run dry-run.");
    expect(messages.en["reminders.dryRun.wouldEmit"]).toBe("Would emit");
    expect(messages.en["reminders.dryRun.wouldNotEmit"]).toBe("Would not emit");
    expect(messages.en["reminders.dryRun.reason.no_assigned_events"]).toBe(
      "No events are assigned to this member on this date."
    );
    expect(messages.en["reminders.dryRun.reason.matched_but_unassigned"]).toBe(
      "A matching event exists on this date, but is not assigned to this member."
    );
    expect(messages.en["reminders.dryRun.reason.query_miss"]).toBe(
      "No event matched the query text on this date."
    );

    expect(messages.es["reminders.calendarGated.queryLabel"]).toBe("Texto a buscar");
    expect(messages.es["reminders.calendarGated.queryPlaceholder"]).toBe(
      "Texto a buscar en los eventos del calendario"
    );
    expect(messages.es["reminders.calendarGated.queryFieldsLabel"]).toBe("Campos a buscar");
    expect(messages.es["reminders.calendarGated.queryField.title"]).toBe("Título");
    expect(messages.es["reminders.calendarGated.queryField.description"]).toBe("Descripción");
    expect(messages.es["reminders.calendarGated.queryField.location"]).toBe("Ubicación");
    expect(messages.es["reminders.calendarGated.membershipTitle"]).toBe("Miembros asignados");
    expect(messages.es["reminders.calendarGated.noActiveMembers"]).toBe("No hay miembros activos.");
    expect(messages.es["reminders.calendarGated.membersRequiredError"]).toBe(
      "Selecciona al menos un miembro."
    );
    expect(messages.es["reminders.dryRun.toggleShow"]).toBe("Prueba");
    expect(messages.es["reminders.dryRun.close"]).toBe("Cerrar");
    expect(messages.es["reminders.dryRun.title"]).toBe("Prueba / explicación");
    expect(messages.es["reminders.dryRun.memberLabel"]).toBe("Miembro");
    expect(messages.es["reminders.dryRun.selectMember"]).toBe("Selecciona un miembro");
    expect(messages.es["reminders.dryRun.dateLabel"]).toBe("Fecha");
    expect(messages.es["reminders.dryRun.run"]).toBe("Ejecutar");
    expect(messages.es["reminders.dryRun.running"]).toBe("Ejecutando…");
    expect(messages.es["reminders.dryRun.error"]).toBe("Error al ejecutar la prueba.");
    expect(messages.es["reminders.dryRun.wouldEmit"]).toBe("Se emitiría");
    expect(messages.es["reminders.dryRun.wouldNotEmit"]).toBe("No se emitiría");
    expect(messages.es["reminders.dryRun.reason.no_assigned_events"]).toBe(
      "No hay eventos asignados a este miembro en esta fecha."
    );
    expect(messages.es["reminders.dryRun.reason.matched_but_unassigned"]).toBe(
      "Existe un evento coincidente en esta fecha, pero no está asignado a este miembro."
    );
    expect(messages.es["reminders.dryRun.reason.query_miss"]).toBe(
      "Ningún evento coincidió con el texto de búsqueda en esta fecha."
    );
  });
});
