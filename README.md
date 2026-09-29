# Marplanner

Marplanner is a self-hosted household planner for a shared display. It combines
calendar and external feeds, day periods, routines and chores, reminders, meals,
daily messages, weather, spoken time, network devices, printing, daily briefings,
telemetry, and backup/restore. Optional features are installed plugins: activate
them from Admin → Plugins before configuring their contributions.

The family navigation provides Home, Calendar, Chores and Meals. Administration
owns household settings, member profiles, content, integrations and recovery.
English and Spanish are supported. External providers and physical devices need
operator configuration; synthetic test success does not establish their availability.

## Requirements

- Node.js `>=24.21.0 <25` (development and CI use `24.21.0`)
- npm `11.19.0` for the pinned development environment
- A writable, persistent directory for application data

## Install and start

```sh
npm ci
npm run build
DATA_DIR=/path/to/persistent/marplanner npm start
```

Create the data directory before starting and grant the server process write access. The server listens on `0.0.0.0:3000` by default; set `HOST` and `PORT` for your deployment. Shut it down with `SIGINT` or `SIGTERM` and allow the process to drain. The SQLite database defaults to `DATA_DIR/marplanner.db`; `DATABASE_PATH` can override its filename. With no `DATA_DIR`, storage falls back to the working directory, which is unsuitable for a disposable deployment directory.

The app fails closed until the operator configures credentials. Put unique secret values in the deployment environment. For local development, copy `.env.example` to the ignored `.env.local` and replace every sample value; exported variables take precedence. `npm start` and the seed commands load `.env.local` when present. Never publish populated credential files.

| Setting             | Boundary                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `MP_ACCESS_TOKEN`   | Frontend access gate. Without it, browser access cannot pass the gate.                                                          |
| `MP_BOOTSTRAP_KEY`  | Deployment bootstrap device credential. Without it, first-device provisioning remains locked.                                   |
| `MP_MANAGEMENT_KEY` | Optional operator credential for management capabilities. Rotating the environment value does not revoke an already issued key. |
| `ADMIN_PIN`         | Initial advisory UI PIN. It does not authorize backend requests. Set a unique value; the code's fallback is `0000`.             |

See [operations](docs/operations.md) for provisioning, storage, shutdown, and synthetic public seed guidance. See [security](SECURITY.md) before exposing the service beyond a trusted network.

## Development and verification

```sh
npm ci
npm run dev:server
npm run dev
```

The last two commands run in separate terminals. The `package.json` scripts define the current check tiers: `npm run check:fast`, `npm run check:standard`, and `npm run check:full`. The full tier includes browser tests and requires their local browser dependencies. A passing focused tier is evidence for that tier only. [Verification guidance](docs/quality/verification.md) explains discovery, coverage, and cross-consumer checks.

[Contributor guide](CONTRIBUTING.md) · [Architecture](docs/architecture/principles.md) · [API contracts](docs/api/) · [License](LICENSE)
