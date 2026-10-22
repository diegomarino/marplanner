import { describe, expect, it } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { mainDevicesCli, runDevicesCli } from "../../src/server/auth/devices-cli";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDb, resolveDbPath } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";

/** Operator retirement of one provisioned device credential (docs/operations.md): the retired
 * device is refused on its next request, the other device keeps working, household data stays. */
describe("device credential retirement", () => {
  useIsolatedDb();

  const NOW = Date.parse("2026-10-21T12:00:00Z");

  function insertKey(id: string, key: string, kind = "device") {
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', ?, ?)"
      )
      .run(id, hashKey(key), kind, NOW);
  }

  function cli(...argv: string[]) {
    const lines: string[] = [];
    const code = runDevicesCli(argv, { db: getDb(), nowMs: NOW, out: (line) => lines.push(line) });
    return { code, output: lines.join("\n") };
  }

  it("retires one device while the other and the household data stay intact", async () => {
    insertKey("kitchen", "mpk-kitchen-device-key");
    insertKey("hallway", "mpk-hallway-device-key");
    getDb()
      .prepare(
        "INSERT INTO members (id, display_name, role, created_at, updated_at) VALUES ('m1', 'Alex', 'parent', ?, ?)"
      )
      .run(NOW, NOW);

    expect(cli("label", "kitchen", "Kitchen", "tablet")).toEqual({
      code: 0,
      output: "Labelled kitchen",
    });
    expect(cli("revoke", "kitchen")).toEqual({ code: 0, output: "Revoked kitchen" });
    expect(cli("revoke", "kitchen")).toEqual({ code: 0, output: "kitchen was already revoked" });

    const listed = cli("list");
    expect(listed.code).toBe(0);
    expect(listed.output).toContain("kitchen\tdevice\trevoked");
    expect(listed.output).toContain("Kitchen tablet");
    expect(listed.output).toContain("hallway\tdevice\tactive");
    expect(listed.output).not.toContain(hashKey("mpk-kitchen-device-key"));

    const { buildApp } = await import("../../src/server/app.ts");
    const app = await buildApp();
    try {
      const read = (key: string) =>
        app.inject({ method: "GET", url: "/api/members", cookies: { mp_device_key: key } });
      expect((await read("mpk-kitchen-device-key")).statusCode).toBe(403);
      const hallway = await read("mpk-hallway-device-key");
      expect(hallway.statusCode).toBe(200);
      expect(JSON.parse(hallway.body)).toEqual([expect.objectContaining({ id: "m1" })]);
    } finally {
      await app.close();
    }
  });

  it("keeps the configured bootstrap key, which startup re-activates, but retires stale ones", () => {
    insertKey("boot-current", "mpk-current-bootstrap", "bootstrap");
    insertKey("boot-old", "mpk-old-bootstrap", "bootstrap");
    insertKey("ops", "mpk-management-key", "integration");
    const revoke = (id: string, configuredBootstrap?: string) => {
      const lines: string[] = [];
      const code = runDevicesCli(["revoke", id], {
        db: getDb(),
        nowMs: NOW,
        out: (line) => lines.push(line),
        configuredBootstrap,
      });
      return { code, output: lines.join("\n") };
    };

    expect(revoke("boot-old")).toMatchObject({ code: 1 });
    expect(revoke("boot-old").output).toMatch(/Set MP_BOOTSTRAP_KEY/);
    const current = revoke("boot-current", "mpk-current-bootstrap");
    expect(current.code).toBe(1);
    expect(current.output).toMatch(/change the variable and restart/);

    expect(revoke("boot-old", "mpk-current-bootstrap")).toEqual({
      code: 0,
      output: "Revoked boot-old",
    });
    expect(revoke("ops")).toEqual({ code: 0, output: "Revoked ops" });
    expect(revoke("missing")).toEqual({ code: 1, output: "No credential with id missing" });
    expect(
      getDb().prepare("SELECT id FROM api_keys WHERE revoked_at IS NOT NULL ORDER BY id").all()
    ).toEqual([{ id: "boot-old" }, { id: "ops" }]);
  });

  it("rejects an empty or overlong label and prints usage for unknown commands", () => {
    insertKey("kitchen", "mpk-kitchen-device-key");
    expect(cli("label", "kitchen", "   ").code).toBe(1);
    expect(cli("label", "kitchen", "x".repeat(81)).code).toBe(1);
    const unknown = cli("delete", "kitchen");
    expect(unknown.code).toBe(2);
    expect(unknown.output).toContain("Usage: devices <command>");
    expect(cli("--help").code).toBe(0);
  });

  it("opens the server's database by its environment and never creates a missing one", () => {
    insertKey("kitchen", "mpk-kitchen-device-key");
    const lines: string[] = [];
    const dbPath = resolveDbPath();
    const env = {
      DATA_DIR: path.dirname(dbPath),
      DATABASE_PATH: path.basename(dbPath),
      MP_BOOTSTRAP_KEY: "",
    };
    expect(mainDevicesCli(["revoke", "kitchen"], env, (line) => lines.push(line), NOW)).toBe(0);
    expect(lines).toEqual(["Revoked kitchen"]);
    expect(getDb().prepare("SELECT revoked_at FROM api_keys WHERE id = 'kitchen'").get()).toEqual({
      revoked_at: NOW,
    });

    const empty = mkdtempSync(path.join(tmpdir(), "devices-cli-"));
    try {
      const missing: string[] = [];
      expect(mainDevicesCli(["list"], { DATA_DIR: empty }, (line) => missing.push(line))).toBe(1);
      expect(missing[0]).toMatch(/^No database at /);
      expect(fs.existsSync(path.join(empty, "marplanner.db"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
