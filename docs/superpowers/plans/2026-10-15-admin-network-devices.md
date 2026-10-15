# Admin Network devices parity: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. Work in your own worktree on its own branch. The spec and this plan live UNTRACKED in the main checkout (`/Users/diego/Dev/marplanner-project`); Task 0 copies them in. Never touch the reference repo `/Users/diego/Dev/marplanner` (read-only). Do not run git in the main checkout.

**Goal:** Rework `/admin/network-devices` to reference parity (Registered devices | Add device tabs, status dot and chips, 30 s refresh, Dialog edit and register, ConfirmDialog delete, empty-state link, Retry, sortable discovery table with "Already added"), explain and fix the misleading "Failed to load network devices" message, and add a way to exercise the page without a real UniFi controller.

**Architecture:** Client-only change (no server, shared type, OpenAPI or migration change). The entry component keeps its path and export name and delegates to a data hook plus three presentational files under `src/client/admin/network-devices/`. Tabs are local state (spec D1). A dev fixture CLI plus e2e fixture cover the no-controller exercise.

**Tech Stack:** React 19, TypeScript, Vitest + Testing Library (jsdom), Playwright, Radix Dialog via `@/components/ui/dialog`, Node 24.21.0, npm.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-network-devices-design.md` (read it first; "D<n>" below refers to its decisions).

## Global Constraints

- Technical output (code, comments, commit messages, docs) in English. Conversational replies follow the user's language.
- Reuse primitives in `src/client/components/ui` and composites (`AdminPanel`, `ErrorNotice`, `Field`, `ConfirmDialog` from `@/components/ConfirmDialog`). Do NOT add a shared primitive (no Sheet). Edit and register use `Dialog`.
- Replace `window.confirm` with `ConfirmDialog`; update tests that pin it.
- Page heading equals the sidebar label ("Network devices" / "Dispositivos de red").
- All strings in `src/client/i18n/messages.ts`, en + es. New keys in ONE contiguous block per locale headed by a line comment `// admin-network-devices`, placed at the end of the existing admin keys of that locale. `t(key)` takes NO params: interpolate with `.replace("{column}", value)`.
- Shared hot files, keep edits minimal and localized: `src/client/i18n/messages.ts`, `tests/fixtures/assembly-cohort.json`, `docs/ui/household-contract.md`. Do not touch `AdminRoutes.tsx`, `src/client/shell/routes.ts`, `src/shared/index.ts`, OpenAPI, server code.
- A raw MAC must never render in the registered list, the edit dialog, or the register dialog. The discovery table is the only place (FR-015 / NETWORK-DEVICES-INV-07).
- Semantic Tailwind tokens only (`bg-success`, `bg-destructive`, `bg-muted-foreground`, `text-muted-foreground`, `text-foreground`); no raw palette classes, inline styles or colour literals (`npm run check:ui-debt`). There is no warning token.
- Every interactive control needs an accessible name (`npm run check:accessible-names`).
- Keep existing test titles unchanged where behaviour is unchanged (titles are listed in the reviewed `tests/fixtures/assembly-cohort.json`).

## Review Focus

1. A 403 scope-denied on the list or the live-clients read shows the management-required message (not the generic failure) and still offers Retry; the "Add device" header button still renders (admin-unlock-resilience e2e uses it with a device key). Test in Task 3 and Task 4.
2. A background refresh in flight while the user blocks/unblocks/edits/deletes must not overwrite the fresh result (stale GET). Test in Task 1.
3. A refresh must not fire while the tab is hidden, and must stop after unmount (no timer leak). Test in Task 1.
4. A client with no name (`displayName: null`) or a 100-char name: register dialog alias prefill is empty / truncated to 80, never `null` text. Test in Task 5.
5. Registered MAC compared case-insensitively against live clients ("Already added" even if one side is uppercase). Test in Task 5.

---

## Task 0: Set up the branch

**Files:** copies only.

- [ ] **Step 1:** In your worktree (the orchestrator tells you the path; branch name `feat/admin-network-devices` if you must create it), copy the untracked docs in:
  ```bash
  mkdir -p docs/superpowers/specs docs/superpowers/plans
  cp /Users/diego/Dev/marplanner-project/docs/superpowers/specs/2026-10-15-admin-network-devices-design.md docs/superpowers/specs/
  cp /Users/diego/Dev/marplanner-project/docs/superpowers/plans/2026-10-15-admin-network-devices.md docs/superpowers/plans/
  ```
- [ ] **Step 2:** Environment (from the project notes): Node must be 24.21.0 (`fnm exec --using=24.21.0 ...`), copy `.env.local` from the main checkout if present, `npm ci` if `node_modules` is absent. `mkdir -p .data`.
- [ ] **Step 3:** Baseline, must be green before any change:
  ```bash
  npx vitest run tests/client/network-devices-management.test.tsx tests/client/network-weather-admin.test.tsx tests/client/network-devices-i18n-parity.test.ts tests/client/admin-gate-panel-reset.test.tsx tests/client/admin-routes.test.tsx
  ```
- [ ] **Step 4:** Read these once so later steps make sense: `src/client/admin/NetworkDevicesManagement.tsx` (current 785-line implementation, moved apart in this plan), `src/client/admin/MembersManagement.tsx` lines 430-470 and 676-700 (Dialog + ConfirmDialog usage), `src/client/admin/DailyBriefingManagement.tsx` lines 790-816 (tablist markup), `src/client/components/Field.tsx`, `src/client/components/ConfirmDialog.tsx`.

## Task 1: Data hook and pure helpers (`data.ts`)

**Files:**

- Create: `src/client/admin/network-devices/data.ts`
- Create: `tests/client/network-devices-data.test.ts` (jsdom; vitest environment for `tests/client` is already jsdom)

**Interfaces:**

- Produces (all exported from `data.ts`):
  - `const REFRESH_MS = 30_000`
  - `parseErrorCode(response: Response): Promise<string | undefined>`
  - `controllerErrorMessageKey(code: string | undefined): MessageKey` (same mapping as the old file: `controller_unavailable|controller_rejected|controller_unreachable` to `networkDevices.error.controllerUnavailable|controllerRejected|controllerUnreachable`, anything else to `networkDevices.error.controllerGeneric`)
  - `loadFailureMessageKey(status: number, code: string | undefined, generic: MessageKey): MessageKey` returns `"networkDevices.error.managementRequired"` when `status === 403 && code === AUTH_SCOPE_DENIED_CODE`, else `generic`
  - `class LoadFailure extends Error { constructor(readonly status: number, readonly code: string | undefined) }`
  - `useNetworkDevicesData()` returning `NetworkDevicesData`:
    `{ devices: RegisteredDevice[]; cacheState: LiveCacheState | null; members: Member[] (active only); loading: boolean; listErrorKey: MessageKey | null; membersErrorKey: MessageKey | null; reloadAll(): Promise<void>; markMutation(): void; applyDevice(d: RegisteredDevice): void; removeDevice(id: string): void; addDevice(d: RegisteredDevice): void; attemptedBlockTarget: Record<string, boolean>; setAttemptedBlockTarget(id: string, target: boolean): void }`
  - `type NetworkDevicesData = ReturnType<typeof useNetworkDevicesData>`
- Consumes: `authFetch` from `@/lib/credential`; types from `../../../shared` (`AUTH_SCOPE_DENIED_CODE`, `LiveCacheState`, `Member`, `NetworkDevicesListResponse`, `RegisteredDevice`) (path: `src/client/admin/network-devices/` is three levels below `src/`, so the import is `"../../../shared"`; check the existing file imports `"../../shared"` from `src/client/admin/`).

