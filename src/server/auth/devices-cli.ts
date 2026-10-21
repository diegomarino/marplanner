import { pathToFileURL } from "node:url";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { existsSync } from "node:fs";
import { openClient } from "../db/client";
import {
  DeviceCredentialError,
  labelCredential,
  listCredentials,
  revokeCredential,
} from "./devices";

const USAGE = `Usage: devices <command>

  list                 List credentials (id, kind, label, created, state); never prints keys.
  label <id> <name>    Name a credential so a device can be identified later.
  revoke <id>          Retire a credential; its next request is refused.

Reads DATA_DIR / DATABASE_PATH like the server, and is safe to run while it is up. The
bootstrap key configured in MP_BOOTSTRAP_KEY is re-activated at startup: to rotate it, change
the variable, restart, then revoke the old bootstrap credential here (run with the same
environment as the server so the configured one is recognised).
`;

export interface DevicesCliIo {
  db: Database;
  nowMs: number;
  out: (line: string) => void;
  /** The server's MP_BOOTSTRAP_KEY, when known. */
  configuredBootstrap?: string;
}

/** Run one command; returns the process exit code. */
export function runDevicesCli(argv: readonly string[], io: DevicesCliIo): number {
  const [command, ...rest] = argv;
  try {
    if (command === "list" && rest.length === 0) {
      for (const c of listCredentials(io.db, io.nowMs)) {
        io.out(
          [c.id, c.kind, c.state, new Date(c.createdAt).toISOString(), c.label ?? "-"].join("\t")
        );
      }
      return 0;
    }
    if (command === "label" && rest.length >= 2) {
      labelCredential(io.db, rest[0], rest.slice(1).join(" "));
      io.out(`Labelled ${rest[0]}`);
      return 0;
    }
    if (command === "revoke" && rest.length === 1) {
      const revoked = revokeCredential(io.db, rest[0], io.nowMs, io.configuredBootstrap);
      io.out(revoked ? `Revoked ${rest[0]}` : `${rest[0]} was already revoked`);
      return 0;
    }
    io.out(USAGE);
    return command === "--help" || command === "-h" ? 0 : 2;
  } catch (error) {
    if (error instanceof DeviceCredentialError) {
      io.out(error.message);
      return 1;
    }
    throw error;
  }
}

/** Process entry: open the server's database (never creating one) and run `argv`. */
export function mainDevicesCli(
  argv: readonly string[],
  env: typeof process.env,
  out: (line: string) => void,
  nowMs = Date.now()
): number {
  const dbPath = path.resolve(env.DATA_DIR ?? process.cwd(), env.DATABASE_PATH ?? "marplanner.db");
  // Never create an empty database when DATA_DIR / DATABASE_PATH point at the wrong place.
  if (!existsSync(dbPath)) {
    out(`No database at ${dbPath}; set DATA_DIR / DATABASE_PATH as for the server.`);
    return 1;
  }
  const db = openClient(dbPath);
  try {
    // The server may be writing at the same time; wait briefly instead of failing on a lock.
    db.pragma("busy_timeout = 5000");
    return runDevicesCli(argv, {
      db,
      nowMs,
      out,
      configuredBootstrap: env.MP_BOOTSTRAP_KEY || undefined,
    });
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = mainDevicesCli(process.argv.slice(2), process.env, (line) =>
    console.log(line)
  );
}
