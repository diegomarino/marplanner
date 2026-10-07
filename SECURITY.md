# Security

## Reporting a vulnerability

Use **GitHub private vulnerability reporting** on this repository: open the repo on GitHub → **Security** → **Report a vulnerability** (or the equivalent private advisory flow once enabled for the published repo). That channel is private to maintainers; do **not** open a public issue or pull request for an undisclosed vulnerability, working exploit, credential, household data, or device identifier.

Maintainer GitHub identity: [`diegomarino`](https://github.com/diegomarino).

**Response targets:** acknowledge receipt within **7 days**; provide a fix-or-status update within **90 days**. These are good-faith targets for a single-maintainer household project, not contractual SLAs.

Before the public repository has private vulnerability reporting turned on (Settings → Code security → Private vulnerability reporting), treat publication as blocked until that setting is enabled on the live repo. The instructions above are the intended permanent channel.

For a safe reproduction, use synthetic household data and redact access tokens, device keys, PINs, cookies, IP addresses, MAC addresses, database contents, and logs before sharing them.

## Trust boundaries

- `MP_ACCESS_TOKEN` gates the frontend. Its cookie is a browser access boundary, not a device API credential.
- `MP_BOOTSTRAP_KEY` establishes the first device credential. Device API keys are checked by backend authorization and may have separate scopes and revocation state.
- `MP_MANAGEMENT_KEY` is an optional operator credential. Changing an environment value alone does not revoke a previously persisted key; rotate and revoke deliberately.
- `ADMIN_PIN` is an advisory UI gate. It never grants API authorization.

Deploy the app behind a transport and network boundary appropriate to its cookie and credential posture. Keep `DATA_DIR` private and persistent, restrict its permissions, and keep environment secrets outside version control. The supported Node range is `>=24.21.0 <25`; development and CI use `24.21.0`. See [authentication behavior](docs/features/auth-sessions.md) and [operations](docs/operations.md).
