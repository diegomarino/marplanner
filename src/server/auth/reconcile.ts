import { randomUUID } from "node:crypto";
import { hashKey } from "./credentials";
import { getDb } from "../db/client";

const BOOTSTRAP_ENV = "MP_BOOTSTRAP_KEY";
const MANAGEMENT_ENV = "MP_MANAGEMENT_KEY";

/** Idempotent bootstrap reconciliation — seeds the `api_keys` row that
 * `provisionDevice` requires a persisted bootstrap row (ADR-032).
 * If `MP_BOOTSTRAP_KEY` is not set, this is a no-op (deployment stays locked, FR-003).
 * If an active bootstrap row already exists, this returns without inserting.
 */
export function reconcileBootstrap(): void {
  const configuredKey = process.env[BOOTSTRAP_ENV];
  if (!configuredKey) {
    return;
  }

  if (!configuredKey.startsWith("mpk-")) {
    throw new Error(
      `${BOOTSTRAP_ENV} must be an mpk- API key (ADR-037): refusing to seed a non-conforming bootstrap key.`
    );
  }

  const keyHash = hashKey(configuredKey);
  const db = getDb();

  const existing = db
    .prepare(
      "SELECT id, expires_at, revoked_at FROM api_keys WHERE key_hash = ? AND scope = '*' AND kind = 'bootstrap' LIMIT 1"
    )
    .get(keyHash) as
    { id: string; expires_at: number | null; revoked_at: number | null } | undefined;

  if (existing) {
    // "Active" mirrors boundary.ts / provision.ts: not revoked AND not expired.
    // Contract: expiry at the current instant is inactive. Boundary rejects
    // `expires_at <= now`; active here is therefore `expires_at === null || expires_at > now`.
    const now = Date.now();
    const isActive =
      existing.revoked_at === null && (existing.expires_at === null || existing.expires_at > now);
    if (!isActive) {
      // ADR-032 §2 (Rules 2 and 4): config value set + no ACTIVE matching key ⇒ re-establish.
      // Clear BOTH predicates so a revoked or expired row becomes usable again (bootstrap rows are
      // seeded with expires_at = NULL, so clearing to NULL restores the seeded shape).
      // Bootstrap-specific override of ADR-030's general revocation-irreversibility (Rule 4 contemplates this).
      db.prepare("UPDATE api_keys SET revoked_at = NULL, expires_at = NULL WHERE id = ?").run(
        existing.id
      );
      console.warn(
        `${BOOTSTRAP_ENV} matched an INACTIVE (revoked or expired) bootstrap row; re-establishing it (ADR-032). ` +
          `To retire the bootstrap key, REMOVE ${BOOTSTRAP_ENV} from the deployment, then revoke.`
      );
    }
    return;
  }

  const now = Date.now();
  db.prepare(
    "INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at, revoked_at) VALUES (?, ?, '*', 'bootstrap', ?, NULL, NULL)"
  ).run(randomUUID(), keyHash, now);
}

/** Idempotent management-key reconciliation (env-configured)
 * 2026-09-04) — seeds the operator's `kind='integration'` `api_keys` row (the Bearer
 * credential `requireFullAccess` admits on `/api/plugins*`). Nothing else ever mints
 * `kind='integration'`. Network-devices no longer depends on it: a provisioned device `*` cookie
 * is accepted there too (ADR-058, owner decision 2026-10-15). Mirrors
 * `reconcileBootstrap` above for the shared plumbing: same env-var-gated idempotent seed,
 * same `mpk-` format enforcement (ADR-037), same "unset → no-op, deployment/feature stays
 * locked" fail-closed default (no key is ever silently minted). Deliberately does NOT
 * mirror bootstrap's reactivate-on-inactive branch (see the comment inline below) —
 * revocation of this `scope='*'` credential is irreversible per ADR-030.
 * If `MP_MANAGEMENT_KEY` is not set, this is a no-op.
 * If an ACTIVE management row already exists for that key, this returns without inserting.
 * If a REVOKED or EXPIRED row matches, this returns without inserting AND without
 * reactivating it — the row stays inactive (a warning names the env var, never the key value).
 */
export function reconcileManagement(): void {
  const configuredKey = process.env[MANAGEMENT_ENV];
  if (!configuredKey) {
    return;
  }

  if (!configuredKey.startsWith("mpk-")) {
    throw new Error(
      `${MANAGEMENT_ENV} must be an mpk- API key (ADR-037): refusing to seed a non-conforming management key.`
    );
  }

  const keyHash = hashKey(configuredKey);
  const db = getDb();

  const existing = db
    .prepare(
      "SELECT id, expires_at, revoked_at FROM api_keys WHERE key_hash = ? AND scope = '*' AND kind = 'integration' LIMIT 1"
    )
    .get(keyHash) as
    { id: string; expires_at: number | null; revoked_at: number | null } | undefined;

  if (existing) {
    // Same "active" predicate as reconcileBootstrap above: not revoked AND not expired
    // (`expires_at === now` is inactive, matching boundary/provision).
    const now = Date.now();
    const isActive =
      existing.revoked_at === null && (existing.expires_at === null || existing.expires_at > now);
    // DELIBERATE DIVERGENCE from reconcileBootstrap above: bootstrap re-establishes an
    // inactive row on every boot (ADR-032 §2 Rule 2/4 explicitly contemplates this — losing
    // the bootstrap key locks the whole deployment out of first-device provisioning, which
    // is worse than the narrow re-establish window). The management key does NOT get that
    // exception: it is a scope='*' credential (ADR-030), and an operator revoking one is
    // almost always an emergency response to a leak — resurrecting it on the next restart
    // (before the operator has rotated MP_MANAGEMENT_KEY to a new value) would silently
    // undo that revocation and violate ADR-030's irreversible-revocation semantics. So a
    // revoked/expired row here stays inactive; the fix is to configure a NEW value, not to
    // wait for a reboot to "fix itself"..
    if (!isActive) {
      console.warn(
        `${MANAGEMENT_ENV} matches a REVOKED or EXPIRED management key row. It will NOT be ` +
          `reactivated automatically. Configure a NEW ${MANAGEMENT_ENV} value to mint a fresh ` +
          "management key."
      );
    }
    return;
  }

  const now = Date.now();
  db.prepare(
    "INSERT INTO api_keys (id, key_hash, scope, kind, created_at, expires_at, revoked_at) VALUES (?, ?, '*', 'integration', ?, NULL, NULL)"
  ).run(randomUUID(), keyHash, now);
}
