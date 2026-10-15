import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BackupsManagement,
  TYPE_KEYS,
  formatRelativeAge,
  isDbFile,
} from "@/admin/BackupsManagement";
import { TYPE_PILL_CLASSES } from "@/lib/recipes";
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
    const expected = new Intl.DateTimeFormat("en-GB", {
      timeZone: HOUSEHOLD_TIMEZONE,
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(createdAt));
    // Sanity: the household-timezone formatting must actually differ from a UTC rendering,
    // or this test would pass vacuously even with the context wire-up removed.
    const utcRendering = new Intl.DateTimeFormat("en-GB", {
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
    await waitFor(() => expect(row.querySelector("time")).toHaveAttribute("title", expected));
    expect(row.querySelector("time")).toHaveAttribute(
      "datetime",
      new Date(createdAt).toISOString()
    );
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

    await waitFor(() => {
      expect(
        (mockFetch.mock.calls as FetchCall[]).filter(
          ([reqInput]) => String(reqInput) === "/api/backups/upload"
        )
      ).toHaveLength(1);
    });
    expect(screen.queryByTestId("backups-upload-error")).not.toBeInTheDocument();
    expect(await screen.findByTestId("backups-upload-success")).toHaveTextContent(
      "Uploaded as upload-20260901-033000-000.db."
    );
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

    expect(await screen.findByTestId("backups-upload-error")).toHaveTextContent(
      "nothing was written to disk"
    );
  });

  it("rejects a non-.db selection before any request and shows the unsupported message", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const url = String(args[0]);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(EMPTY_LIST);
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderManagement();
    const fileInput = await screen.findByTestId("backups-upload-input");
    expect(fileInput).toHaveAttribute("accept", ".db");
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "notes.sql")] } });
    expect(await screen.findByTestId("backups-upload-error")).toHaveTextContent(
      "Only .db backup files can be uploaded."
    );
    expect(
      (mockFetch.mock.calls as FetchCall[]).some(([i]) => String(i) === "/api/backups/upload")
    ).toBe(false);
  });

  it("uploads a dropped .db file and toggles the drag-active state", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(EMPTY_LIST);
      if (url === "/api/backups/upload" && init?.method === "POST") {
        return jsonResponse({ filename: "upload-dropped.db" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderManagement();
    const zone = await screen.findByTestId("backups-upload-dropzone");
    fireEvent.dragOver(zone);
    expect(zone).toHaveAttribute("data-drag-active", "true");
    fireEvent.dragLeave(zone);
    expect(zone).toHaveAttribute("data-drag-active", "false");
    const file = new File(["SQLite format 3\0"], "dropped.db");
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(await screen.findByTestId("backups-upload-success")).toHaveTextContent(
      "Uploaded as upload-dropped.db."
    );
  });

  it("names the created snapshot in a success banner and keeps already_running separate", async () => {
    let snapshotResult: unknown = { status: "completed", filename: "snapshot-X.db" };
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const [input, init] = args;
      const url = String(input);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(EMPTY_LIST);
      if (url === "/api/backups/snapshot" && init?.method === "POST") {
        return jsonResponse(snapshotResult);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderManagement();
    fireEvent.click(await screen.findByTestId("backups-snapshot-now"));
    const banner = await screen.findByTestId("backups-snapshot-success");
    expect(banner).toHaveTextContent("Snapshot snapshot-X.db created.");
    expect(banner).toHaveAttribute("role", "status");

    snapshotResult = { status: "already_running" };
    fireEvent.click(screen.getByTestId("backups-snapshot-now"));
    expect(await screen.findByTestId("backups-snapshot-info")).toBeInTheDocument();
    expect(screen.queryByTestId("backups-snapshot-success")).not.toBeInTheDocument();
  });

  it("renders the type as a colour-coded pill with the localized label", async () => {
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const url = String(args[0]);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderManagement();
    const pill = await screen.findByTestId("backups-type-scheduled-20260901-033000-000.db");
    expect(pill).toHaveTextContent("Scheduled");
    for (const token of TYPE_PILL_CLASSES.scheduled.split(" ")) {
      expect(pill).toHaveClass(token);
    }
  });

  it("shows a relative label for a recent backup and the absolute date beyond 30 days", async () => {
    const now = Date.now();
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const url = String(args[0]);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") {
        return jsonResponse({
          ...ONE_BACKUP_LIST,
          backups: [
            { ...ONE_BACKUP_LIST.backups[0], filename: "recent.db", createdAt: now - 5 * 60_000 },
            { ...ONE_BACKUP_LIST.backups[0], filename: "old.db", createdAt: now - 40 * 86_400_000 },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderManagement();
    const recent = await screen.findByTestId("backups-row-recent.db");
    expect(recent.querySelector("time")).toHaveTextContent("5 minutes ago");
    const old = screen.getByTestId("backups-row-old.db").querySelector("time");
    expect(old?.textContent).toBe(old?.getAttribute("title"));
  });

  it("shows a spinner only on the clicked download button and saves the blob", async () => {
    const filename = ONE_BACKUP_LIST.backups[0].filename;
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const url = String(args[0]);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      if (url === `/api/backups/${filename}/download`) return pending;
      throw new Error(`unexpected fetch: ${url}`);
    });
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      renderManagement();
      const button = await screen.findByTestId(`backups-download-${filename}`);
      fireEvent.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveAttribute("aria-busy", "true");
      expect(screen.getByTestId(`backups-download-sql-${filename}`)).toBeEnabled();
      release(new Response(new Blob(["x"]), { status: 200 }));
      await waitFor(() => expect(button).toBeEnabled());
      expect(createObjectURL).toHaveBeenCalled();
      expect(click).toHaveBeenCalled();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
    } finally {
      click.mockRestore();
    }
  });

  it("downloads the SQL export under <filename>.sql and surfaces a download failure", async () => {
    const filename = ONE_BACKUP_LIST.backups[0].filename;
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const url = String(args[0]);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
      if (url === `/api/backups/${filename}/download-sql`) {
        return jsonResponse({ error: "not_found" }, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderManagement();
    const button = await screen.findByTestId(`backups-download-sql-${filename}`);
    fireEvent.click(button);
    expect(await screen.findByTestId("backups-download-error")).toBeInTheDocument();
    await waitFor(() => expect(button).toBeEnabled());
  });

  it("offers Retry after a load failure and hides the empty state", async () => {
    let calls = 0;
    const mockFetch = vi.mocked(globalThis.fetch);
    mockFetch.mockImplementation(async (...args: FetchCall) => {
      const url = String(args[0]);
      if (url === "/api/settings") {
        return jsonResponse({ locale: { timezone: "UTC", language: "en", weekStartDay: 1 } });
      }
      if (url === "/api/backups") {
        calls += 1;
        return calls === 1 ? jsonResponse({}, 500) : jsonResponse(ONE_BACKUP_LIST);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    renderManagement();
    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to load backups.");
    expect(screen.queryByTestId("backups-empty")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("backups-retry"));
    expect(await screen.findByTestId("backups-table")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("backups helpers", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");
  const rtfEn = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });

  it("formats relative ages up to 30 days and null beyond", () => {
    expect(formatRelativeAge(now - 20_000, now, "en")).toBe(rtfEn.format(0, "second"));
    expect(formatRelativeAge(now - 5 * 60_000, now, "en")).toBe("5 minutes ago");
    expect(formatRelativeAge(now - 3 * 3_600_000, now, "en")).toBe("3 hours ago");
    expect(formatRelativeAge(now - 86_400_000, now, "en")).toBe("yesterday");
    expect(formatRelativeAge(now - 3 * 86_400_000, now, "en")).toBe("3 days ago");
    expect(formatRelativeAge(now - 40 * 86_400_000, now, "en")).toBeNull();
    expect(formatRelativeAge(now + 60_000, now, "en")).toBe(rtfEn.format(0, "second"));
    expect(formatRelativeAge(now - 5 * 60_000, now, "es")).toBe(
      new Intl.RelativeTimeFormat("es-ES", { numeric: "auto" }).format(-5, "minute")
    );
  });

  it("accepts only .db names (case-insensitive)", () => {
    expect(isDbFile("a.db")).toBe(true);
    expect(isDbFile("A.DB")).toBe(true);
    expect(isDbFile("a.sql")).toBe(false);
    expect(isDbFile("a.db.sql")).toBe(false);
    expect(isDbFile("db")).toBe(false);
  });

  it("covers every backup type with semantic token classes only", () => {
    expect(Object.keys(TYPE_PILL_CLASSES).sort()).toEqual(Object.keys(TYPE_KEYS).sort());
    for (const value of Object.values(TYPE_PILL_CLASSES)) {
      expect(value).not.toMatch(
        /\b(bg|text|border)-(red|blue|green|amber|purple|gray|slate|yellow|orange)-\d/
      );
    }
  });
});

it.each(["en", "es"] as const)(
  "shows localized recovery guidance for a terminal restore failure (%s)",
  async (language) => {
    const backup = ONE_BACKUP_LIST.backups[0];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        if (String(input) === "/api/settings")
          return jsonResponse({ locale: { language, timezone: "UTC" } });
        if (String(input) === "/api/backups/restore")
          return jsonResponse(
            { status: "rollback_failed", message: "Private English recovery diagnostics" },
            503
          );
        if (String(input) === "/api/backups") return jsonResponse(ONE_BACKUP_LIST);
        throw new Error("Unexpected request");
      })
    );
    try {
      renderManagement();
      await screen.findByRole("button", { name: language === "es" ? "Restaurar" : "Restore" });
      fireEvent.click(screen.getByTestId(`backups-restore-select-${backup.filename}`));
      fireEvent.change(screen.getByTestId("backups-restore-confirm-input"), {
        target: { value: backup.filename },
      });
      fireEvent.click(screen.getByTestId("backups-restore-submit"));
      const alert = await screen.findByTestId("backups-restore-error");
      expect(alert).toHaveTextContent(
        language === "es" ? "requiere recuperación manual" : "requires manual recovery"
      );
      expect(alert).not.toHaveTextContent("Private English");
    } finally {
      cleanup();
      vi.unstubAllGlobals();
    }
  }
);

it("formats backup dates with Spanish household locale and timezone", async () => {
  const createdAt = Date.parse("2026-01-15T20:00:00Z");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (String(input) === "/api/settings")
        return jsonResponse({ locale: { language: "es", timezone: "Pacific/Kiritimati" } });
      if (String(input) === "/api/backups")
        return jsonResponse({
          ...ONE_BACKUP_LIST,
          backups: [{ ...ONE_BACKUP_LIST.backups[0], createdAt }],
        });
      throw new Error("Unexpected request");
    })
  );
  try {
    renderManagement();
    const row = await screen.findByTestId(`backups-row-${ONE_BACKUP_LIST.backups[0].filename}`);
    const expected = new Intl.DateTimeFormat("es-ES", {
      timeZone: "Pacific/Kiritimati",
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(createdAt));
    await waitFor(() => expect(row.querySelector("time")).toHaveAttribute("title", expected));
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});
