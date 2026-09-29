/** BackupsManagement + TelemetryManagement spec (FR-009) — the two
 * operational admin surfaces.
 * This is the executable evidence for the verification policy (verification policy): it CALLS
 * the frozen density assertion over each surface's rendered control set with kiosk density
 * active (not merely imports it), across every reachable interaction state with an exact
 * control-count census per phase, proves the census actually fires on a real control REMOVAL
 * (not just a synthetic shrink), records a deliberate negative per surface proving the assertion
 * can fail on THAT surface's own controls, asserts every error state either surface can render is
 * announced through the shared `ErrorNotice` live region AND carries `ErrorNotice`'s own token
 * class (identity, not just behaviour — a hand-rolled `<p role="alert">` would pass a
 * behaviour-only check), asserts the shared `AdminPanel` L2 frame was actually adopted (region +
 * heading, not region alone), and pins `BackupsManagement`'s `TYPE_KEYS` label map.
 * * `ConfirmDialog` is deliberately NOT adopted by this module* (recorded here, mirroring
 * `calendar-view.test.tsx`'s own documented deviation, per `docs/development/style-guide.md`'s * "adopting an L2 component" note):
 * - Restore already carries a STRONGER guard than `ConfirmDialog` can express —
 * BACKUPS-AC-01's typed-exact-filename confirmation, pinned by the pre-existing
 * `tests/client/backups-management.test.tsx` ("restore confirm mismatch blocks the
 * request — no fetch is sent"). `ConfirmDialog`'s contract is a bare Confirm/Cancel pair; it
 * has no slot for an intermediate typed-input step, so adopting it would mean DROPPING the
 * typed-confirm behaviour BACKUPS-AC-01 requires, not merely restyling it.
 * - Delete has never had a confirmation step of any kind — the SAME pre-existing spec pins a
 * DIRECT click -> DELETE fetch with no intermediate step ("surfaces a delete refusal (409
 * retention_floor)... "). Gating it behind `ConfirmDialog` now would change tested,
 * out-of-scope behaviour (this module is a token-dialect migration, not a new confirmation
 * step) and break that pre-existing coverage.
 * `WeekdayPicker`/`StatusToggle`/`CheckboxField`/`RadioField` do not apply to either surface —
 * neither renders a weekday list, a pressed-state toggle, a checkbox or a radio control.
 * Functional CRUD coverage already exists (`tests/client/backups-management.test.tsx`,
 * `tests/client/backups-i18n-parity.test.ts`, `tests/client/telemetry-panel.test.tsx`,
 * `tests/client/telemetry-i18n-parity.test.ts`, `tests/client/telemetry-producers.test.ts`) — this
 * file does not repeat that surface area; it only proves the migration-specific guarantees
 * exists to prove.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BackupsManagement, TYPE_KEYS } from "@/admin/BackupsManagement";
import { TelemetryManagement } from "@/admin/TelemetryManagement";
import { HouseholdSettingsProvider } from "@/lib/householdSettings";
import { LanguageProvider } from "@/i18n";
import { messages } from "@/i18n/messages";
import type { BackupListItem, BackupListResponse, BackupType } from "../../src/shared";
import { DensityViolationError, assertKioskDensityCompliant } from "./helpers/density";
import { injectDensityStyles } from "./helpers/densityStyles";

/** Mirrors `density.ts`'s own selector/filter — see `printing-surfaces.test.tsx`'s identical
 * helper for why this is duplicated rather than imported (the frozen file exposes no census API
 * by design). Lets THIS spec assert an exact control count per phase, not just "compliant or
 * not". */
const CENSUS_CONTROL_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "a[href]",
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function countInteractiveControls(container: Document | Element): number {
  return Array.from(container.querySelectorAll(CENSUS_CONTROL_SELECTOR)).filter((element) => {
    if (element instanceof HTMLElement && element.hidden) return false;
    return element.getAttribute("aria-hidden") !== "true";
  }).length;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), { status });
}

function makeBackup(overrides: Partial<BackupListItem> = {}): BackupListItem {
  return {
    filename: "scheduled-20260901-033000-000.db",
    type: "scheduled" as BackupType,
    createdAt: 1,
    sizeBytes: 2048,
    ...overrides,
  };
}

function backupsList(backups: BackupListItem[] = []): BackupListResponse {
  return { backups, dbGeneration: 0, lastBackupError: null, lastPruneError: null };
}

