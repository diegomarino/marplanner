import { appPathname } from "@/lib/base-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  authFetch,
  bumpCredentialGeneration,
  CREDENTIAL_LOST_EVENT,
  clearProvisionedMarker,
  reportCredentialLoss,
} from "@/lib/credential";
import { AUTH_CREDENTIAL_INVALID_CODE, AUTH_SCOPE_DENIED_CODE } from "../../src/shared";

/** FR-013 — stale `mp_provisioned` marker after device-key revoke/expiry.
 * `authFetch` is the mechanism the shell's authenticated calls (AdminGate's
 * verify-pin, MemberCreateForm's member create) route through: on a 401/403
 * it must clear the marker cookie and notify listeners via
 * `CREDENTIAL_LOST_EVENT`, without altering the response seen by the caller.
 */
describe("authFetch / reportCredentialLoss (FR-013)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    document.cookie = "mp_provisioned=1; path=/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearProvisionedMarker();
  });

  it("clears the mp_provisioned marker and dispatches CREDENTIAL_LOST_EVENT on 401", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    const res = await authFetch("/api/auth/verify-pin", { method: "POST" });

    expect(res.status).toBe(401);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it("clears the mp_provisioned marker and dispatches CREDENTIAL_LOST_EVENT on 403", async () => {
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    await authFetch("/api/members", { method: "POST" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it("does NOT clear the marker or dispatch on a successful (2xx) response", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ match: true }), { status: 200 }));
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    await authFetch("/api/auth/verify-pin", { method: "POST" });

    expect(listener).not.toHaveBeenCalled();
    expect(document.cookie).toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it("preserves provisioning and passes through 429 without retrying or reporting credential loss", async () => {
    const response = new Response(JSON.stringify({ error: "too_many_requests" }), {
      status: 429,
      headers: { "Retry-After": "8" },
    });
    mockFetch.mockResolvedValueOnce(response);
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);
    try {
      expect(await authFetch("/api/settings")).toBe(response);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(document.cookie).toContain("mp_provisioned=1");
      expect(listener).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({ error: "too_many_requests" });
    } finally {
      window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
    }
  });

  it("reportCredentialLoss clears the marker and dispatches the event directly", () => {
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    reportCredentialLoss();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });
});

/** — a scope-403 (the key is LIVE, this specific request is merely denied on scope
 * grounds) must NOT be treated as credential loss. Fixtures below are copied verbatim from
 * the real server response shapes: `AUTH_SCOPE_DENIED_CODE` bodies from
 * `requireManagementKey`/`requireCapability` (src/server/auth/capability.ts, exercised by
 * tests/boundary/network-devices-auth.test.ts and tests/boundary/telemetry-capability.test.ts),
 * `AUTH_CREDENTIAL_INVALID_CODE` bodies from `authBoundary` (src/server/auth/boundary.ts,
 * exercised by tests/boundary/network-devices-auth.test.ts's revoked-key assertion).
 */
describe("authFetch — scope-403 vs credential-invalid (#682)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    document.cookie = "mp_provisioned=1; path=/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearProvisionedMarker();
  });

  it("does NOT clear the marker on a scope-403 (requireManagementKey rejecting a device key, real body shape)", async () => {
    // Verbatim shape of src/server/auth/capability.ts's requireManagementKey 403 —
    // exactly what a kiosk device key gets back opening the Network Devices admin panel.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message: "Device-provisioned keys cannot access management endpoints",
          code: AUTH_SCOPE_DENIED_CODE,
        }),
        { status: 403 }
      )
    );
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    const res = await authFetch("/api/network-devices", { credentials: "include" });

    expect(res.status).toBe(403);
    expect(listener).not.toHaveBeenCalled();
    expect(document.cookie).toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it("does NOT clear the marker on a scope-403 (requireCapability's 'not granted' branch, real body shape)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message: 'Capability "network:admin" not granted',
          code: AUTH_SCOPE_DENIED_CODE,
        }),
        { status: 403 }
      )
    );
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    await authFetch("/api/network-devices", { credentials: "include" });

    expect(listener).not.toHaveBeenCalled();
    expect(document.cookie).toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it("STILL clears the marker on a credential-invalid 403 (revoked key, real authBoundary body shape)", async () => {
    // Verbatim shape of src/server/auth/boundary.ts's revoked-key 403.
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "forbidden",
          message: "API key has been revoked",
          code: AUTH_CREDENTIAL_INVALID_CODE,
        }),
        { status: 403 }
      )
    );
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    await authFetch("/api/members", { credentials: "include" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it("STILL clears the marker on a credential-invalid 401 (invalid key, real authBoundary body shape)", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "unauthorized",
          message: "Invalid API key",
          code: AUTH_CREDENTIAL_INVALID_CODE,
        }),
        { status: 401 }
      )
    );
    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    await authFetch("/api/members", { credentials: "include" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it(
    "does NOT clear the marker on a domain-specific 403 code OTHER than AUTH_SCOPE_DENIED_CODE " +
      "(slice-018 T007 review fold P2-1 — printing's printer_capability_missing, real body shape)",
    async () => {
      // Verbatim shape of src/server/modules/printing/index.ts's PrintCapabilityMissingError,
      // mapped by src/server/routes/printing.ts's handlePrintingError. The credential is live —
      // this session merely never registered a printer capability — so authFetch's generalized
      // "any code other than AUTH_CREDENTIAL_INVALID_CODE passes through" polarity must hold here
      // too, not just for the one AUTH_SCOPE_DENIED_CODE shape originally covered.
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "forbidden",
            message: 'Session "abc123" has no registered printer capability',
            code: "printer_capability_missing",
          }),
          { status: 403 }
        )
      );
      const listener = vi.fn();
      window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

      const res = await authFetch("/api/printing/claim", {
        method: "POST",
        credentials: "include",
      });

      expect(res.status).toBe(403);
      expect(listener).not.toHaveBeenCalled();
      expect(document.cookie).toMatch(/mp_provisioned=1/);

      window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
    }
  );
});

