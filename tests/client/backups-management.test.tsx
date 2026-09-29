import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupsManagement } from "@/admin/BackupsManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import type { BackupListResponse } from "../../src/shared";

type FetchCall = Parameters<typeof globalThis.fetch>;

const EMPTY_LIST: BackupListResponse = {
  backups: [],
  dbGeneration: 0,
  lastBackupError: null,
  lastPruneError: null,
};

const ONE_BACKUP_LIST: BackupListResponse = {
  backups: [
    {
      filename: "scheduled-20260901-033000-000.db",
      type: "scheduled",
      createdAt: 1,
      sizeBytes: 2048,
    },
  ],
  dbGeneration: 0,
  lastBackupError: null,
  lastPruneError: null,
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderManagement() {
  render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <BackupsManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

describe("BackupsManagement", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("loads the shelf and renders lastBackupError / lastPruneError surfaces", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") {
        return jsonResponse({
          ...ONE_BACKUP_LIST,
          lastBackupError: "disk full",
          lastPruneError: "permission denied",
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    expect(await screen.findByTestId("backups-table")).toBeInTheDocument();
    expect(screen.getByTestId("backups-row-scheduled-20260901-033000-000.db")).toBeInTheDocument();
    expect(screen.getByTestId("backups-last-backup-error")).toHaveTextContent("disk full");
    expect(screen.getByTestId("backups-last-prune-error")).toHaveTextContent("permission denied");
  });

  // review (P3-a): fences that `formatCreatedAt` actually reads the household timezone
  // FROM THE HOUSEHOLD-SETTINGS CONTEXT (retrofit), not the component's own
  // `Intl.DateTimeFormat.resolvedOptions.timeZone` browser-default fallback (which the
  // context effect overwrites once it resolves) — a distinctive, non-UTC/non-local zone
  // (Pacific/Kiritimati, UTC+14) makes a mutation that drops the context wire-up produce a
  // DIFFERENT rendered string, not one that happens to coincide with the fallback.
  it("formats a backup's createdAt in the HOUSEHOLD timezone from context, not the browser default", async () => {
    const HOUSEHOLD_TIMEZONE = "Pacific/Kiritimati";
    const createdAt = Date.parse("2026-01-15T20:00:00.000Z");
    const expected = new Intl.DateTimeFormat(undefined, {
      timeZone: HOUSEHOLD_TIMEZONE,
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(createdAt));
    // Sanity: the household-timezone formatting must actually differ from a UTC rendering,
    // or this test would pass vacuously even with the context wire-up removed.
    const utcRendering = new Intl.DateTimeFormat(undefined, {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(createdAt));
    expect(expected).not.toBe(utcRendering);

    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({
          locale: { timezone: HOUSEHOLD_TIMEZONE, language: "en", weekStartDay: 1 },
        });
      }
      if (url === "/api/backups") {
        return jsonResponse({
          ...ONE_BACKUP_LIST,
          backups: [{ ...ONE_BACKUP_LIST.backups[0], createdAt }],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    const row = await screen.findByTestId("backups-row-scheduled-20260901-033000-000.db");
    await waitFor(() => expect(row).toHaveTextContent(expected));
  });

  it("renders the empty state when the shelf has no backups", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(EMPTY_LIST);
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();

    expect(await screen.findByTestId("backups-empty")).toBeInTheDocument();
  });

  it("shows an already_running notice for snapshot-now without treating it as an error", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(EMPTY_LIST);
      if (url === "/api/backups/snapshot" && init?.method === "POST") {
        return jsonResponse({ status: "already_running" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    fireEvent.click(await screen.findByTestId("backups-snapshot-now"));

    const info = await screen.findByTestId("backups-snapshot-info");
    expect(info).toHaveTextContent("already running");
    expect(screen.queryByTestId("backups-snapshot-error")).not.toBeInTheDocument();
  });

  it("restore confirm mismatch blocks the request — no fetch is sent", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    const filename = "scheduled-20260901-033000-000.db";
    fireEvent.click(await screen.findByTestId(`backups-restore-select-${filename}`));

    const input = await screen.findByTestId("backups-restore-confirm-input");
    fireEvent.change(input, { target: { value: "not-the-right-filename.db" } });
    fireEvent.click(screen.getByTestId("backups-restore-submit"));

    // Mismatch is now a field-validation error surfaced through Field's wiring (aria-invalid +
    // aria-describedby on the input) rather than the standalone operation-error notice.
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!.split(" ").pop()!)).toHaveTextContent(
      "does not match"
    );
    expect(
      (mockFetch.mock.calls as FetchCall[]).filter(
        ([reqInput]) => String(reqInput) === "/api/backups/restore"
      )
    ).toHaveLength(0);
  });

  it("surfaces a server-side restore refusal (e.g. incompatible_backup) verbatim, in English", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      if (url === "/api/backups/restore" && init?.method === "POST") {
        return jsonResponse(
          {
            status: "incompatible_backup",
            message: "The selected file is not a compatible backup",
          },
          422
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    const filename = "scheduled-20260901-033000-000.db";
    fireEvent.click(await screen.findByTestId(`backups-restore-select-${filename}`));
    fireEvent.change(await screen.findByTestId("backups-restore-confirm-input"), {
      target: { value: filename },
    });
    fireEvent.click(screen.getByTestId("backups-restore-submit"));

    expect(await screen.findByTestId("backups-restore-error")).toHaveTextContent(
      "The selected file is not a compatible backup"
    );
  });

  it("reloads the page on a successful restore (plan.md D8)", async () => {
    const reloadSpy = vi.fn();
    vi.stubGlobal("location", { reload: reloadSpy });

    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      if (url === "/api/backups/restore" && init?.method === "POST") {
        return jsonResponse({ status: "restored", dbGeneration: 12345, migrated: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    const filename = "scheduled-20260901-033000-000.db";
    fireEvent.click(await screen.findByTestId(`backups-restore-select-${filename}`));
    fireEvent.change(await screen.findByTestId("backups-restore-confirm-input"), {
      target: { value: filename },
    });
    fireEvent.click(screen.getByTestId("backups-restore-submit"));

    await waitFor(() => expect(reloadSpy).toHaveBeenCalledTimes(1));
  });

  it("requires explicit confirmation before deleting a selected backup", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      if (url === "/api/backups/scheduled-20260901-033000-000.db" && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    const filename = "scheduled-20260901-033000-000.db";
    fireEvent.click(await screen.findByTestId(`backups-delete-${filename}`));

    expect(await screen.findByTestId("backups-delete-confirm")).toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByTestId("backups-delete-cancel"));
    expect(screen.getByTestId(`backups-row-${filename}`)).toBeInTheDocument();
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByTestId(`backups-delete-${filename}`));
    fireEvent.click(await screen.findByTestId("backups-delete-confirm"));
    await waitFor(() =>
      expect(mockFetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true)
    );
  });

  it("surfaces a delete refusal (409 retention_floor) and keeps the row in the list", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      if (url === "/api/backups/scheduled-20260901-033000-000.db" && init?.method === "DELETE") {
        return jsonResponse(
          {
            error: "retention_floor",
            message: "Deleting this backup would drop the regular shelf below its retention floor",
          },
          409
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    const filename = "scheduled-20260901-033000-000.db";
    fireEvent.click(await screen.findByTestId(`backups-delete-${filename}`));
    fireEvent.click(await screen.findByTestId("backups-delete-confirm"));

    expect(await screen.findByTestId("backups-delete-error")).toHaveTextContent("retention floor");
    expect(screen.getByTestId(`backups-row-${filename}`)).toBeInTheDocument();
  });

  it("uploads the selected file as a raw application/octet-stream body and refreshes the list", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(EMPTY_LIST);
      if (url === "/api/backups/upload" && init?.method === "POST") {
        expect(init?.headers).toMatchObject({ "content-type": "application/octet-stream" });
        expect(init?.body).toBeInstanceOf(File);
        return jsonResponse({ filename: "upload-20260901-033000-000.db" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    const fileInput = await screen.findByTestId("backups-upload-input");
    const file = new File(["SQLite format 3\0"], "mine.db", { type: "application/octet-stream" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByTestId("backups-upload-submit"));

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput]) => String(reqInput) === "/api/backups/upload"
        )
      ).toHaveLength(1);
    });
    expect(screen.queryByTestId("backups-upload-error")).not.toBeInTheDocument();
  });

  it("surfaces an oversized-upload refusal (413)", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(EMPTY_LIST);
      if (url === "/api/backups/upload" && init?.method === "POST") {
        return jsonResponse(
          {
            error: "upload_too_large",
            message: "Upload exceeds the 67108864-byte size cap; nothing was written to disk",
          },
          413
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    renderManagement();
    const fileInput = await screen.findByTestId("backups-upload-input");
    const file = new File(["x"], "huge.db", { type: "application/octet-stream" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByTestId("backups-upload-submit"));

    expect(await screen.findByTestId("backups-upload-error")).toHaveTextContent(
      "nothing was written to disk"
    );
  });
});