/** A fully-loaded, happy-path mock backend for `BackupsManagement`. `overrides` lets a single
 * test redirect one endpoint, without re-declaring the rest — mirrors `members-admin.test.tsx`'s * own `mockBackend` shape. */
function mockBackupsBackend(
  overrides: Partial<{
    list: () => Response;
    snapshot: () => Response;
    del: (filename: string) => Response;
    restore: () => Response | Promise<Response>;
    upload: () => Response;
    language: string;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL, init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/api/settings") {
      return Promise.resolve(
        jsonResponse({ locale: { timezone: "UTC", language: overrides.language ?? "en" } })
      );
    }
    if (url === "/api/backups" && method === "GET") {
      return Promise.resolve(overrides.list ? overrides.list() : jsonResponse(backupsList()));
    }
    if (url === "/api/backups/snapshot" && method === "POST") {
      return Promise.resolve(
        overrides.snapshot
          ? overrides.snapshot()
          : jsonResponse({ status: "completed", filename: "snapshot-new.db" })
      );
    }
    const deleteMatch = /^\/api\/backups\/([^/]+)$/.exec(url);
    if (deleteMatch && method === "DELETE") {
      return Promise.resolve(
        overrides.del ? overrides.del(decodeURIComponent(deleteMatch[1])) : jsonResponse({}, 200)
      );
    }
    if (url === "/api/backups/restore" && method === "POST") {
      return Promise.resolve(
        overrides.restore
          ? overrides.restore()
          : jsonResponse({ status: "restored", dbGeneration: 1, migrated: false })
      );
    }
    if (url === "/api/backups/upload" && method === "POST") {
      return Promise.resolve(
        overrides.upload ? overrides.upload() : jsonResponse({ filename: "upload-new.db" })
      );
    }

    throw new Error(`unexpected fetch: ${url} (${method})`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderBackups() {
  return render(
    <HouseholdSettingsProvider>
      <LanguageProvider>
        <BackupsManagement />
      </LanguageProvider>
    </HouseholdSettingsProvider>
  );
}

function mockTelemetryBackend(
  overrides: Partial<{
    list: (url: string) => Response;
  }> = {}
) {
  const mockFetch = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url === "/api/settings") {
      return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
    }
    if (url.startsWith("/api/telemetry/client-log")) {
      return Promise.resolve(
        overrides.list ? overrides.list(url) : jsonResponse({ rows: [], nextCursor: null })
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function renderTelemetry() {
  return render(
    <LanguageProvider>
      <TelemetryManagement />
    </LanguageProvider>
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  document.documentElement.removeAttribute("data-density");
});

describe("BackupsManagement / TelemetryManagement — the shared AdminPanel L2 frame was ADOPTED (FR-009)", () => {
  it("BackupsManagement wraps the surface in a landmark region labelled by its own title", async () => {
    mockBackupsBackend();
    renderBackups();

    // A bare `<div>` in place of AdminPanel passes every functional test in this file — this is
    // the only assertion that would catch it (verification policy; four prior batches shipped without
    // it — see the verification policy).
    expect(await screen.findByRole("region", { name: "Backups" })).toBeInTheDocument();
    // Region alone is bypassable: AdminPanel names its region via `aria-labelledby` pointing at
    // its own heading, so a hand-rolled `<section aria-label="Backups">` with NO heading
    // reproduces the landmark and its name and passes. The heading is the half a substitute
    // would have to reproduce the component to satisfy.
    expect(screen.getByRole("heading", { name: "Backups" })).toBeInTheDocument();
  });

  it("TelemetryManagement wraps the surface in a landmark region labelled by its own title", async () => {
    mockTelemetryBackend();
    renderTelemetry();

    expect(await screen.findByRole("region", { name: "Telemetry" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Telemetry" })).toBeInTheDocument();
  });
});

describe("BackupsManagement — kiosk density across every reachable state (SC-001, SC-002)", () => {
  it("renders the DELIBERATE zero-control census while the initial /api/backups fetch is unresolved", async () => {
    let resolveList: (() => void) | undefined;
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/settings") {
        return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url === "/api/backups") {
        return new Promise<Response>((resolve) => {
          resolveList = () => resolve(jsonResponse(backupsList()));
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderBackups();
      await screen.findByText("Loading backups…");

      // No button/input/link exists anywhere in the loading frame — zero is the correct,
      // DELIBERATE value (the frozen helper fails closed on an empty set by design,
      // obligation 2 — it CANNOT be called here), which is exactly why the verification policy asks
      // for an explicit census alongside the density assertion, not the density assertion alone.
      expect(countInteractiveControls(document.body)).toBe(0);

      resolveList?.();
      await screen.findByTestId("backups-empty");
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with an EMPTY shelf — Snapshot Now + the upload file field + the upload button (3 controls)", async () => {
    mockBackupsBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderBackups();
      await screen.findByTestId("backups-empty");

      expect(countInteractiveControls(document.body)).toBe(3);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with ONE backup row — base 3 + the row's 4 action controls (7 total)", async () => {
    mockBackupsBackend({ list: () => jsonResponse(backupsList([makeBackup()])) });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderBackups();
      await screen.findByTestId("backups-table");

      expect(countInteractiveControls(document.body)).toBe(7);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with the restore-confirm panel OPEN (+3: the typed-confirm input, submit, cancel — 10 total), including while the restore submit is IN-FLIGHT", async () => {
    let resolveRestore: (() => void) | undefined;
    const filename = "scheduled-20260901-033000-000.db";
    mockBackupsBackend({
      list: () => jsonResponse(backupsList([makeBackup({ filename })])),
      restore: () =>
        new Promise<Response>((resolve) => {
          resolveRestore = () =>
            resolve(jsonResponse({ status: "restored", dbGeneration: 1, migrated: false }));
        }),
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");
    vi.stubGlobal("location", { reload: vi.fn() });

    try {
      renderBackups();
      await screen.findByTestId("backups-table");

      fireEvent.click(screen.getByTestId(`backups-restore-select-${filename}`));
      await screen.findByTestId("backups-restore-confirm-input");

      expect(countInteractiveControls(document.body)).toBe(10);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      // In-flight: the submit button disables but stays MOUNTED (still counted) — the census
      // must not silently drop it just because it's disabled.
      fireEvent.change(screen.getByTestId("backups-restore-confirm-input"), {
        target: { value: filename },
      });
      fireEvent.click(screen.getByTestId("backups-restore-submit"));
      await waitFor(() => expect(screen.getByTestId("backups-restore-submit")).toBeDisabled());

      expect(countInteractiveControls(document.body)).toBe(10);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      resolveRestore?.();
    } finally {
      uninject();
    }
  });

  it("CENSUS FIRES ON REMOVAL — deleting a backup drops its row's 4 controls from the count (11 -> 7), not a synthetic shrink", async () => {
    const keepFilename = "scheduled-keep.db";
    const deleteFilename = "scheduled-delete.db";
    let listCalls = 0;
    mockBackupsBackend({
      list: () => {
        listCalls += 1;
        return listCalls === 1
          ? jsonResponse(
              backupsList([
                makeBackup({ filename: keepFilename }),
                makeBackup({ filename: deleteFilename }),
              ])
            )
          : jsonResponse(backupsList([makeBackup({ filename: keepFilename })]));
      },
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderBackups();
      await screen.findByTestId("backups-table");

      // Base 3 + two rows * 4 controls each = 11.
      expect(countInteractiveControls(document.body)).toBe(11);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      fireEvent.click(screen.getByTestId(`backups-delete-${deleteFilename}`));
      fireEvent.click(await screen.findByTestId("backups-delete-confirm"));
      await waitFor(() =>
        expect(screen.queryByTestId(`backups-row-${deleteFilename}`)).not.toBeInTheDocument()
      );

      // The deleted row's own 4 controls (download, download-sql, restore-select, delete) are
      // gone — base 3 + one remaining row's 4 controls = 7. A census that failed to actually
      // recompute (a stale/memoized count) would still read 11 here.
      expect(countInteractiveControls(document.body)).toBe(7);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Snapshot Now button below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    mockBackupsBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderBackups();
      const snapshotButton = await screen.findByTestId("backups-snapshot-now");

      // A real control from this surface, not a synthetic fixture.
      snapshotButton.style.height = "14px";
      snapshotButton.style.fontSize = "9px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 14px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 9px is below the kiosk minimum 18px/);

      // Revert — compliance returns.
      snapshotButton.style.height = "";
      snapshotButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

describe("TelemetryManagement — kiosk density across every reachable state (SC-001, SC-002)", () => {
  it("meets kiosk density while loading — the filter row (5 controls) is ALWAYS mounted, even before the first page resolves", async () => {
    let resolveList: (() => void) | undefined;
    const mockFetch = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url === "/api/settings") {
        return Promise.resolve(jsonResponse({ locale: { timezone: "UTC", language: "en" } }));
      }
      if (url.startsWith("/api/telemetry/client-log")) {
        return new Promise<Response>((resolve) => {
          resolveList = () => resolve(jsonResponse({ rows: [], nextCursor: null }));
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", mockFetch);
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderTelemetry();
      await screen.findByText("Loading telemetry…");

      // Level select + component/from/to inputs + Apply — the filter row sits OUTSIDE the
      // loading branch, so it is never a zero-control phase on this surface (unlike Backups'
      // initial load or PrintExecutor's transient states).
      expect(countInteractiveControls(document.body)).toBe(5);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();

      resolveList?.();
      await screen.findByTestId("telemetry-empty");
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with NO rows (still 5 — the filter row only)", async () => {
    mockTelemetryBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderTelemetry();
      await screen.findByTestId("telemetry-empty");

      expect(countInteractiveControls(document.body)).toBe(5);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("meets kiosk density with rows AND a next cursor — Load More adds a 6th control", async () => {
    mockTelemetryBackend({
      list: () =>
        jsonResponse({
          rows: [
            {
              id: "row-1",
              eventId: "event-1",
              eventTime: null,
              receivedAt: 1000,
              level: "error",
              component: "client.global",
              message: "fetch failed",
              data: null,
            },
          ],
          nextCursor: "cursor-1",
        }),
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderTelemetry();
      await screen.findByTestId("telemetry-row-row-1");

      expect(screen.getByTestId("telemetry-load-more")).toBeInTheDocument();
      expect(countInteractiveControls(document.body)).toBe(6);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("CENSUS FIRES ON REMOVAL — a failed Apply invalidates the cursor and Load More disappears (6 -> 5)", async () => {
    let calls = 0;
    mockTelemetryBackend({
      list: () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse({
            rows: [
              {
                id: "row-seed",
                eventId: "event-seed",
                eventTime: null,
                receivedAt: 1000,
                level: "info",
                component: "client.global",
                message: "seed page",
                data: null,
              },
            ],
            nextCursor: "cursor-seed",
          });
        }
        return new Response(JSON.stringify({ error: "internal_error" }), { status: 500 });
      },
    });
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      renderTelemetry();
      await screen.findByTestId("telemetry-row-row-seed");
      expect(screen.getByTestId("telemetry-load-more")).toBeInTheDocument();
      expect(countInteractiveControls(document.body)).toBe(6);

      fireEvent.click(screen.getByTestId("telemetry-apply-filters"));
      await waitFor(() =>
        expect(screen.queryByTestId("telemetry-load-more")).not.toBeInTheDocument()
      );

      // A census that failed to actually recompute (a stale/memoized count) would still read 6.
      expect(countInteractiveControls(document.body)).toBe(5);
      expect(() => assertKioskDensityCompliant(document.body)).not.toThrow();
    } finally {
      uninject();
    }
  });

  it("DELIBERATE NEGATIVE — forcing this surface's own Apply Filters button below the kiosk minimum makes the assertion fail, and reverting restores compliance", async () => {
    mockTelemetryBackend();
    const uninject = await injectDensityStyles();
    document.documentElement.setAttribute("data-density", "kiosk");

    try {
      const { container } = renderTelemetry();
      const applyButton = await screen.findByTestId("telemetry-apply-filters");

      applyButton.style.height = "22px";
      applyButton.style.fontSize = "12px";

      let thrown: unknown;
      try {
        assertKioskDensityCompliant(container);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(DensityViolationError);
      const message = (thrown as DensityViolationError).message;
      expect(message).toMatch(/height 22px is below the kiosk minimum 48px/);
      expect(message).toMatch(/font-size 12px is below the kiosk minimum 18px/);

      applyButton.style.height = "";
      applyButton.style.fontSize = "";
      expect(() => assertKioskDensityCompliant(container)).not.toThrow();
    } finally {
      uninject();
    }
  });
});

/** Every `ErrorNotice` identity assertion below checks BOTH the live-region behaviour (role +
 * aria-live, already required by SC-011) AND the component's own token class
 * (`text-destructive`) — a hand-rolled `<p role="alert" className="text-red-600">` would satisfy
 * the behaviour half alone; the class assertion is what proves the SHARED component was actually
 * used, not a lookalike (verification policy, "ErrorNotice identity (token classes), not just
 * behaviour"). */
function expectErrorNoticeIdentity(alert: HTMLElement, expectedAriaLive: "assertive" | "polite") {
  expect(alert).toHaveAttribute("role", "alert");
  expect(alert).toHaveAttribute("aria-live", expectedAriaLive);
  expect(alert).toHaveClass("text-destructive");
}

describe("BackupsManagement — every error state is announced through ErrorNotice, with its own identity (SC-011)", () => {
  it("a load failure", async () => {
    mockBackupsBackend({ list: () => new Response(null, { status: 500 }) });
    renderBackups();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load backups.");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a lastBackupError surfaced on load (assertive)", async () => {
    mockBackupsBackend({
      list: () =>
        jsonResponse({ ...backupsList(), lastBackupError: "disk full", lastPruneError: null }),
    });
    renderBackups();

    const alert = await screen.findByTestId("backups-last-backup-error");
    expect(alert).toHaveTextContent("disk full");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a lastPruneError surfaced on load (polite — a lesser-severity notice than a failed backup)", async () => {
    mockBackupsBackend({
      list: () =>
        jsonResponse({
          ...backupsList(),
          lastBackupError: null,
          lastPruneError: "permission denied",
        }),
    });
    renderBackups();

    const alert = await screen.findByTestId("backups-last-prune-error");
    expect(alert).toHaveTextContent("permission denied");
    expectErrorNoticeIdentity(alert, "polite");
  });

  it("a snapshot failure", async () => {
    mockBackupsBackend({
      snapshot: () => jsonResponse({ message: "disk write failed" }, 500),
    });
    renderBackups();
    fireEvent.click(await screen.findByTestId("backups-snapshot-now"));

    const alert = await screen.findByTestId("backups-snapshot-error");
    expect(alert).toHaveTextContent("disk write failed");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a delete refusal", async () => {
    const filename = "scheduled-20260901-033000-000.db";
    mockBackupsBackend({
      list: () => jsonResponse(backupsList([makeBackup({ filename })])),
      del: () =>
        jsonResponse(
          { error: "retention_floor", message: "Deleting this backup would drop the shelf" },
          409
        ),
    });
    renderBackups();
    fireEvent.click(await screen.findByTestId(`backups-delete-${filename}`));
    fireEvent.click(await screen.findByTestId("backups-delete-confirm"));

    const alert = await screen.findByTestId("backups-delete-error");
    expect(alert).toHaveTextContent("Deleting this backup would drop the shelf");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("a typed-confirm mismatch (client-side, no round-trip)", async () => {
    const filename = "scheduled-20260901-033000-000.db";
    mockBackupsBackend({ list: () => jsonResponse(backupsList([makeBackup({ filename })])) });
    renderBackups();
    fireEvent.click(await screen.findByTestId(`backups-restore-select-${filename}`));
    fireEvent.change(await screen.findByTestId("backups-restore-confirm-input"), {
      target: { value: "not-the-right-filename.db" },
    });
    fireEvent.click(screen.getByTestId("backups-restore-submit"));

    // The mismatch is a FIELD-validation error: it routes through Field's error wiring, so the
    // assertions here are the wiring itself — aria-invalid on the input and the describedby link
    // to the announced error — not a standalone notice testid (that one now carries only
    // operation errors; see the server-side refusal test below).
    const input = screen.getByTestId("backups-restore-confirm-input");
    await waitFor(() => expect(input).toHaveAttribute("aria-invalid", "true"));
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy, "the input must reference its error via aria-describedby").toBeTruthy();
    const alert = document.getElementById(describedBy!.split(" ").pop()!);
    expect(alert).not.toBeNull();
    expect(alert!).toHaveTextContent("does not match");
    expectErrorNoticeIdentity(alert as HTMLElement, "assertive");
  });

  it("a server-side restore refusal", async () => {
    const filename = "scheduled-20260901-033000-000.db";
    mockBackupsBackend({
      list: () => jsonResponse(backupsList([makeBackup({ filename })])),
      restore: () =>
        jsonResponse({ status: "incompatible_backup", message: "Not a compatible backup" }, 422),
    });
    renderBackups();
    fireEvent.click(await screen.findByTestId(`backups-restore-select-${filename}`));
    fireEvent.change(await screen.findByTestId("backups-restore-confirm-input"), {
      target: { value: filename },
    });
    fireEvent.click(screen.getByTestId("backups-restore-submit"));

    const alert = await screen.findByTestId("backups-restore-error");
    expect(alert).toHaveTextContent("Not a compatible backup");
    expectErrorNoticeIdentity(alert, "assertive");
  });

  it("an upload refusal", async () => {
    mockBackupsBackend({
      upload: () =>
        jsonResponse({ error: "upload_too_large", message: "Upload exceeds the size cap" }, 413),
    });
    renderBackups();
    const fileInput = await screen.findByTestId("backups-upload-input");
    const file = new File(["x"], "huge.db", { type: "application/octet-stream" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.click(screen.getByTestId("backups-upload-submit"));

    const alert = await screen.findByTestId("backups-upload-error");
    expect(alert).toHaveTextContent("Upload exceeds the size cap");
    expectErrorNoticeIdentity(alert, "assertive");
  });
});

describe("TelemetryManagement — the load-failure state is announced through ErrorNotice, with its own identity (SC-011)", () => {
  it("a client-log load failure", async () => {
    mockTelemetryBackend({ list: () => new Response(null, { status: 500 }) });
    renderTelemetry();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load telemetry.");
    expectErrorNoticeIdentity(alert, "assertive");
  });
});

// Independent review lesson carried from (MealsManagement) and (ChoresBoard):
// assert EVERY map an `as MessageKey` -> typed-map refactor creates, not just the one site
// obviously exercised. TYPE_KEYS pre-dates this module's own cast-removal work (it was already a
// typed `Record<BackupType, MessageKey>`), but the verification policy's map-pinning clause applies to
// every label map a migrated surface carries, not only ones freshly converted from a cast — so it
// is pinned here rather than left unasserted.
describe("BackupsManagement — TYPE_KEYS maps each backup type to its OWN translation key (SC-007)", () => {
  const MECHANICALLY_DERIVABLE_TYPES = ["scheduled", "snapshot", "upload"] as const;

  it("ITERATES the three mechanically-derivable keys against the `backups.management.type.${key}` template", () => {
    // A swapped or hand-transcribed entry among these three would fail here — this is NOT a
    // hand-written list of expectations, it is a loop over the map's own keys.
    for (const key of MECHANICALLY_DERIVABLE_TYPES) {
      expect(TYPE_KEYS[key]).toBe(`backups.management.type.${key}`);
    }
  });

  it('the fourth key ("pre-restore") is NOT mechanically derivable (hyphen -> camelCase) — asserted against the catalogue directly, in both locales, per the documented escape hatch', () => {
    expect(TYPE_KEYS["pre-restore"]).toBe("backups.management.type.preRestore");
    expect(messages.en[TYPE_KEYS["pre-restore"]]).toBe("Pre-restore");
    expect(messages.es[TYPE_KEYS["pre-restore"]]).toBe("Pre-restauración");
  });

  it("renders every one of the four types' OWN localized label in the table, under a non-English household locale — order-and-content, not a set comparison (a swap would preserve the SET while breaking which type gets which label)", async () => {
    mockBackupsBackend({
      language: "es",
      list: () =>
        jsonResponse(
          backupsList([
            makeBackup({ filename: "a-scheduled.db", type: "scheduled" }),
            makeBackup({ filename: "b-snapshot.db", type: "snapshot" }),
            makeBackup({ filename: "c-pre-restore.db", type: "pre-restore" }),
            makeBackup({ filename: "d-upload.db", type: "upload" }),
          ])
        ),
    });
    renderBackups();

    await screen.findByTestId("backups-table");
    // Anchor on the LOCALIZED text before the per-row assertions: the table can mount with the
    // default (English) locale before the /api/settings fetch resolves and "es" applies — the
    // same await-the-state-you-assert lesson as the loading-skeleton anchor. Without this the
    // test is a race that usually passes (it did for its author) and fails on a slow settings
    // resolution.
    await screen.findByText("Programada");
    expect(screen.getByTestId("backups-row-a-scheduled.db")).toHaveTextContent("Programada");
    expect(screen.getByTestId("backups-row-b-snapshot.db")).toHaveTextContent("Instantánea");
    expect(screen.getByTestId("backups-row-c-pre-restore.db")).toHaveTextContent(
      "Pre-restauración"
    );
    expect(screen.getByTestId("backups-row-d-upload.db")).toHaveTextContent("Subida");
  });
});