The hook stores error KEYS, not translated text, so it needs no `t` and its callbacks are stable.

- [ ] **Step 1: Write the failing tests** in `tests/client/network-devices-data.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REFRESH_MS,
  controllerErrorMessageKey,
  loadFailureMessageKey,
  useNetworkDevicesData,
} from "@/admin/network-devices/data";
import { AUTH_SCOPE_DENIED_CODE } from "../../src/shared";
import type { RegisteredDevice } from "../../src/shared";

function dev(overrides: Partial<RegisteredDevice> = {}): RegisteredDevice {
  return {
    id: "dev-1",
    mac: "aa:bb:cc:dd:ee:ff",
    alias: "iPad",
    memberId: null,
    memberLabel: null,
    memberInactive: false,
    isBlocked: false,
    beliefDiverged: false,
    lastSeenAt: 1,
    liveStatus: "online",
    ...overrides,
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("network-devices data helpers", () => {
  it("maps the three controller codes and falls back to the neutral generic key", () => {
    expect(controllerErrorMessageKey("controller_unavailable")).toBe(
      "networkDevices.error.controllerUnavailable"
    );
    expect(controllerErrorMessageKey("controller_rejected")).toBe(
      "networkDevices.error.controllerRejected"
    );
    expect(controllerErrorMessageKey("controller_unreachable")).toBe(
      "networkDevices.error.controllerUnreachable"
    );
    expect(controllerErrorMessageKey(undefined)).toBe("networkDevices.error.controllerGeneric");
    expect(controllerErrorMessageKey("whatever")).toBe("networkDevices.error.controllerGeneric");
  });

  it("only a scope-denied 403 maps to the management-required message", () => {
    const generic = "networkDevices.management.loadError" as const;
    expect(loadFailureMessageKey(403, AUTH_SCOPE_DENIED_CODE, generic)).toBe(
      "networkDevices.error.managementRequired"
    );
    expect(loadFailureMessageKey(403, undefined, generic)).toBe(generic);
    expect(loadFailureMessageKey(500, AUTH_SCOPE_DENIED_CODE, generic)).toBe(generic);
  });
});

describe("useNetworkDevicesData", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  function route(handlers: {
    devices: () => Response | Promise<Response>;
    members?: () => Response;
  }) {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/network-devices") return handlers.devices();
      if (url === "/api/members") return handlers.members ? handlers.members() : json([]);
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("loads devices, cache state and only ACTIVE members", async () => {
    route({
      devices: () => json({ devices: [dev()], cacheState: "fresh" }),
      members: () =>
        json([
          { id: "m1", displayName: "A", lifecycle: "active" },
          { id: "m2", displayName: "B", lifecycle: "archived" },
        ]),
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.devices).toHaveLength(1);
    expect(result.current.cacheState).toBe("fresh");
    expect(result.current.members.map((m) => m.id)).toEqual(["m1"]);
  });

  it("a scope-denied 403 on the list sets the management-required key; a members failure stays independent", async () => {
    route({
      devices: () => json({ error: "forbidden", code: AUTH_SCOPE_DENIED_CODE }, 403),
      members: () => json(null, 500),
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.listErrorKey).toBe("networkDevices.error.managementRequired");
    expect(result.current.membersErrorKey).toBe("networkDevices.error.membersLoadError");
  });

  it("refreshes silently every REFRESH_MS, without flipping loading", async () => {
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        return json({ devices: [dev({ alias: `v${calls}` })], cacheState: "fresh" });
      },
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.devices[0]?.alias).toBe("v1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    await waitFor(() => expect(result.current.devices[0]?.alias).toBe("v2"));
    expect(result.current.loading).toBe(false);
  });

  it("skips the refresh while the tab is hidden", async () => {
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        return json({ devices: [dev()], cacheState: "fresh" });
      },
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS * 2);
    });
    expect(calls).toBe(1);
  });

  it("discards a refresh that was in flight while a mutation happened", async () => {
    let release: (r: Response) => void = () => {};
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        if (calls === 1) return json({ devices: [dev({ isBlocked: false })], cacheState: "fresh" });
        return new Promise<Response>((resolve) => {
          release = resolve;
        }) as unknown as Response;
      },
    });
    const { result } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_MS);
    });
    // The user blocks the device while the refresh GET is still pending.
    act(() => {
      result.current.markMutation();
      result.current.applyDevice(dev({ isBlocked: true }));
    });
    await act(async () => {
      release(json({ devices: [dev({ isBlocked: false })], cacheState: "fresh" }));
    });
    expect(result.current.devices[0].isBlocked).toBe(true);
  });

  it("stops refreshing after unmount", async () => {
    let calls = 0;
    route({
      devices: () => {
        calls += 1;
        return json({ devices: [], cacheState: "fresh" });
      },
    });
    const { result, unmount } = renderHook(() => useNetworkDevicesData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    await vi.advanceTimersByTimeAsync(REFRESH_MS * 3);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/client/network-devices-data.test.ts` fails (module missing).
- [ ] **Step 3: Implement** `src/client/admin/network-devices/data.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import type { MessageKey } from "@/i18n/messages";
import {
  AUTH_SCOPE_DENIED_CODE,
  type LiveCacheState,
  type Member,
  type NetworkDevicesListResponse,
  type RegisteredDevice,
} from "../../../shared";

/** Background refresh cadence. The server poller runs every 60 s and the cache is fresh for 5 min. */
export const REFRESH_MS = 30_000;

export class LoadFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined
  ) {
    super(`load failed: ${status}`);
    this.name = "LoadFailure";
  }
}

export async function parseErrorCode(response: Response): Promise<string | undefined> {
  const data = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return typeof data?.code === "string" ? data.code : undefined;
}

/** (Move the long docblock of the old `controllerErrorMessageKey` here unchanged.) */
export function controllerErrorMessageKey(code: string | undefined): MessageKey {
  if (code === "controller_unavailable") return "networkDevices.error.controllerUnavailable";
  if (code === "controller_rejected") return "networkDevices.error.controllerRejected";
  if (code === "controller_unreachable") return "networkDevices.error.controllerUnreachable";
  return "networkDevices.error.controllerGeneric";
}

/** A live key denied on SCOPE (a device kiosk key, FR-009/FR-016) is not a load failure: say what is needed. */
export function loadFailureMessageKey(
  status: number,
  code: string | undefined,
  generic: MessageKey
): MessageKey {
  return status === 403 && code === AUTH_SCOPE_DENIED_CODE
    ? "networkDevices.error.managementRequired"
    : generic;
}

export function useNetworkDevicesData() {
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [cacheState, setCacheState] = useState<LiveCacheState | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErrorKey, setListErrorKey] = useState<MessageKey | null>(null);
  const [membersErrorKey, setMembersErrorKey] = useState<MessageKey | null>(null);
  const [attempted, setAttempted] = useState<Record<string, boolean>>({});
  // Bumped by every mutation; a silent refresh that started before a bump is discarded.
  const mutations = useRef(0);

  const markMutation = useCallback(() => {
    mutations.current += 1;
  }, []);

  const loadDevices = useCallback(async (silent: boolean) => {
    const startedAt = mutations.current;
    if (!silent) {
      setLoading(true);
      setListErrorKey(null);
    }
    try {
      const response = await authFetch("/api/network-devices", { credentials: "include" });
      if (!response.ok) throw new LoadFailure(response.status, await parseErrorCode(response));
      const data = (await response.json()) as NetworkDevicesListResponse;
      if (silent && mutations.current !== startedAt) return;
      setDevices(data.devices);
      setCacheState(data.cacheState);
      setListErrorKey(null);
    } catch (err) {
      if (silent) return; // keep the last data; the next tick retries
      setListErrorKey(
        err instanceof LoadFailure
          ? loadFailureMessageKey(err.status, err.code, "networkDevices.management.loadError")
          : "networkDevices.management.loadError"
      );
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadMembers = useCallback(async () => {
    setMembersErrorKey(null);
    try {
      const response = await authFetch("/api/members", { credentials: "include" });
      if (!response.ok) throw new Error(`list members: ${response.status}`);
      const data = (await response.json()) as Member[];
      setMembers(data.filter((m) => m.lifecycle === "active"));
    } catch {
      setMembersErrorKey("networkDevices.error.membersLoadError");
    }
  }, []);

  const reloadAll = useCallback(async () => {
    await Promise.all([loadDevices(false), loadMembers()]);
  }, [loadDevices, loadMembers]);

  useEffect(() => {
    void reloadAll();
  }, [reloadAll]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadDevices(true);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [loadDevices]);

  return {
    devices,
    cacheState,
    members,
    loading,
    listErrorKey,
    membersErrorKey,
    reloadAll,
    markMutation,
    applyDevice: (updated: RegisteredDevice) => {
      mutations.current += 1;
      setDevices((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    },
    removeDevice: (id: string) => {
      mutations.current += 1;
      setDevices((prev) => prev.filter((d) => d.id !== id));
    },
    addDevice: (device: RegisteredDevice) => {
      mutations.current += 1;
      setDevices((prev) => [...prev, device]);
    },
    attemptedBlockTarget: attempted,
    setAttemptedBlockTarget: (id: string, target: boolean) =>
      setAttempted((prev) => ({ ...prev, [id]: target })),
  };
}

export type NetworkDevicesData = ReturnType<typeof useNetworkDevicesData>;
```

