import { hashKey } from "./credentials";
import type { Database } from "better-sqlite3";

/** Operator credential retirement (docs/operations.md#credentials-and-provisioning).
 * Revocation sets `revoked_at`, which the auth boundary refuses on the very next request.
 * Startup reconciliation re-activates the bootstrap credential named by MP_BOOTSTRAP_KEY, so
 * that one is rotated by changing the variable (then the old row is revoked here); every
 * other credential, including a bootstrap key that is no longer configured, can be revoked.
 */
export type DeviceCredentialErrorCode =
  "credential_not_found" | "invalid_label" | "bootstrap_unknown" | "configured_bootstrap";

export class DeviceCredentialError extends Error {
  constructor(
    message: string,
    readonly code: DeviceCredentialErrorCode
  ) {
    super(message);
    this.name = "DeviceCredentialError";
  }
}

export interface CredentialSummary {
  id: string;
  kind: string;
  scope: string;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  state: "active" | "revoked" | "expired";
}

const MAX_LABEL_LENGTH = 80;

/** The id of the bootstrap row the configured MP_BOOTSTRAP_KEY names, or null when none is
 * configured or it has no row. `revokeCredential` refuses that row. */
export function configuredBootstrapId(
  db: Database,
  configuredBootstrap: string | undefined
): string | null {
  if (!configuredBootstrap) return null;
  const row = db
    .prepare("SELECT id FROM api_keys WHERE kind = 'bootstrap' AND key_hash = ?")
    .get(hashKey(configuredBootstrap)) as { id: string } | undefined;
  return row?.id ?? null;
}

/** Every credential, oldest first, without key hashes. */
export function listCredentials(db: Database, nowMs: number): CredentialSummary[] {
  const rows = db
    .prepare(
      "SELECT id, kind, scope, label, created_at, expires_at, revoked_at FROM api_keys ORDER BY created_at, id"
    )
    .all() as Array<{
    id: string;
    kind: string;
    scope: string;
    label: string | null;
    created_at: number;
    expires_at: number | null;
    revoked_at: number | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    state:
      row.revoked_at !== null
        ? "revoked"
        : row.expires_at !== null && row.expires_at <= nowMs
          ? "expired"
          : "active",
  }));
}

function readCredential(
  db: Database,
  id: string
): { kind: string; key_hash: string; revoked_at: number | null } {
  const row = db.prepare("SELECT kind, key_hash, revoked_at FROM api_keys WHERE id = ?").get(id) as
    { kind: string; key_hash: string; revoked_at: number | null } | undefined;
  if (!row) {
    throw new DeviceCredentialError(`No credential with id ${id}`, "credential_not_found");
  }
  return row;
}

/** Name a credential so an operator can tell provisioned devices apart later. */
export function labelCredential(db: Database, id: string, label: string): void {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new DeviceCredentialError(
      `A label must have 1 to ${MAX_LABEL_LENGTH} characters`,
      "invalid_label"
    );
  }
  readCredential(db, id);
  db.prepare("UPDATE api_keys SET label = ? WHERE id = ?").run(trimmed, id);
}

/** Retire one credential; household data and every other credential are untouched. Returns
 * false when it was already revoked (the original revocation time is kept). `configuredBootstrap`
 * is the MP_BOOTSTRAP_KEY value the server runs with (undefined when unknown). */
export function revokeCredential(
  db: Database,
  id: string,
  nowMs: number,
  configuredBootstrap: string | undefined
): boolean {
  const row = readCredential(db, id);
  if (row.kind === "bootstrap") {
    if (configuredBootstrap === undefined) {
      throw new DeviceCredentialError(
        "Set MP_BOOTSTRAP_KEY as for the server so the configured bootstrap key is recognised",
        "bootstrap_unknown"
      );
    }
    if (hashKey(configuredBootstrap) === row.key_hash) {
      throw new DeviceCredentialError(
        `Credential ${id} is the configured MP_BOOTSTRAP_KEY, which startup re-activates: change the variable and restart, then revoke this old credential`,
        "configured_bootstrap"
      );
    }
  }
  if (row.revoked_at !== null) return false;
  db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    nowMs,
    id
  );
  return true;
}