/** FR-013 race guard — a slower request issued under a stale device key can
 * resolve 401/403 AFTER the user has already re-provisioned successfully.
 * `authFetch` must recognize the denial as belonging to a superseded
 * credential generation and ignore it, instead of clearing the freshly-set
 * marker and bouncing the user back to the gate.
 */
describe("authFetch — credential-generation race guard (FR-013)", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    document.cookie = "mp_provisioned=1; path=/";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearProvisionedMarker();
  });

  it("ignores a stale-generation 401 that resolves after a successful re-provision", async () => {
    let resolveFetch!: (res: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    mockFetch.mockReturnValueOnce(pending);

    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    // A slow request goes out under the current (soon-to-be-stale) generation.
    const authFetchPromise = authFetch("/api/members", { method: "POST" });

    // Meanwhile the user re-provisions successfully: the server sets a FRESH
    // marker and the client bumps the credential generation (as Shell's
    // handleProvision now does).
    document.cookie = "mp_provisioned=1; path=/";
    bumpCredentialGeneration();

    // NOW the slow request finally resolves — 401, from the OLD credential.
    resolveFetch(new Response(null, { status: 401 }));
    await authFetchPromise;

    // The stale denial must be ignored: no loss event, fresh marker intact.
    expect(listener).not.toHaveBeenCalled();
    expect(document.cookie).toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });

  it("collapses N concurrent stale-credential denials into exactly one loss event", async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }));

    const listener = vi.fn();
    window.addEventListener(CREDENTIAL_LOST_EVENT, listener);

    await Promise.all([
      authFetch("/api/members", { method: "POST" }),
      authFetch("/api/auth/verify-pin", { method: "POST" }),
      authFetch("/api/members", { method: "GET" }),
    ]);

    // All three were issued under the same (now-lost) generation, and the
    // first one to resolve reports the loss and bumps the generation — the
    // other two must recognize themselves as already-reported, not fire
    // duplicate events.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(document.cookie).not.toMatch(/mp_provisioned=1/);

    window.removeEventListener(CREDENTIAL_LOST_EVENT, listener);
  });
});

describe("runtime subpath credential transport", () => {
  it("prefixes canonical API strings and clears the marker at its mounted cookie path", async () => {
    const meta = document.createElement("meta");
    meta.name = "mp-base-path";
    meta.content = "/family/planner";
    document.head.append(meta);
    const previous = window.location.pathname;
    window.history.replaceState(null, "", "/family/planner/admin");
    document.cookie = "mp_provisioned=1; path=/family/planner/";
    const transport = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", transport);
    try {
      const options = { method: "POST", credentials: "include" as const, body: "payload" };
      await authFetch("/api/settings?mode=full", options);
      expect(transport).toHaveBeenCalledWith("/family/planner/api/settings?mode=full", options);
      const absolute = new Request("https://example.test/api/settings", { method: "GET" });
      await authFetch(absolute);
      expect(transport).toHaveBeenLastCalledWith(absolute);
      window.history.replaceState(null, "", "/outside-the-mount");
      expect(appPathname()).toBe("/outside-the-mount");
      window.history.replaceState(null, "", "/family/planner/admin");
      clearProvisionedMarker();
      expect(document.cookie).not.toContain("mp_provisioned=1");
    } finally {
      clearProvisionedMarker();
      meta.remove();
      window.history.replaceState(null, "", previous);
      vi.unstubAllGlobals();
    }
  });
});