- [ ] **Step 4:** Add the i18n keys the helpers/hook reference (`networkDevices.error.managementRequired`) in Task 2 first if `tsc` complains; tests do not need them. Run `npx vitest run tests/client/network-devices-data.test.ts`, expect PASS.
- [ ] **Step 5: Commit** `feat(admin): add the network devices data hook` (message in English, no secrets). Do not run `format` repo-wide; run `npx prettier --write <changed files>`.

## Task 2: i18n keys

**Files:**

- Modify: `src/client/i18n/messages.ts` (en near lines 1127-1285, es near 2413-2564)

- [ ] **Step 1:** Change VALUES of existing keys (en then es), keys unchanged:
  - `networkDevices.management.title`: "Network devices" / "Dispositivos de red"
  - `networkDevices.management.description`: "Register family devices and control their internet access." / "Registra los dispositivos de la familia y controla su acceso a internet."
  - `networkDevices.action.register`: "Add device" / "Añadir dispositivo"
  - `networkDevices.picker.select`: "Add" / "Añadir"
- [ ] **Step 2:** Add the new keys listed in spec section 7 as one block per locale headed by `// admin-network-devices`, at the end of that locale's admin keys. Use the exact keys and English/Spanish strings from the spec, except replace `networkDevices.discover.sortBy` with the template `"Sort by {column}"` / `"Ordenar por {column}"` (interpolated with `.replace`).
      Locate "end of the existing admin keys" by searching for the last `admin.`/`networkDevices.`-adjacent block in each locale; other workers add their own `// admin-<page>` blocks near the end of the same area, so keep yours contiguous and self-contained to keep merge conflicts mechanical.
- [ ] **Step 3:** `npx vitest run tests/client/network-devices-i18n-parity.test.ts` PASS; `npx tsc -b` has no new errors from keys.
- [ ] **Step 4: Commit** `feat(admin): add network devices admin strings`.

## Task 3: Status presentation (`DeviceStatus.tsx`)

**Files:**

- Create: `src/client/admin/network-devices/DeviceStatus.tsx`
- Test: extended in Task 6 through the component tests (existing status assertions)

**Interfaces:**

- Produces: `export function DeviceStatus(props: { device: RegisteredDevice; cacheState: LiveCacheState | null; attemptedBlockTarget?: boolean }): JSX.Element` and `export function MemberLabel(props: { device: RegisteredDevice }): JSX.Element`.
- Consumes: `useTranslation` from `@/i18n` (`{ t, language }`), `cn` from `@/lib/utils`.

- [ ] **Step 1: Write** `DeviceStatus.tsx` by moving `cacheStateMessageKey`, `DeviceStatusBadges`, `MemberLabel`, `formatLastSeen` out of the old file with these changes (keep ALL the old docblocks about divergence and last-seen):
  - Rename `DeviceStatusBadges` to `DeviceStatus`; take no `t` prop, call `useTranslation()` inside (it already does for `language`); `MemberLabel` likewise.
  - Dot (decorative): wrap in `<span aria-hidden="true">`. `liveStatus === "online"`: `<span className={cn("inline-block size-2.5 rounded-full", device.isBlocked ? "bg-destructive" : "bg-success")} />`; `unknown`: same span with `bg-muted-foreground`; `notDetected`: `<span className="text-foreground">⚠</span>`.
  - Chips replace the " · " joins: `<span className="rounded-full border px-2 py-0.5 text-xs">{label}</span>` for the live-status label and for the block badge; `last seen` and `cache state` stay as muted text spans (`text-muted-foreground`). Keep the container testid `network-devices-status-${device.id}` and keep the rule that last-seen is NEVER shown for `online`.
  - Layout: `flex flex-wrap items-center gap-2`.
- [ ] **Step 2:** `npx tsc -b` compiles (file is not yet used; fine).
- [ ] **Step 3: Commit** `feat(admin): add the network device status dot and chips`.

## Task 4: Registered devices tab (`RegisteredDevices.tsx`)

**Files:**

- Create: `src/client/admin/network-devices/RegisteredDevices.tsx`

**Interfaces:**

- Consumes: `NetworkDevicesData` and helpers from `./data`, `DeviceStatus`/`MemberLabel` from `./DeviceStatus`.
- Produces: `export function RegisteredDevices(props: { data: NetworkDevicesData; onAdd: () => void }): JSX.Element`.

Behaviour (port the logic of the old `saveEdit`, `deleteDevice`, `toggleBlock` verbatim except as stated):

