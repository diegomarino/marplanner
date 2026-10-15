import { useCallback, useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import type { MessageKey } from "@/i18n/messages";
import type {
  LiveCacheState,
  Member,
  NetworkDevicesListResponse,
  RegisteredDevice,
} from "../../../shared";

/** Background refresh cadence. The server poller runs every 60 s and the cache is fresh for 5 min. */
export const REFRESH_MS = 30_000;

export async function parseErrorCode(response: Response): Promise<string | undefined> {
  const data = (await response.json().catch(() => null)) as { code?: unknown } | null;
  return typeof data?.code === "string" ? data.code : undefined;
}

/** The three 502 controller-degradation states (`NetworkDeviceControllerUnavailableError` /
 * `ControllerRejectedError` / `ControllerUnreachableError` in
 * `src/server/modules/network-devices/index.ts`) each carry their OWN machine `code`
 * (`controller_unavailable`/`controller_rejected`/`controller_unreachable`) — the route's
 * `sendError` forwards it on 502 the same way it already does on 409 (see the error-mapping
 * docblock in `src/server/routes/network-devices.ts`). An absent or unrecognized code — e.g.
 * this endpoint 502ing for a reason this client doesn't know about yet — falls back to a
 * NEUTRAL generic message, deliberately NEVER `controllerUnavailable`: the spec's
 * unset-vs-rejected edge case ("Unset vs unset credentials") is exactly the conflation an
 * unconditional "not configured" fallback would reintroduce.
 */
export function controllerErrorMessageKey(code: string | undefined): MessageKey {
  if (code === "controller_unavailable") return "networkDevices.error.controllerUnavailable";
  if (code === "controller_rejected") return "networkDevices.error.controllerRejected";
  if (code === "controller_unreachable") return "networkDevices.error.controllerUnreachable";
  return "networkDevices.error.controllerGeneric";
}

/** Registry + members reads with a silent 30 s refresh.
 *
 * Two INDEPENDENT reads: the members read feeds only the optional assignment select, so a
 * failure there degrades just that affordance (its own `membersErrorKey`) and never blocks the
 * registry from rendering. Errors are stored as KEYS, so the hook needs no `t` and its callbacks
 * stay stable. */
export function useNetworkDevicesData() {
  const [devices, setDevices] = useState<RegisteredDevice[]>([]);
  const [cacheState, setCacheState] = useState<LiveCacheState | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [listErrorKey, setListErrorKey] = useState<MessageKey | null>(null);
  const [membersErrorKey, setMembersErrorKey] = useState<MessageKey | null>(null);
  // The AUTHORITATIVE target of the most recent LOCAL block/unblock action, keyed by device id.
  // A load-time divergent row has no entry and renders a neutral "confirming" label.
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
      if (!response.ok) throw new Error(`list devices: ${response.status}`);
      const data = (await response.json()) as NetworkDevicesListResponse;
      if (silent && mutations.current !== startedAt) return;
      setDevices(data.devices);
      setCacheState(data.cacheState);
      setListErrorKey(null);
    } catch {
      if (silent) return; // keep the last data; the next tick retries
      setListErrorKey("networkDevices.management.loadError");
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
