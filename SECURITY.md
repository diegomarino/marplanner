# Security

## Reporting a vulnerability

The maintainer's confirmed GitHub identity is `diegomarino`. Before publication, the maintainer must verify a private vulnerability-reporting channel on the actual published repository and place its exact instructions here. Do not put an undisclosed vulnerability, working exploit, credential, household data, or device identifier in a public issue or pull request. A private contact URL, email address, and response deadline have not been confirmed. Publication is gated on resolving this reporting destination.

For a safe reproduction, use synthetic household data and redact access tokens, device keys, PINs, cookies, IP addresses, MAC addresses, database contents, and logs before sharing them.

## Trust boundaries

- `MP_ACCESS_TOKEN` gates the frontend. Its cookie is a browser access boundary, not a device API credential.
- `MP_BOOTSTRAP_KEY` establishes the first device credential. Device API keys are checked by backend authorization and may have separate scopes and revocation state.
- `MP_MANAGEMENT_KEY` is an optional operator credential. Changing an environment value alone does not revoke a previously persisted key; rotate and revoke deliberately.
- `ADMIN_PIN` is an advisory UI gate. It never grants API authorization.

Deploy the app behind a transport and network boundary appropriate to its cookie and credential posture. Keep `DATA_DIR` private and persistent, restrict its permissions, and keep environment secrets outside version control. The supported Node range is `>=24.21.0 <25`; development and CI use `24.21.0`. See [authentication behavior](docs/features/auth-sessions.md) and [operations](docs/operations.md).