- Renders: `<ErrorNotice message={listError} data-testid="network-devices-error" />` where `listError = data.listErrorKey ? t(data.listErrorKey) : null`; when `listError` is set also `<Button type="button" variant="secondary" onClick={() => void data.reloadAll()} data-testid="network-devices-retry">{t("networkDevices.action.retry")}</Button>`; `<ErrorNotice ... data-testid="network-devices-members-error" />` for `membersErrorKey`.
- Empty (no `listError`, no devices): `<p data-testid="network-devices-empty">{t("networkDevices.management.empty")}</p>` followed by `<Button type="button" variant="link" onClick={onAdd} data-testid="network-devices-empty-add">{t("networkDevices.management.emptyAdd")}</Button>`. Both inside one wrapper.
- List: `<ul data-testid="network-devices-list">`, rows `li data-testid="network-devices-row-${id}"` with `flex flex-wrap items-start justify-between gap-2`. Left: `<strong data-testid="network-devices-alias-${id}">`, `<DeviceStatus .../>`, `<MemberLabel .../>`. Right: three text buttons, same testids and labels as before: Edit (`network-devices-edit-${id}`, variant outline), Block/Unblock (`network-devices-toggle-block-${id}`, variant outline, busy labels as before), Delete (`network-devices-delete-${id}`, variant destructive). Row `ErrorNotice` `network-devices-row-error-${id}` stays.
- Block/unblock: same code as old `toggleBlock`, plus `data.markMutation()` before the request, `data.applyDevice(updated)` and `data.setAttemptedBlockTarget(device.id, targetIsBlocked)` on success; 502 still maps via `controllerErrorMessageKey(await parseErrorCode(response))`.
- Edit Dialog (state `editing: RegisteredDevice | null`, `draft {alias, memberId}`, `savingEdit`, `editError`):
  ```tsx
  <Dialog open={editing !== null} onOpenChange={(open) => { if (!open && !savingEdit) closeEdit(); }}>
    <DialogContent closeLabel={t("networkDevices.action.cancel")} data-testid="network-devices-edit-dialog" className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t("networkDevices.edit.title")}</DialogTitle>
        <DialogDescription className="sr-only">{t("networkDevices.edit.description")}</DialogDescription>
      </DialogHeader>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void saveEdit(); }}>
        <ErrorNotice message={editError} data-testid="network-devices-edit-error" />
        <Field label={t("networkDevices.picker.aliasLabel")}>
          <Input type="text" maxLength={80} value={draft.alias} onChange=... data-testid={`network-devices-edit-alias-${editing.id}`} />
        </Field>
        <Field label={t("networkDevices.picker.memberLabel")}>
          <select className={NATIVE_SELECT_CLASSES} value={draft.memberId} onChange=... data-testid={`network-devices-edit-member-${editing.id}`}>...</select>
        </Field>
        <div className="flex gap-2">Save (type=submit, disabled={savingEdit}, testid `network-devices-save-${id}`) and Cancel (type=button, variant outline, `network-devices-cancel-edit-${id}`)</div>
      </form>
    </DialogContent>
  </Dialog>
  ```
  Copy the member `<option>` logic from the old edit block unchanged (blank "No member" option, disabled option for an inactive current member, disabled option when the members read failed, then `data.members`). `saveEdit`: trim alias; blank gives `setEditError(t("networkDevices.error.aliasRequired"))` and returns; PATCH body `{alias, memberId: draft.memberId === "" ? null : draft.memberId}`; success `data.applyDevice(updated)` then close; failure `setEditError(t("networkDevices.error.editGeneric"))`. Guard `editing` being non-null before rendering testids (render `DialogContent` children only when `editing`). Radix needs a Dialog title always present: keep `DialogTitle` outside the conditional.
- Delete: `deleting: RegisteredDevice | null` set by the Delete button, then
  ```tsx
  <ConfirmDialog
    open={deleting !== null}
    onOpenChange={(open) => {
      if (!open) setDeleting(null);
    }}
    title={t("networkDevices.delete.title")}
    description={
      deleting && (deleting.isBlocked || deleting.beliefDiverged)
        ? t("networkDevices.action.deleteConfirmBlocked")
        : t("networkDevices.action.deleteConfirm")
    }
    confirmLabel={t("networkDevices.action.delete")}
    cancelLabel={t("networkDevices.action.cancel")}
    confirmTestId="network-devices-delete-confirm"
    onConfirm={() => deleting && void deleteDevice(deleting)}
  />
  ```
  `deleteDevice` = old body minus `window.confirm`; `data.markMutation()` first; 404 still counts as success; success `data.removeDevice(id)`.
- Keep the old comments explaining WHY (stronger warning when divergent; 404 as success).

- [ ] **Step 1:** Write the file. **Step 2:** `npx tsc -b` has no errors in it. **Step 3: Commit** `feat(admin): add the registered network devices tab`.

## Task 5: Discover and register tab (`DiscoverDevices.tsx`)

**Files:**

- Create: `src/client/admin/network-devices/DiscoverDevices.tsx`

**Interfaces:**

- Consumes: `NetworkDevicesData`, `LoadFailure`, `loadFailureMessageKey`, `parseErrorCode` from `./data`; `LiveClient`, `LiveCacheState`, `LiveClientsResponse` from shared.
- Produces: `export function DiscoverDevices(props: { data: NetworkDevicesData; onRegistered: () => void }): JSX.Element`.
- Pure helper exported for tests: `export function sortClients(clients: LiveClient[], key: "name" | "mac", dir: "asc" | "desc", language: string): LiveClient[]` (stable copy; name sort uses `(a.displayName ?? "")`, unnamed clients LAST for both directions of name sort; MAC sort plain string compare).
- Also exported: `export function initialAlias(client: LiveClient): string` returning `(client.displayName ?? "").trim().slice(0, 80)`.

Behaviour:

- On mount and on Refresh (`network-devices-discover-refresh`, `Button variant="outline"`, label `networkDevices.action.refresh`): `GET /api/network-devices/live-clients`; state `{phase:"loading"} | {phase:"loadError"; key: MessageKey} | {phase:"ready"; state; clients}`. Non-ok: `new LoadFailure(status, code)` mapped with `loadFailureMessageKey(status, code, "networkDevices.error.pickerLoadError")`.
- Wrapper `<section aria-labelledby=... data-testid="network-devices-picker">` with `h3` = `networkDevices.picker.title`, description `networkDevices.picker.description` (keep the old rationale comment about not nesting an `AdminPanel`).
- Exactly one of: loading (`network-devices-picker-state`, `networkDevices.picker.state.loading`); load error (`ErrorNotice` testid `network-devices-picker-state` plus Retry button `network-devices-picker-retry`); non-fresh state message (`network-devices-picker-state`, the four existing `networkDevices.picker.state.*` keys); `fresh` with zero clients shows `freshEmpty` text; otherwise the table.
- Table `data-testid="network-devices-picker-clients"`: header cells `th scope="col" aria-sort={ascending|descending|none}` each containing a `Button variant="ghost" size="sm"` (`network-devices-sort-name` / `network-devices-sort-mac`, accessible text = the column label, plus visible arrow `↑`/`↓`/`↕`, with `aria-label={t("networkDevices.discover.sortBy").replace("{column}", label)}`); third column header visually hidden (`<span className="sr-only">` with `networkDevices.picker.select`). Rows `<tr data-testid={`network-devices-picker-client-${client.mac}`}>`: name cell (`client.displayName ?? t("networkDevices.picker.unnamedDevice")`), MAC cell (`font-mono`), action cell. Registered MACs: `const registered = new Set(data.devices.map((d) => d.mac.toLowerCase()))`; a registered row has `className="opacity-50"` and an "Already added" badge (`networkDevices.discover.alreadyAdded`, testid `network-devices-picker-added-${client.mac}`) instead of the button; others have `Button size="sm"` (`network-devices-picker-select-${client.mac}`, label `networkDevices.picker.select`). Wrap the table in `overflow-x-auto`.
- Register Dialog (`selected: LiveClient | null`): title `networkDevices.register.title`, description `networkDevices.register.description` (visible, small), `data-testid="network-devices-register-dialog"`, NO MAC anywhere. Fields: `Field` alias (`Input`, `maxLength={80}`, `placeholder={t("networkDevices.picker.aliasPlaceholder")}`, testid `network-devices-picker-alias-input`) prefilled with `initialAlias(client)`; `Field` member select (`NATIVE_SELECT_CLASSES`, testid `network-devices-picker-member-select`, options "No member" + `data.members`); `ErrorNotice` testid `network-devices-picker-error`; Submit (`network-devices-picker-submit`, label `networkDevices.picker.submit` / `.submitting`, disabled while submitting) and Cancel (`network-devices-picker-cancel`).
- Submit: same as old `submit()` (blank alias gives `aliasRequired`; POST `{mac: selected.mac, alias, memberId}`; 409 `reselect_required` / `duplicate_mac` / generic messages as before). Changes: `data.markMutation()` before the request; on 409 `reselect_required` ALSO call `loadClients()` so the table refreshes; on success `data.addDevice(device)`, close the dialog, call `onRegistered()`.
- Keep the old comment that the MAC is the picker's only identity signal before an alias exists (FR-015 scope).

