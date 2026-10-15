import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { messages } from "@/i18n/messages";
import { ChoresBoard } from "@/chores/ChoresBoard";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import type { BoardColumn } from "../../src/shared";

describe("routines-i18n-parity", () => {
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

  it("routines.*/chores.* keys have identical coverage in en and es (both directions)", () => {
    const isRoutinesOrChoresKey = (key: string) =>
      key.startsWith("routines.") || key.startsWith("chores.");

    const enKeys = Object.keys(messages.en).filter(isRoutinesOrChoresKey);
    const esKeys = Object.keys(messages.es).filter(isRoutinesOrChoresKey);

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

  it("routines.*/chores.* keys resolve to the expected strings in both languages", () => {
    expect(messages.en["routines.management.title"]).toBe("Routines & Chores");
    expect(messages.en["routines.management.description"]).toBe(
      "Configure routines, chores, and weekday assignments."
    );
    expect(messages.en["routines.management.loading"]).toBe("Loading…");
    expect(messages.en["routines.management.error"]).toBe("Failed to load data.");
    expect(messages.en["routines.management.createTitle"]).toBe("Create Routine");
    expect(messages.en["routines.management.createNamePlaceholder"]).toBe("Routine name");
    expect(messages.en["routines.management.selectDayPeriod"]).toBe("Select day period");
    expect(messages.en["routines.action.create"]).toBe("Create Routine");
    expect(messages.en["routines.management.membersWithAssignments"]).toBe(
      "Members with assignments"
    );
    expect(messages.en["routines.assignments.noAssignment"]).toBe("No assignment");
    expect(messages.en["routines.management.routines"]).toBe("Routines");
    expect(messages.en["routines.management.noRoutines"]).toBe("No routines found.");
    expect(messages.en["routines.action.save"]).toBe("Save");
    expect(messages.en["routines.action.cancel"]).toBe("Cancel");
    expect(messages.en["routines.action.edit"]).toBe("Edit");
    expect(messages.en["routines.action.delete"]).toBe("Delete");
    expect(messages.en["routines.action.deleteConfirm"]).toBe("Delete this routine?");
    expect(messages.en["routines.action.streakWarning"]).toBe("This will change the live streak.");
    expect(messages.en["routines.action.viewChores"]).toBe("View Chores");
    expect(messages.en["routines.action.close"]).toBe("Close");
    expect(messages.en["routines.chores.title"]).toBe("Chores");
    expect(messages.en["routines.chores.placeholder"]).toBe("Chore name");
    expect(messages.en["routines.action.createChore"]).toBe("Add Chore");
    expect(messages.en["routines.chores.error"]).toBe("Failed to load chores.");
    expect(messages.en["routines.chores.deleteConfirm"]).toBe("Delete this chore?");
    expect(messages.en["routines.assignments.createForRoutine"]).toBe("Assign routine to member");
    expect(messages.en["routines.assignments.selectMember"]).toBe("Select member…");
    expect(messages.en["routines.assignments.save"]).toBe("Save Assignment");
    expect(messages.en["routines.assignments.deactivateConfirm"]).toBe(
      "Deactivate this assignment?"
    );
    expect(messages.en["routines.assignments.error"]).toBe("Failed to update assignment.");
    expect(messages.en["routines.assignments.deactivate"]).toBe("Deactivate");
    expect(messages.en["routines.assignments.weekday.mon"]).toBe("Mon");
    expect(messages.en["routines.assignments.weekday.tue"]).toBe("Tue");
    expect(messages.en["routines.assignments.weekday.wed"]).toBe("Wed");
    expect(messages.en["routines.assignments.weekday.thu"]).toBe("Thu");
    expect(messages.en["routines.assignments.weekday.fri"]).toBe("Fri");
    expect(messages.en["routines.assignments.weekday.sat"]).toBe("Sat");
    expect(messages.en["routines.assignments.weekday.sun"]).toBe("Sun");
    expect(messages.en["routines.chores.reorder"]).toBe("Reorder");
    expect(messages.en["routines.chores.saveOrder"]).toBe("Save Order");
    expect(messages.en["routines.chores.moveUp"]).toBe("Move up");
    expect(messages.en["routines.chores.moveDown"]).toBe("Move down");
    expect(messages.en["routines.chores.reorderError"]).toBe(
      "Failed to save the new order. Please try again."
    );
    expect(messages.en["chores.board.title"]).toBe("Daily Chores Board");
    expect(messages.en["chores.board.loading"]).toBe("Loading…");
    expect(messages.en["chores.board.error"]).toBe("Failed to load the board.");
    expect(messages.en["chores.board.noChildren"]).toBe(
      "No active children yet. Add a child in Members Management."
    );
    expect(messages.en["chores.board.streakLabel"]).toBe("Streak:");
    expect(messages.en["chores.board.progressLabel"]).toBe("Progress:");
    expect(messages.en["chores.board.toggleError"]).toBe(
      "Could not update the chore. Please try again."
    );

    expect(messages.es["routines.management.title"]).toBe("Rutinas y tareas");
    expect(messages.es["routines.management.description"]).toBe(
      "Configurar rutinas, tareas y asignaciones de días."
    );
    expect(messages.es["routines.management.loading"]).toBe("Cargando…");
    expect(messages.es["routines.management.error"]).toBe("Error al cargar datos.");
    expect(messages.es["routines.management.createTitle"]).toBe("Crear Rutina");
    expect(messages.es["routines.management.createNamePlaceholder"]).toBe("Nombre de rutina");
    expect(messages.es["routines.management.selectDayPeriod"]).toBe("Seleccionar período diario");
    expect(messages.es["routines.action.create"]).toBe("Crear Rutina");
    expect(messages.es["routines.management.membersWithAssignments"]).toBe(
      "Miembros con asignaciones"
    );
    expect(messages.es["routines.assignments.noAssignment"]).toBe("Sin asignación");
    expect(messages.es["routines.management.routines"]).toBe("Rutinas");
    expect(messages.es["routines.management.noRoutines"]).toBe("No se encontraron rutinas.");
    expect(messages.es["routines.action.save"]).toBe("Guardar");
    expect(messages.es["routines.action.cancel"]).toBe("Cancelar");
    expect(messages.es["routines.action.edit"]).toBe("Editar");
    expect(messages.es["routines.action.delete"]).toBe("Eliminar");
    expect(messages.es["routines.action.deleteConfirm"]).toBe("¿Eliminar esta rutina?");
    expect(messages.es["routines.action.streakWarning"]).toBe("Esto cambiará la racha en vivo.");
    expect(messages.es["routines.action.viewChores"]).toBe("Ver Tareas");
    expect(messages.es["routines.action.close"]).toBe("Cerrar");
    expect(messages.es["routines.chores.title"]).toBe("Tareas");
    expect(messages.es["routines.chores.placeholder"]).toBe("Nombre de tarea");
    expect(messages.es["routines.action.createChore"]).toBe("Añadir Tarea");
    expect(messages.es["routines.chores.error"]).toBe("Error al cargar tareas.");
    expect(messages.es["routines.chores.deleteConfirm"]).toBe("¿Eliminar esta tarea?");
    expect(messages.es["routines.assignments.createForRoutine"]).toBe("Asignar rutina a miembro");
    expect(messages.es["routines.assignments.selectMember"]).toBe("Seleccionar miembro…");
    expect(messages.es["routines.assignments.save"]).toBe("Guardar Asignación");
    expect(messages.es["routines.assignments.deactivateConfirm"]).toBe(
      "¿Desactivar esta asignación?"
    );
    expect(messages.es["routines.assignments.error"]).toBe("Error al actualizar asignación.");
    expect(messages.es["routines.assignments.deactivate"]).toBe("Desactivar");
    expect(messages.es["routines.assignments.weekday.mon"]).toBe("Lun");
    expect(messages.es["routines.assignments.weekday.tue"]).toBe("Mar");
    expect(messages.es["routines.assignments.weekday.wed"]).toBe("Mié");
    expect(messages.es["routines.assignments.weekday.thu"]).toBe("Jue");
    expect(messages.es["routines.assignments.weekday.fri"]).toBe("Vie");
    expect(messages.es["routines.assignments.weekday.sat"]).toBe("Sáb");
    expect(messages.es["routines.assignments.weekday.sun"]).toBe("Dom");
    expect(messages.es["routines.chores.reorder"]).toBe("Reordenar");
    expect(messages.es["routines.chores.saveOrder"]).toBe("Guardar Orden");
    expect(messages.es["routines.chores.moveUp"]).toBe("Subir");
    expect(messages.es["routines.chores.moveDown"]).toBe("Bajar");
    expect(messages.es["routines.chores.reorderError"]).toBe(
      "No se pudo guardar el nuevo orden. Inténtalo de nuevo."
    );
    expect(messages.es["chores.board.title"]).toBe("Tablero de Tareas Diarias");
    expect(messages.es["chores.board.loading"]).toBe("Cargando…");
    expect(messages.es["chores.board.error"]).toBe("Error al cargar el tablero.");
    expect(messages.es["chores.board.noChildren"]).toBe(
      "No hay niños activos todavía. Añade uno en Gestión de Miembros."
    );
    expect(messages.es["chores.board.streakLabel"]).toBe("Racha:");
    expect(messages.es["chores.board.progressLabel"]).toBe("Progreso:");
    expect(messages.es["chores.board.toggleError"]).toBe(
      "No se pudo actualizar la tarea. Inténtalo de nuevo."
    );
    expect(messages.en["routines.admin.selectPrompt"]).toBe(
      "Select a routine to manage its chores"
    );
    expect(messages.es["routines.admin.selectPrompt"]).toBe(
      "Selecciona una rutina para gestionar sus tareas"
    );
    expect(messages.en["routines.management.title"]).toBe(messages.en["admin.sidebar.routines"]);
    expect(messages.es["routines.management.title"]).toBe(messages.es["admin.sidebar.routines"]);
  });
});

/** SC-005 client-layer render assertion (covered only the API level):
 * a column's streak badge / today-progress indicator must not render when the
 * board API reports `streak: null` / `todayProgress: null` for that column.
 * ChoresBoard's existing `column.streak !== null &&` / `column.todayProgress
 * !== null &&` guards already produce this behavior — this test locks it,
 * it is not a RED-first addition.
 */
describe("ChoresBoard — streak/progress suppression on null (SC-005)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("does not render the streak badge or progress indicator for a null column, but does for a populated one", async () => {
    const nullColumn: BoardColumn = {
      memberId: "m1",
      displayName: "Alice",
      dayPeriods: [],
      streak: null,
      todayProgress: null,
    };
    const populatedColumn: BoardColumn = {
      memberId: "m2",
      displayName: "Bob",
      dayPeriods: [],
      streak: 5,
      todayProgress: { completed: 2, total: 4 },
    };

    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.includes("/api/settings")) {
        return Promise.resolve(
          new Response(JSON.stringify({ locale: { timezone: "UTC" } }), { status: 200 })
        );
      }
      if (url.includes("/api/chores/board")) {
        return Promise.resolve(
          new Response(JSON.stringify([nullColumn, populatedColumn]), { status: 200 })
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);

    render(createElement(HouseholdSettingsProvider, null, createElement(ChoresBoard)));

    const nullColumnEl = await screen.findByTestId("chores-board-column-m1");
    const populatedColumnEl = screen.getByTestId("chores-board-column-m2");

    expect(nullColumnEl.textContent).not.toContain("Streak:");
    expect(nullColumnEl.textContent).not.toContain("Progress:");

    expect(populatedColumnEl.textContent).toContain("Streak: 5");
    expect(populatedColumnEl.textContent).toContain("Progress: 2/4");
  });
});
