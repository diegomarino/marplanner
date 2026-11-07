import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/server/app.ts";
import { getDb } from "../../src/server/db/client.ts";
import { hashKey } from "../../src/server/auth/credentials.ts";
import { useIsolatedDb } from "../helpers/db";

/** Default labels for provisioned device keys.
 * An optional `{ label }` body names the key; without one the server derives a hint from the
 * User-Agent so the Admin → Access keys list stays readable. Existing keys are untouched.
 */
describe("provision — device key labels", () => {
  useIsolatedDb();

  const bootstrapKey = "mpk-label-test-bootstrap";
  let previousBootstrap: string | undefined;
  let app: FastifyInstance;

  beforeEach(async () => {
    previousBootstrap = process.env.MP_BOOTSTRAP_KEY;
    process.env.MP_BOOTSTRAP_KEY = bootstrapKey;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'bootstrap', ?)"
      )
      .run("label-bootstrap", hashKey(bootstrapKey), Date.now());
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
    if (previousBootstrap === undefined) delete process.env.MP_BOOTSTRAP_KEY;
    else process.env.MP_BOOTSTRAP_KEY = previousBootstrap;
  });

  /** Today's date in the default household timezone (no locale row is seeded). */
  function householdToday(): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
  }

  function deviceLabels(): Array<string | null> {
    return (
      getDb().prepare("SELECT label FROM api_keys WHERE kind = 'device'").all() as Array<{
        label: string | null;
      }>
    ).map((row) => row.label);
  }

  function provision(options: { headers?: Record<string, string>; payload?: unknown } = {}) {
    return app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: `Bearer ${bootstrapKey}`, ...options.headers },
      ...(options.payload === undefined ? {} : { payload: options.payload as object }),
    });
  }

  it("stores an explicit, trimmed label", async () => {
    const response = await provision({ payload: { label: "  kitchen-pi  " } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provisioned: true });
    expect(deviceLabels()).toEqual(["kitchen-pi"]);
  });

  it("accepts a label of exactly 80 characters", async () => {
    const response = await provision({ payload: { label: "x".repeat(80) } });
    expect(response.statusCode).toBe(200);
    expect(deviceLabels()).toEqual(["x".repeat(80)]);
  });

  it.each([
    ["an empty label", { label: "" }],
    ["a whitespace-only label", { label: "   " }],
    ["an 81-character label", { label: "x".repeat(81) }],
    ["a non-string label", { label: 42 }],
    ["an extra key", { label: "kitchen", scope: "*" }],
    ["an unknown key without label", { name: "kitchen" }],
    ["an array body", ["kitchen"]],
  ])("rejects %s with 400 invalid_label and mints nothing", async (_name, payload) => {
    const response = await provision({ payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_label" });
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(deviceLabels()).toEqual([]);
  });

  it("still refuses a bad bootstrap key with 401 before looking at the label", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/provision",
      headers: { authorization: "Bearer mpk-wrong" },
      payload: { label: "" },
    });
    expect(response.statusCode).toBe(401);
    expect(deviceLabels()).toEqual([]);
  });

  it.each([
    [
      "Safari on iPadOS",
      "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari · iPadOS",
    ],
    [
      "Safari on iOS",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari · iOS",
    ],
    [
      "Safari on macOS",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Safari · macOS",
    ],
    [
      "Chrome on Android",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      "Chrome · Android",
    ],
    [
      "Edge on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      "Edge · Windows",
    ],
    [
      "Firefox on Linux",
      "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
      "Firefox · Linux",
    ],
    ["curl", "curl/8.7.1", "curl · Unknown"],
    ["Node.js fetch", "node", "Node.js · Unknown"],
    ["an unknown client", "Wget/1.21.4", "Unknown · Unknown"],
  ])("labels a key from %s's User-Agent", async (_name, userAgent, prefix) => {
    const response = await provision({ headers: { "user-agent": userAgent } });
    expect(response.statusCode).toBe(200);
    expect(deviceLabels()).toEqual([`${prefix} · ${householdToday()}`]);
  });

  it("labels a key 'Device · <date>' when the User-Agent is missing", async () => {
    // light-my-request sets a default User-Agent; an empty value is how a client omits it.
    const response = await provision({ headers: { "user-agent": "" } });
    expect(response.statusCode).toBe(200);
    expect(deviceLabels()).toEqual([`Device · ${householdToday()}`]);
  });

  it("keeps an empty-body request working exactly as before, with a derived label", async () => {
    const response = await provision({ headers: { "user-agent": "curl/8.7.1" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provisioned: true });
    const cookies = response.headers["set-cookie"] as string[];
    expect(cookies.some((cookie) => cookie.startsWith("mp_device_key=mpk-"))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith("mp_provisioned=1"))).toBe(true);
    expect(deviceLabels()).toEqual([`curl · Unknown · ${householdToday()}`]);
  });

  it("prefers an explicit label over the User-Agent", async () => {
    const response = await provision({
      headers: { "user-agent": "curl/8.7.1" },
      payload: { label: "deploy-box" },
    });
    expect(response.statusCode).toBe(200);
    expect(deviceLabels()).toEqual(["deploy-box"]);
  });

  it("dates the derived label in the household timezone", async () => {
    getDb()
      .prepare("INSERT INTO settings_objects (object_name, data, updated_at) VALUES (?, ?, ?)")
      .run("locale", JSON.stringify({ timezone: "Pacific/Kiritimati" }), Date.now());
    const response = await provision({ headers: { "user-agent": "curl/8.7.1" } });
    expect(response.statusCode).toBe(200);
    const kiritimati = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(
      new Date()
    );
    expect(deviceLabels()).toEqual([`curl · Unknown · ${kiritimati}`]);
  });
});