- [ ] **Step 1: Write failing unit tests** for the two pure helpers. Add a `describe("discovery helpers")` block to `tests/client/network-devices-management.test.tsx` (new titles are fine; import `sortClients` and `initialAlias` from `@/admin/network-devices/DiscoverDevices`):

```ts
describe("discovery helpers", () => {
  const c = (mac: string, displayName: string | null): LiveClient => ({
    mac,
    displayName,
    isBlocked: false,
  });
  it("sorts by name ascending with unnamed clients last, in either direction", () => {
    const list = [c("bb", null), c("aa", "Zed"), c("cc", "Amy")];
    expect(sortClients(list, "name", "asc", "en").map((x) => x.mac)).toEqual(["cc", "aa", "bb"]);
    expect(sortClients(list, "name", "desc", "en").map((x) => x.mac)).toEqual(["aa", "cc", "bb"]);
  });
  it("sorts by MAC and does not mutate its input", () => {
    const list = [c("bb:00", "x"), c("aa:00", "y")];
    expect(sortClients(list, "mac", "asc", "en").map((x) => x.mac)).toEqual(["aa:00", "bb:00"]);
    expect(list[0].mac).toBe("bb:00");
  });
  it("prefills the alias from the client name, empty for unnamed, cut to 80 chars", () => {
    expect(initialAlias(c("a", "Marta's iPad"))).toBe("Marta's iPad");
    expect(initialAlias(c("a", null))).toBe("");
    expect(initialAlias(c("a", "x".repeat(100)))).toHaveLength(80);
  });
});
```

Run it, see it fail (module missing), then write the file, then see it pass.

- [ ] **Step 2: Commit** `feat(admin): add the network device discovery tab`.

## Task 6: Entry component and wiring

**Files:**

- Modify (rewrite): `src/client/admin/NetworkDevicesManagement.tsx` (same path, same `NetworkDevicesManagement` export; keep the module header doc, updated: tabs are local state, delete uses `ConfirmDialog`).

Contents:

```tsx
export function NetworkDevicesManagement() {
  const { t } = useTranslation();
  const data = useNetworkDevicesData();
  const [tab, setTab] = useState<"registered" | "add">("registered");

  if (data.loading && tab === "registered") {
    return (
      <AdminPanel title={t("networkDevices.management.title")}>
        <p className="text-muted-foreground text-control">
          {t("networkDevices.management.loading")}
        </p>
      </AdminPanel>
    );
  }
  return (
    <AdminPanel
      title={t("networkDevices.management.title")}
      description={t("networkDevices.management.description")}
      data-testid="network-devices-management"
      actions={
        tab === "registered" ? (
          <Button
            type="button"
            data-testid="network-devices-open-picker"
            onClick={() => setTab("add")}
          >
            {t("networkDevices.action.register")}
          </Button>
        ) : undefined
      }
    >
      <div
        role="tablist"
        aria-label={t("networkDevices.tabs.label")}
        className="flex w-fit gap-1 rounded-lg border bg-muted p-1"
      >
        {/* two Button role="tab": variant default when selected else ghost, aria-selected, testids network-devices-tab-registered / network-devices-tab-add, labels networkDevices.tabs.registered / networkDevices.tabs.add */}
      </div>
      {tab === "registered" ? (
        <RegisteredDevices data={data} onAdd={() => setTab("add")} />
      ) : (
        <DiscoverDevices data={data} onRegistered={() => setTab("registered")} />
      )}
    </AdminPanel>
  );
}
```

Important: the loading early-return must not hide the "Add device" button after a load error (it only shows while `data.loading`); `data.loading` is false once the first load settles (including failure), which keeps the primary control reachable with a 403.

- [ ] **Step 1:** Rewrite the file as above (delete the moved code, helper functions, and the stale comment block about "inline modal panel").
- [ ] **Step 2:** `npx tsc -b` and `npx eslint src/client/admin` clean.
- [ ] **Step 3:** Run the old tests to see what breaks (expected: the ones pinned in Task 7): `npx vitest run tests/client/network-devices-management.test.tsx tests/client/network-weather-admin.test.tsx tests/client/admin-gate-panel-reset.test.tsx`.
- [ ] **Step 4: Commit** `feat(admin): rebuild the network devices page with tabs and dialogs`.

## Task 7: Update and extend component tests (TDD against the new behaviour)

**Files:**

- Modify: `tests/client/network-devices-management.test.tsx`, `tests/client/network-weather-admin.test.tsx`
- Verify unchanged-green: `tests/client/admin-gate-panel-reset.test.tsx`, `tests/client/network-devices-i18n-parity.test.ts`

Edits to `network-devices-management.test.tsx` (keep titles; test ids with an id suffix are intentionally kept):

- Edit tests (`PATCH updates alias/member`, `the MAC-shape scan ALSO holds once a row enters edit mode`, `editing a device linked to an INACTIVE member`, `edit: with a failing members load...`): the form is now in a Dialog rendered in a portal, so query with `screen`/`document.body` instead of a container, and for the MAC-shape scan assert on `document.body.textContent`. The testids `network-devices-edit-alias-<id>`, `-edit-member-<id>`, `-save-<id>`, `-cancel-edit-<id>` are unchanged.
- Delete tests (`delete: ... BLOCKED ...`, `delete: cancelling ...`, `delete: a device with isBlocked=false + beliefDiverged=true ...`): remove `vi.spyOn(window, "confirm")`; click `network-devices-delete-<id>`, then assert the dialog text (`messages.en["networkDevices.action.deleteConfirmBlocked"]` or `deleteConfirm`) is visible and click `network-devices-delete-confirm` (or the Cancel button, name `messages.en["networkDevices.action.cancel"]`, and assert no DELETE fetch).
- Picker tests: `fireEvent.click(getByTestId("network-devices-open-picker"))` now switches to the Add tab and everything under `network-devices-picker*` is unchanged. The "state=fresh renders the client list" test now sees a table (the regexp queries still work). `register: a successful submission adds the device to the list and closes the picker`: after submit, assert the Registered tab is active (`network-devices-tab-registered` has `aria-selected="true"`), the dialog is gone, and the new alias is in `network-devices-list`.
- The load error test (`list` 500): also assert `network-devices-retry` exists.
- Time-sensitive `formats last-seen` etc: unchanged.

New tests to add (new titles, same file; reuse `mockRouter`, `device`, `member`, `jsonResponse`):

