import { describe, expect, it } from "vitest";
import { messages } from "@/i18n/messages";

/** — daily messages i18n parity (closes).
 * Locks the en/es catalog parity for the daily-messages admin surface: every
 * `dailyMessages.*` key plus `admin.nav.dailyMessagesManagement` must exist
 * in BOTH locales and resolve to a non-empty string. Developer/diagnostic
 * text (e.g. the server's console.error strings) is not part of this
 * catalog and stays English by design — this test only covers user-facing
 * i18n keys.
 */
describe("daily-messages-i18n-parity", () => {
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

  it("dailyMessages.*/admin.nav.dailyMessagesManagement keys have identical coverage in en and es (both directions)", () => {
    const isDailyMessagesKey = (key: string) =>
      key.startsWith("dailyMessages.") || key === "admin.nav.dailyMessagesManagement";

    const enKeys = Object.keys(messages.en).filter(isDailyMessagesKey);
    const esKeys = Object.keys(messages.es).filter(isDailyMessagesKey);

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

  it("dailyMessages.*/admin.nav.dailyMessagesManagement keys resolve to a non-empty string in both languages", () => {
    const isDailyMessagesKey = (key: string) =>
      key.startsWith("dailyMessages.") || key === "admin.nav.dailyMessagesManagement";

    const enKeys = Object.keys(messages.en).filter(isDailyMessagesKey);

    for (const key of enKeys) {
      const enValue = messages.en[key as keyof typeof messages.en];
      const esValue = messages.es[key as keyof typeof messages.es];

      expect(typeof enValue).toBe("string");
      expect(typeof esValue).toBe("string");
      expect((enValue as string).length).toBeGreaterThan(0);
      expect((esValue as string).length).toBeGreaterThan(0);
    }
  });

  it("dailyMessages.*/admin.nav.dailyMessagesManagement keys resolve to the expected strings in both languages", () => {
    expect(messages.en["admin.nav.dailyMessagesManagement"]).toBe("Daily Messages Management");
    expect(messages.en["dailyMessages.management.title"]).toBe("Daily Messages Management");
    expect(messages.en["dailyMessages.management.description"]).toBe(
      "Author, replace, and remove per-member daily messages over a date window."
    );
    expect(messages.en["dailyMessages.management.loading"]).toBe("Loading…");
    expect(messages.en["dailyMessages.management.error"]).toBe("Failed to load daily messages.");
    expect(messages.en["dailyMessages.management.saveError"]).toBe("Failed to save the message.");
    expect(messages.en["dailyMessages.management.noActiveMembers"]).toBe("No active members.");
    expect(messages.en["dailyMessages.management.selectMember"]).toBe("Member");
    expect(messages.en["dailyMessages.management.previousWindow"]).toBe("Previous 14 days");
    expect(messages.en["dailyMessages.management.nextWindow"]).toBe("Next 14 days");
    expect(messages.en["dailyMessages.management.windowFrom"]).toBe("From");
    expect(messages.en["dailyMessages.management.windowDays"]).toBe("Days");
    expect(messages.en["dailyMessages.management.refresh"]).toBe("Refresh");
    expect(messages.en["dailyMessages.management.createTitle"]).toBe("Create / Replace Message");
    expect(messages.en["dailyMessages.management.dateLabel"]).toBe("Date");
    expect(messages.en["dailyMessages.management.textPlaceholder"]).toBe("Message text");
    expect(messages.en["dailyMessages.management.saving"]).toBe("Saving…");
    expect(messages.en["dailyMessages.management.list"]).toBe("Messages");
    expect(messages.en["dailyMessages.management.noMessages"]).toBe(
      "No messages found for this window."
    );
    expect(messages.en["dailyMessages.action.save"]).toBe("Save");
    expect(messages.en["dailyMessages.action.edit"]).toBe("Edit");
    expect(messages.en["dailyMessages.action.cancel"]).toBe("Cancel");
    expect(messages.en["dailyMessages.action.delete"]).toBe("Delete");
    expect(messages.en["dailyMessages.action.deleteConfirm"]).toBe("Delete this message?");

    expect(messages.es["admin.nav.dailyMessagesManagement"]).toBe("Gestión de Mensajes Diarios");
    expect(messages.es["dailyMessages.management.title"]).toBe("Gestión de Mensajes Diarios");
    expect(messages.es["dailyMessages.management.description"]).toBe(
      "Crea, reemplaza y elimina mensajes diarios por miembro sobre una ventana de fechas."
    );
    expect(messages.es["dailyMessages.management.loading"]).toBe("Cargando…");
    expect(messages.es["dailyMessages.management.error"]).toBe(
      "Error al cargar los mensajes diarios."
    );
    expect(messages.es["dailyMessages.management.saveError"]).toBe("Error al guardar el mensaje.");
    expect(messages.es["dailyMessages.management.noActiveMembers"]).toBe(
      "No hay miembros activos."
    );
    expect(messages.es["dailyMessages.management.selectMember"]).toBe("Miembro");
    expect(messages.es["dailyMessages.management.previousWindow"]).toBe("14 días anteriores");
    expect(messages.es["dailyMessages.management.nextWindow"]).toBe("14 días siguientes");
    expect(messages.es["dailyMessages.management.windowFrom"]).toBe("Desde");
    expect(messages.es["dailyMessages.management.windowDays"]).toBe("Días");
    expect(messages.es["dailyMessages.management.refresh"]).toBe("Actualizar");
    expect(messages.es["dailyMessages.management.createTitle"]).toBe("Crear / Reemplazar Mensaje");
    expect(messages.es["dailyMessages.management.dateLabel"]).toBe("Fecha");
    expect(messages.es["dailyMessages.management.textPlaceholder"]).toBe("Texto del mensaje");
    expect(messages.es["dailyMessages.management.saving"]).toBe("Guardando…");
    expect(messages.es["dailyMessages.management.list"]).toBe("Mensajes");
    expect(messages.es["dailyMessages.management.noMessages"]).toBe(
      "No se encontraron mensajes para esta ventana."
    );
    expect(messages.es["dailyMessages.action.save"]).toBe("Guardar");
    expect(messages.es["dailyMessages.action.edit"]).toBe("Editar");
    expect(messages.es["dailyMessages.action.cancel"]).toBe("Cancelar");
    expect(messages.es["dailyMessages.action.delete"]).toBe("Eliminar");
    expect(messages.es["dailyMessages.action.deleteConfirm"]).toBe("¿Eliminar este mensaje?");
  });
});
