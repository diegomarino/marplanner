# ADR-037 Credential Format, Generation, and Failure-Based Rate Limiting

Status: accepted
Owner: architecture / security
Decision date: 2026-06-28

Threat model: a self-hosted **family** planner kiosk. Low-value target. Security effort is calibrated to that — with the principle that **when the secure option is free, take it regardless of threat level.**

## Decision

### Generation

All credentials are generated with a **CSPRNG** (`node:crypto`), never `bash $RANDOM` or any non-cryptographic PRNG. This is mandatory because it is free: `crypto.randomBytes`/`crypto.randomInt` is the same amount of code as `$RANDOM` with no downside. Generation lives in app/tooling, not a dev shell script.

Rationale recorded for posterity: the legacy `tools/dev/set-api-key.sh` used `$RANDOM`, whose ~15-bit predictable seed (PID XOR epoch-seconds) collapses the real search space far below the key's nominal entropy. The word/separator format was fine; the RNG was the defect.

### API key format

- **Every API key begins with the prefix `mpk-`.** This is mandatory and uniform across all API keys (bootstrap, device, integration). The prefix makes keys recognizable and, critically, **detectable**: an outbound redaction guard and secret scanners can match `mpk-` to ensure a key is never logged, sent in telemetry, or committed where it does not belong (ties to `ADR-016`).
- Body: a **word list** (memorable, the household's preferred style) joined by a **non-confusing separator**. The separator is a plain hyphen `-`; digits and ambiguous symbols (`@`, `%`, `0`/`O`, `1`/`l`) are **not** used as separators. Words are all-lowercase (no random per-word casing — it added transcription friction for negligible gain).
- Words come from a large standard list (EFF diceware, 7776 words ≈ 12.9 bits/word). Six words ≈ 77 bits, CSPRNG-selected — ample for the family threat model and still memorable/typeable.
- Example shape: `mpk-cedar-lantern-otter-ridge-velvet-amber`.

### Access-gate token format

- Same friendly diceware style with its own prefix (`mpg-`) for the same leak-detectability benefit. Lower blast radius, memorability matters here.

### Rate limiting — failure-based only

Rate limiting applies **only to authentication failures**, never to overall request volume.

- **Do not** limit by total request rate. The kiosk legitimately makes many requests; a global volume cap broke production before (a 100 requests/minute API limit throttled legitimate high-frequency kiosk traffic).
- **Do** throttle repeated **failed** key validations: count repeated missing/invalid-key attempts per source and apply backoff/temporary block to that source after a threshold, with exponential backoff. Successful, authenticated requests are never throttled.
- Failure episodes reset after 15 minutes without credential failures, not on successful requests. A valid kiosk behind the same NAT must not erase another client's failures. This explicitly refines the original consecutive-failure wording (policy approved 2026-10-01).
- Validate credentials first: valid active API and bootstrap credentials remain usable during a source cooldown. Failure-only backoff is cooperative retry backpressure, not a hard brute-force ceiling: ignored 429s still incur verification work and a correct guess succeeds.
- Transient attempt counters are process-local and bounded; they are not sessions or cached authorization state. Credential records and per-request authority remain in the database.
- Starting implementation defaults: bootstrap 5 failures in 10 minutes, API 20 in 1 minute; fixed observation windows; cooldowns 1, 2, 4, 8, 16, 32, 60 seconds; 5000 source/flow entries. These are provisional calibration values, not measured security guarantees. Restart or eviction resets counters.
- Sources are direct transport peers (`request.ip`), with IPv4-mapped IPv6 normalized. No forwarded-header trust or proxy configuration change is implied. NAT/proxy pooling, IPv6 rotation and distributed sources limit this control.

### Hygiene

- Generation must not echo the raw key to stdout/shell history. Write it to the env/secret store; display once in a controlled way if needed.
- `.env` containing the key must never be committed; provisioning docs state this.

## Calibration (explicitly deferred / not needed for family threat model)

- 160-bit entropy and base32+checksum formats are not required; ~77-bit diceware via CSPRNG is sufficient. (A checksum may be added later for typo-catching UX, optional.)
- These can be revisited only if the deployment ever becomes a higher-value or more widely exposed target.

## Affected Specs

- [the auth sessions feature](../../features/auth-sessions.md) — credential format/generation, key validation
- the kiosk shell navigation feature (deferred) — provisioning key entry
- [the client logging telemetry feature](../../features/client-logging-telemetry.md) — `mpk-`/`mpg-` redaction (`ADR-016`)

## Acceptance Criteria

- Given key generation, then it uses a CSPRNG; no code path uses `$RANDOM` or `Math.random` for credentials.
- Given any generated API key, then it begins with `mpk-` and contains only lowercase diceware words separated by hyphens.
- Given the access-gate token, then it begins with `mpg-`.
- Given repeated wrong-key requests from one source, then that source is backed off after a threshold; meanwhile a legitimate authenticated client is never throttled by request volume.
- Given a generation run, then the raw key is not written to shell history/stdout logs.
- Given outbound telemetry/logs, then any `mpk-`/`mpg-` value is redacted (`ADR-016`).

## Open Questions

- Optional checksum for typo-catching during tablet entry — nice-to-have, deferred.
- Exact failure threshold and backoff curve — implementation detail.

## Traceability

- Pre-v2: `ADR-007`, `ADR-013`
- Related: `ADR-030` (key model), `ADR-032` (bootstrap), `ADR-016` (telemetry redaction), `ADR-033` (fail-closed)
- Code reviewed: `tools/dev/set-api-key.sh` (legacy `$RANDOM` generator)
- Peer review: codex-peer-review (2026-06-28) — confirmed `$RANDOM` as the dominant critical flaw; entropy ~46–51 bits; failure-based rate limiting and prefix detectability endorsed.