```tsx
it("a scope-denied 403 on the list shows the management-required message, Retry, and keeps the add button", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(
    mockRouter({
      onDevicesList: () => jsonResponse({ error: "forbidden", code: AUTH_SCOPE_DENIED_CODE }, 403),
    })
  );
  renderManagement();
  expect(await screen.findByTestId("network-devices-error")).toHaveTextContent(
    messages.en["networkDevices.error.managementRequired"]
  );
  expect(screen.getByTestId("network-devices-retry")).toBeInTheDocument();
  expect(screen.getByTestId("network-devices-open-picker")).toBeInTheDocument();
  expect(screen.queryByTestId("network-devices-empty")).not.toBeInTheDocument();
});

it("Retry reloads the list after a failure", async () => {
  let fail = true;
  vi.mocked(globalThis.fetch).mockImplementation(
    mockRouter({
      devices: [device()],
      onDevicesList: () =>
        fail ? jsonResponse(null, 500) : jsonResponse({ devices: [device()], cacheState: "fresh" }),
    })
  );
  renderManagement();
  fireEvent.click(await screen.findByTestId("network-devices-retry"));
  fail = false;
  // (click again after flipping, or flip before clicking: the first load already failed)
  await screen.findByTestId("network-devices-list");
});

it("the page heading equals the sidebar label", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(mockRouter({ devices: [] }));
  renderManagement();
  await screen.findByTestId("network-devices-empty");
  expect(
    screen.getByRole("heading", { name: messages.en["admin.sidebar.networkDevices"] })
  ).toBeInTheDocument();
});

it("the empty state links to the Add tab", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(
    mockRouter({ devices: [], liveClients: { state: "fresh", clients: [] } })
  );
  renderManagement();
  fireEvent.click(await screen.findByTestId("network-devices-empty-add"));
  expect(screen.getByTestId("network-devices-tab-add")).toHaveAttribute("aria-selected", "true");
});

it("shows a green/red/muted dot or a warning glyph per state, with the text label still present", async () => {
  // devices: online, online+blocked, unknown, notDetected; assert each status container
  // contains its text label; assert the dot class contains bg-success / bg-destructive / bg-muted-foreground
  // for the first three and the "⚠" glyph for the fourth.
});

it("Add tab: already-registered MACs (compared case-insensitively) are dimmed with an Already added badge and no Add button", async () => {
  vi.mocked(globalThis.fetch).mockImplementation(
    mockRouter({
      devices: [device({ mac: MAC.toUpperCase() })],
      liveClients: {
        state: "fresh",
        clients: [
          { mac: MAC, displayName: "Taken", isBlocked: false },
          { mac: "11:22:33:44:55:66", displayName: "Free", isBlocked: false },
        ],
      },
    })
  );
  renderManagement();
  fireEvent.click(await screen.findByTestId("network-devices-open-picker"));
  expect(await screen.findByTestId(`network-devices-picker-added-${MAC}`)).toBeInTheDocument();
  expect(screen.queryByTestId(`network-devices-picker-select-${MAC}`)).not.toBeInTheDocument();
  expect(screen.getByTestId("network-devices-picker-select-11:22:33:44:55:66")).toBeInTheDocument();
});

it("Add tab: sorting by name then MAC reorders the rows and toggles aria-sort", async () => {
  /* click network-devices-sort-mac, read row order via getAllByTestId(/^network-devices-picker-client-/) */
});

it("register dialog prefills the alias from the client name, never shows the MAC, and returns to the list after success", async () => {
  /* select a client, expect the alias input value, expect dialog textContent not to match MAC_SHAPED, submit, expect list tab selected */
});

it("a 403 on live-clients shows the management-required message with Retry", async () => {
  /* ... network-devices-picker-state + network-devices-picker-retry */
});

it("an unnamed client opens the dialog with an empty alias", async () => {
  /* displayName: null */
});
```

Fill the commented bodies with concrete code following the neighbouring tests' style (they are short); do not leave comments in place of assertions. Import `AUTH_SCOPE_DENIED_CODE` and `LiveClient` from `../../src/shared` if missing, and `sortClients`/`initialAlias` from `@/admin/network-devices/DiscoverDevices` for the Task 5 helper block.

Edits to `network-weather-admin.test.tsx`:

- Update the file header comment (it claims `ConfirmDialog` is deliberately not adopted and e2e depends on `window.confirm`): now adopted; the e2e spec drives the ConfirmDialog.
- Test `still confirms delete via window.confirm` (around line 392): rewrite to click delete, assert the ConfirmDialog shows `"Delete this device? This cannot be undone."`, click `network-devices-delete-confirm`, expect the DELETE fetch, and keep the title (rename title to `still confirms delete before deleting (ConfirmDialog)`; titles are in the cohort fixture, resynced in Task 10).
- Density census tests (lines ~210-290): the control counts per phase change (tabs add 2 controls, the "Add device" button moves into the header, rows are unchanged, dialogs are closed). Run, read the failure numbers, confirm each change is explained by the new tabs/Retry button, then update the expected numbers. Do not weaken `assertKioskDensityCompliant`.
- SC-011 error channel tests: keep; the list error is still announced via `ErrorNotice` (testid `network-devices-error`).

- [ ] **Step 1:** Make the edits so the new/changed tests exist; run `npx vitest run tests/client/network-devices-management.test.tsx tests/client/network-weather-admin.test.tsx tests/client/admin-gate-panel-reset.test.tsx tests/client/network-devices-i18n-parity.test.ts tests/client/network-devices-data.test.ts`.
- [ ] **Step 2:** Fix failures. Anything failing that is not explained by this plan is a bug in the new code or an unintended behaviour change: fix the code, not the assertion.
- [ ] **Step 3: Commit** `test(admin): cover the reworked network devices page`.

## Task 8: E2E fixture and spec

**Files:**

- Modify: `tests/e2e/unifi-fixture-server.ts` (two small additions)
- Modify: `tests/e2e/network-devices.spec.ts`

- [ ] **Step 1: Fixture additions.**
  1. `UnifiFixtureClient` gains `isBlocked?: boolean`; initialise the `blocked` map from it: `const blocked = new Map(clients.map((c) => [c.macAddress.toLowerCase(), c.isBlocked ?? false]));`.
  2. `startUnifiFixtureServer(clients, options: { port?: number } = {})`; `server.listen(options.port ?? 0, "127.0.0.1", ...)`. Behaviour with no options is unchanged.
- [ ] **Step 2: Rewrite the spec body** (keep the helpers, server start, cookie dance and docblock; update the docblock's picker/confirm mentions). Replace the flow after `openAdminSection` with:

```ts
// --- Device key is denied: the specific message, not the generic failure (spec section 2) ---
await openAdminSection(page, "admin-nav-network-devices");
await expect(page.getByTestId("network-devices-error")).toHaveText(
  m["networkDevices.error.managementRequired"]
);
// Swap to the management cookie now that the plugin catalog has loaded, then Retry.
await context.addCookies([{ name: "mp_device_key", value: MP_MANAGEMENT_KEY, url: base }]);
await page.getByTestId("network-devices-retry").click();
await expect(page.getByTestId("network-devices-empty")).toBeVisible();
```

This means the existing early `context.addCookies([{ name: "mp_device_key", value: MP_MANAGEMENT_KEY ...}])` (right after the catalog response) must move to the Retry step, BUT the test also polls `/api/network-devices/live-clients` with `page.request` before unlocking admin (needs the management cookie). Resolve: poll with an explicit header-less request using a separate `request` context created via `playwright.request.newContext({ extraHTTPHeaders: { Cookie: \`mp_gate=${gateCookieValue(MP_ACCESS_TOKEN)}; mp_device_key=${MP_MANAGEMENT_KEY}\` } })`, or simply poll after the Retry step. Pick the second: do the 403 assertion and the cookie swap first, then the cache poll, then continue in the UI. Use the order: unlock admin, open section, assert 403 message, swap cookie, Retry, assert empty state, poll the live cache until `fresh`.
Then:

```ts
// --- Add tab: discovery table, sort, register in a dialog ---
await page.getByTestId("network-devices-empty-add").click();
await expect(page.getByTestId("network-devices-picker")).toBeVisible();
const macLower = mac.toLowerCase();
await expect(page.getByTestId(`network-devices-picker-client-${macLower}`)).toBeVisible({
  timeout: 10_000,
});
await page.getByTestId("network-devices-sort-mac").click();
await page.getByTestId(`network-devices-picker-select-${macLower}`).click();
const dialog = page.getByTestId("network-devices-register-dialog");
await expect(dialog).toBeVisible();
await expect(dialog.getByTestId("network-devices-picker-alias-input")).toHaveValue(
  `Fixture ${suffix}`
);
await expect(dialog).not.toContainText(macLower);
await dialog.getByTestId("network-devices-picker-alias-input").fill(alias);
await dialog.getByTestId("network-devices-picker-submit").click();

// Returned to the list, not the Add tab.
await expect(page.getByTestId("network-devices-tab-registered")).toHaveAttribute(
  "aria-selected",
  "true"
);
const row = page.locator("li").filter({ hasText: alias });
await expect(row).toHaveCount(1);

// --- Already added is dimmed on the Add tab ---
await page.getByTestId("network-devices-tab-add").click();
await expect(page.getByTestId(`network-devices-picker-added-${macLower}`)).toBeVisible();
await expect(page.getByTestId(`network-devices-picker-select-${macLower}`)).toHaveCount(0);
await page.getByTestId("network-devices-tab-registered").click();

// --- Edit in a dialog ---
await row.getByRole("button", { name: m["networkDevices.action.edit"] }).click();
const edit = page.getByTestId("network-devices-edit-dialog");
const renamed = `${alias} renamed`;
await edit.locator("input").fill(renamed);
await edit.getByRole("button", { name: m["networkDevices.action.save"] }).click();
await expect(edit).toBeHidden();
await expect(page.getByText(renamed)).toBeVisible();

// --- Block, then delete through the ConfirmDialog (blocked wording) ---
const renamedRow = page.locator("li").filter({ hasText: renamed });
await renamedRow.getByRole("button", { name: m["networkDevices.action.block"] }).click();
await expect(renamedRow.getByText(m["networkDevices.badge.blocked"])).toBeVisible({
  timeout: 10_000,
});
await renamedRow.getByRole("button", { name: m["networkDevices.action.delete"] }).click();
const confirm = page
  .getByRole("alertdialog")
  .or(page.getByRole("dialog"))
  .filter({ hasText: m["networkDevices.action.deleteConfirmBlocked"] });
await expect(confirm).toBeVisible();
await page.getByTestId("network-devices-delete-confirm").click();
await expect(page.getByText(renamed)).toHaveCount(0);
await expect(page.getByTestId("network-devices-empty")).toBeVisible();
```

Remove the old `page.once("dialog", ...)` handler. Use Playwright's exact role from `ConfirmDialog` (read `src/client/components/ConfirmDialog.tsx` to confirm `alertdialog` vs `dialog`; simplify the locator once known). The spec stays a single test with `test.setTimeout(60_000)` (raise to 90_000 if the added steps need it).

- [ ] **Step 3:** Build and run: `npm run build` then
  ```bash
  PORT=43205 npx playwright test tests/e2e/network-devices.spec.ts tests/e2e/admin-unlock-resilience.spec.ts --workers=3
  ```
  Both must pass. `admin-unlock-resilience` needs no edits (it probes `network-devices-open-picker`, which still renders with a device key). If the shared-DB webServer on 43205 is already in use, pick the port from the orchestrator and report it.
- [ ] **Step 4: Commit** `test(e2e): drive the reworked network devices flow`.

## Task 9: Dev fixture for exercising the page without UniFi

**Files:**

- Create: `tools/dev/unifi-fixture.ts`
- Modify: `package.json` (script `"dev:unifi-fixture": "node --import tsx tools/dev/unifi-fixture.ts"`)
- Modify: `tools/dev/browser-session.mjs` (opt-in `--management`)
- Modify: `docs/features/network-devices.md` (local exercise section, Task 10)

- [ ] **Step 1: Write `tools/dev/unifi-fixture.ts`.** Behaviour:
  - `--help`/`-h` prints usage; flags: `--port <n>` (default 0), `--api <origin>` (optional dev server origin), `--no-register`.
  - Loads `.env.local` best effort: `try { process.loadEnvFile(".env.local"); } catch {}`.
  - Starts `startUnifiFixtureServer(DEMO_CLIENTS, { port })` imported from `../../tests/e2e/unifi-fixture-server`. `DEMO_CLIENTS` (locally administered MACs): `02:00:5e:10:00:01 "Homer's iPhone"`, `02:00:5e:10:00:02 "Bart's Tablet"`, `02:00:5e:10:00:03 "Lisa's Chromebook"`, `02:00:5e:10:00:04 "Living Room TV"`, `02:00:5e:10:00:05 "Guest Phone"`, `02:00:5e:10:00:06 ""` (unnamed; verify what `normalize.ts` does with an empty name and use `null`-equivalent if needed).
  - Prints, then keeps running until SIGINT (then `fixture.close()`):
    ```
    UniFi fixture listening on <origin>. Start the dev server in ANOTHER terminal with:
      UNIFI_API_KEY=fixture-key UNIFI_SITE_ID=default UNIFI_HOST=<origin> NODE_EXTRA_CA_CERTS=<certPath> MP_MANAGEMENT_KEY=<key> npm run dev
    ```
    where `<key>` is `process.env.MP_MANAGEMENT_KEY` or a printed default `mpk-local-management-change-me` (matches `.env.example` line 13). Note in the output that the certificate is regenerated on every run, so the dev server must be restarted after restarting this tool, and that `UNIFI_TLS_INSECURE` is not used (Node 24 undici mismatch, see `tests/e2e/unifi-fixture-server.ts`).
  - With `--api <origin>` (and not `--no-register`): authenticate with the COOKIE transport (docs/operations.md: Bearer works only on `/api/plugins*`): header `Cookie: mp_gate=<sha256 hex of MP_ACCESS_TOKEN>; mp_device_key=<MP_MANAGEMENT_KEY>` (use `node:crypto` `createHash("sha256")`; `MP_ACCESS_TOKEN` from env). Poll `GET <api>/api/network-devices/live-clients` every 2 s up to 120 s until `state === "fresh"` (the server poller registers at startup and every 60 s; the dev server must run with the scheduler enabled). Then fetch `GET /api/members`, and for the first four demo clients `POST /api/network-devices` with `{mac, alias, memberId}`, mapping Homer to `demo:member:homer`, Bart to `demo:member:bart`, Lisa to `demo:member:lisa` when that member exists in the list (else null). Treat HTTP 409 (`duplicate_mac`) as "already registered" and continue. Finally `POST /api/network-devices/<id of Bart's Tablet>/block`. Print one line per step. On 401/403 print: "The management key was refused: check MP_MANAGEMENT_KEY and that the dev server was started with it."
  - Marge-style "not detected" rows are not producible this way (registration needs the device in the live cache); say so in `--help`. Unit tests cover that state.
- [ ] **Step 2: `browser-session.mjs --management`:** add to `usage()` text; after the final `page.reload(...)`/`applied` evaluation and before the `console.log(JSON.stringify({type:"session-ready"...}))`, if `process.argv.includes("--management")`: read `MP_MANAGEMENT_KEY` (require it starts with `mpk-`, same error style as the others), then `await context.addCookies([{ name: "mp_device_key", value: managementKey, url: origin }])` and add `management: true` to the logged JSON. Print a note: "Do not reload: /api/plugins* rejects the management cookie; navigate inside the SPA." (Matches the e2e spec's cookie order.)
- [ ] **Step 3: Verify by running it** (this is the proof the mechanism works; there is no unit test for dev tooling):
  1. `mkdir -p .data && DATA_DIR="$PWD/.data" npm run seed`
  2. Terminal A: `npm run dev:unifi-fixture` and copy the printed env.
  3. Terminal B: start the dev server with that env plus `DATA_DIR="$PWD/.data" PORT=3100 WEB_PORT=5273` (these ports are per the project notes; use free ones if taken): `... npm run dev`.
  4. Terminal C: `npm run dev:unifi-fixture -- --api http://127.0.0.1:3100` is not possible while A runs (port/cert). So instead run step 2 with the flag from the start: `npm run dev:unifi-fixture -- --api http://127.0.0.1:3100` (it waits for the API to come up, retrying connection errors until the 120 s limit).
  5. Confirm with curl using the cookie header that `GET /api/network-devices` returns four devices, one blocked, `cacheState: "fresh"`. Then browse (`npm run dev:session -- --management`, or Playwright) to `/admin/network-devices`, unlock the PIN, and confirm the list renders with a green, a red and a muted state. Stop all three processes. Record what you saw in your final report. If the dev server cannot be started in the environment, say so explicitly rather than claiming it works.
- [ ] **Step 4:** `npx tsc -b` (the tool is TypeScript under `tools/dev`; if `tsconfig` does not include it, `npx tsc --noEmit -p tsconfig.server.json` may not cover it; run `npx eslint tools/dev/unifi-fixture.ts` and fix lint) and `npx prettier --check tools/dev package.json`.
- [ ] **Step 5: Commit** `feat(dev): add a UniFi fixture to exercise network devices without a controller`.

## Task 10: Docs and cohort fixture

**Files:**

- Modify: `docs/features/network-devices.md`, `docs/ui/household-contract.md`, `tests/fixtures/assembly-cohort.json`

- [ ] **Step 1: `docs/features/network-devices.md`.** Add a section "### Admin console" under Functional Requirements with next free ids (grep `docs/` for `FR-019` first; if taken pick the next free range) stating, in the file's existing "Given/when/then" style: tabs (Registered devices, Add device); status dot and chips with the text label as carrier; 30 s silent refresh paused when hidden and never overwriting a newer local action; edit and register in dialogs, MAC never shown in dialogs; delete through a confirmation dialog naming the stranded upstream block; Add tab dims already-registered MACs; scope-denied 403 shows a specific message; Retry on load errors. Add "### Exercising the page without a controller" documenting: the e2e fixture, `npm run dev:unifi-fixture` usage (order: fixture first, then dev server with the printed env, cookie swap with `dev:session -- --management`, no reload), and the limitation (no `notDetected` row via registration).
- [ ] **Step 2: `docs/ui/household-contract.md`** line 11 entry: `11. \`/admin/network-devices\` — network devices (Registered devices and Add device tabs)`. Nothing else.
- [ ] **Step 3: Cohort fixture.** Commit first (check:standard needs a clean committed tree). Then run `npm run check:standard` once. It will fail in `check:preflight`/`check:coverage`/`check:test-cohorts:standard` because of: (a) `coveragePolicy.files` entry for `src/client/admin/NetworkDevicesManagement.tsx` now exceeding the file (totals shrank) and no entries for the four new files `src/client/admin/network-devices/{data.ts,DeviceStatus.tsx,RegisteredDevices.tsx,DiscoverDevices.tsx}`; (b) `testCohorts.runners.vitest.files` and `.playwright.files` test titles (new/renamed titles for `tests/client/network-devices-management.test.tsx`, `tests/client/network-weather-admin.test.tsx`, the new `tests/client/network-devices-data.test.ts`, and `tests/e2e/network-devices.spec.ts`). Resync by hand, exactly as commit `844eed79` did (`git show 844eed79 -- tests/fixtures/assembly-cohort.json` for the shape): add the new source files with `{"layer":"client","minimumTotals":{...},"minimumRates":{...}}` taken from the measured values in `coverage/coverage-final.json` (the check prints which values it measured), lower a reviewed minimum for `NetworkDevicesManagement.tsx` only to the measured value, and list each new test title as `"<describe name> <test title>"` (compare with existing entries around line 3575 of the fixture). Do not touch other files' entries or `candidate` stamps unless the tool says so. Commit `chore: resync the reviewed inventory for the network devices rework`.
- [ ] **Step 4:** If `check:ui-catalog` complains, run its generator as its message states and include the output in the commit.

## Task 11: Verification gate and handoff

- [ ] **Step 1:** Clean committed tree (`git status` shows nothing). Run `npm run check:standard`. It must pass. Common fixes: `npx prettier --write <files>` for `format:check`; `check:ui-debt` (replace any raw palette class/inline style with a semantic token); `check:accessible-names` (add `aria-label`/text to unnamed controls; sort buttons and the hidden third column header are the usual suspects); `lint`/`typecheck` errors from moved imports.
- [ ] **Step 2:** `npm run build` (check:standard already builds) then
  ```bash
  PORT=43205 npx playwright test tests/e2e/network-devices.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/plugin-lifecycle-visual.spec.ts --workers=3
  ```
  All must pass. If `plugin-lifecycle-visual` fails for a reason unrelated to network devices (check by running it on the base commit), report it, do not hide it.
- [ ] **Step 3: Commit on the worktree branch and report.** Commit any remaining fixes on the worktree branch (never push, never touch `main`). Your final report must contain: branch name and commit list; the evidence lines from `check:standard` (last lines) and the Playwright summary with the PORT used; what you saw when exercising `dev:unifi-fixture` (or that you could not); any deviation from this plan with reasons; and the coordination notes below.
      Coordination notes to include verbatim: (1) tabs are local state because `Shell.tsx`'s `AdminUnlockRouteReset` relocks the admin on any non-exact `/admin/*` path (`resolveHouseholdRoute`); sub-routes for any page need prefix matching in `src/client/shell/routes.ts` first. (2) `networkDevices.management.title` now equals the sidebar label. (3) Page is reachable only with the management key cookie (spec section 9 open question).
      Note for the orchestrator: if your worktree cannot run git (see memory "Subagent worktrees cannot run git"), skip commits and instead produce a patch file of all changes and report its path.

---

## Self-review (done by the plan author)

- Spec coverage: diagnosis and message (Tasks 1, 2, 4, 5, 7, 8, 10); tabs (6); dot/chips (3); 30 s refresh (1); edit Dialog (4); ConfirmDialog (4); empty-state link (4); Retry (4, 5); sortable discovery, Already added, register dialog with prefilled alias and return to list (5, 6, 7, 8); keep cache states, confirming badges, error taxonomy (3, 4, 5); fixtures and exercise (8, 9); i18n (2); docs (10); gate (11). No backend change, so no OpenAPI/migration tasks.
- Names used consistently: `NetworkDevicesData`, `useNetworkDevicesData`, `loadFailureMessageKey`, `LoadFailure`, `sortClients`, `initialAlias`, testids listed in Tasks 4, 5, 6.
- Known soft spots the executor must resolve by reading code, not guessing: exact `ConfirmDialog` role for the e2e locator; whether `normalize.ts` accepts an empty fixture name; the `tools/dev` TypeScript lint/tsconfig coverage; how many controls the density tests count after the rework.
