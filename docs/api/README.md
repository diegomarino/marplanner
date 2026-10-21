# Marplanner HTTP API

Marplanner is **API-first**: the kiosk and the admin screens are ordinary clients of
the same HTTP API you can call from a script. Anything you can do on the tablet,
such as ticking off a chore, adding an event or reading tonight's dinner, you can
automate from cron, Home Assistant or your own dashboard.

- **Browse it online:** [API reference](https://petstore.swagger.io/?url=https://raw.githubusercontent.com/diegomarino/marplanner-project/main/docs/api/openapi.json), opened in Swagger UI from the
  `openapi.json` committed on `main`. You can read it without running an instance.
  "Try it out" calls will not reach your server, because they need its device cookie.
- **Reference:** a running instance serves an interactive reference at
  `GET /api/docs/` and the raw OpenAPI 3.1 document at `GET /api/openapi.json`.
  Both need the same credentials as any other `/api` route. A copy is committed as
  [`openapi.json`](openapi.json), so you can read it without running anything.
- **Generated from the code:** every route declares its schema with zod, next to the
  handler (`src/server/openapi/<domain>.ts`). `npm run generate:openapi` rewrites
  `openapi.json` from those schemas, and `npm run check:openapi` fails CI if the
  committed file is out of date, if a route has no schema, or if the documented
  operations no longer match the route table.
- **No second source of truth:** the schemas only document the API. Request checks
  and error responses are still handled in `src/server/modules/*`, so documenting a
  route never changes how it behaves. `npm run check:openapi-bodies` checks
  the schemas against real requests and responses captured while the test suite runs.

![Interactive API reference](../images/features/api-reference.png)

## Authentication

All `/api/*` routes are **closed by default**. Every request is authenticated and
checked against `domain:verb` permissions.

| Credential     | How you get it                                          | How you send it                   | Reaches                         |
| -------------- | ------------------------------------------------------- | --------------------------------- | ------------------------------- |
| Device key     | `POST /api/auth/provision` with the bootstrap key, once | `mp_device_key` cookie (httpOnly) | Every household and admin route |
| Management key | `MP_MANAGEMENT_KEY` in the server environment           | `Authorization: Bearer <key>`     | `/api/plugins*` only            |
| Bootstrap key  | `MP_BOOTSTRAP_KEY` in the server environment            | `Authorization: Bearer <key>`     | `POST /api/auth/provision` only |

The browser **access gate** (`MP_ACCESS_TOKEN`) and the **admin PIN** protect the
web UI only. API calls do not need them, and the backend never treats the PIN as an
authorisation.

There is no endpoint to issue, list or revoke keys. A device key, once minted, stays
valid until it is removed through the operations procedure
(see [operations](../operations.md)).

## Quickstart

The examples below run against the seeded Simpsons demo (`MP_SEED_ON_EMPTY=true`, or
`npm run seed:public`), using its default bootstrap key.

```sh
BASE=http://localhost:3000
# Household-local dates (the demo household uses Europe/Madrid).
TODAY=$(TZ=Europe/Madrid date +%F)
TOMORROW=$(TZ=Europe/Madrid date -d tomorrow +%F 2>/dev/null || TZ=Europe/Madrid date -v+1d +%F)

# 1. Provision a device for your script. Do this once and keep the key safe.
curl -s -c jar.txt -X POST "$BASE/api/auth/provision" \
  -H "Authorization: Bearer mpk-local-bootstrap-change-me"
# → {"provisioned":true}; the device key now sits in jar.txt as mp_device_key
KEY=$(awk '$6 == "mp_device_key" {print $7}' jar.txt)
AUTH="Cookie: mp_device_key=$KEY"

# 2. Who lives here?
curl -s -H "$AUTH" "$BASE/api/members"

# 3. Today's chore board, grouped by member and part of the day
curl -s -H "$AUTH" "$BASE/api/chores/board?date=$TODAY"

# 4. Bart brushed his teeth (204 No Content)
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/chores/demo:chore:morning-launch:brush-teeth/completions" \
  -d "{\"memberId\":\"demo:member:bart\",\"date\":\"$TODAY\"}"

# 5. What's on the calendar today (local and ICS feeds merged)?
#    Reads are limited to a window from 30 days back to 365 days ahead.
curl -s -H "$AUTH" "$BASE/api/calendar/events?from=$TODAY&to=$TOMORROW"

# 6. Add an event tomorrow at 18:00 Madrid time, then assign it to Lisa.
#    Local events are not assigned from their title; only ICS feed events are.
EVENT_ID=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/calendar/events" \
  -d "{\"title\":\"Saxophone recital\",\"allDay\":false,
       \"startUtc\":\"${TOMORROW}T16:00:00Z\",\"endUtc\":\"${TOMORROW}T17:00:00Z\",
       \"tzid\":\"Europe/Madrid\"}" | sed 's/.*"id":"\([^"]*\)".*/\1/')
curl -s -X PUT -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/api/calendar/events/$EVENT_ID/assignments" \
  -d '{"memberIds":["demo:member:lisa"]}'

# 7. What's for dinner?
curl -s -H "$AUTH" "$BASE/api/menu?date=$TODAY"
```

> [!NOTE]
> The device cookie is marked `Secure`. Over plain HTTP to anything but localhost,
> pass it explicitly with the `Cookie` header as shown above. Do not rely on a
> cookie jar.

## Conventions

- **JSON in, JSON out.** Dates are household-local `YYYY-MM-DD` strings, and instants
  are ISO-8601 UTC. Business dates follow the household timezone set in Settings.
- **Errors** are JSON with an `error` field and, in most domains, a `message`
  (`{ "error": "<code>", "message": "<text>" }`):
  - `400` for validation errors (invalid values are rejected, never silently fixed)
  - `401` for missing or invalid credentials
  - `403` for a missing permission
  - `404` for an unknown resource
  - `409` for a conflicting state, for example asking the daily briefing to print
    while the Printing plugin is off (`plugin_inactive`)
  - `503` for any route of a plugin that is itself inactive. This response comes
    from the plugin gate and uses `code` instead of `error`:
    `{ "code": "plugin_unavailable", "message": "This plugin is unavailable." }`
- **Rate limiting:** repeated failed authentication returns `429` with a
  `Retry-After` header. The limits are 20 failures a minute for API keys and 5 every
  10 minutes for the bootstrap key.
- **Plugins:** an inactive plugin contributes nothing: no settings, widgets or jobs,
  and every one of its routes answers `503 plugin_unavailable` until it is activated
  again. Manage plugins under `/api/plugins`.
- **Base path:** when the server is mounted under `BASE_PATH`, every route, including
  `/api/docs`, is served under that prefix.

## Domains

| Domain             | Main resources                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------- |
| Members            | `/api/members`                                                                            |
| Day periods        | `/api/day-periods`                                                                        |
| Routines & chores  | `/api/routines`, `/api/chores`, `/api/chores/board`                                       |
| Calendar           | `/api/calendar/events`, `/api/calendar/external-sources`, `/api/calendar/highlight-rules` |
| Meals & recipes    | `/api/recipes`, `/api/meal-plans`, `/api/meal-entries`, `/api/menu`                       |
| Reminders          | `/api/reminders`                                                                          |
| Daily messages     | `/api/daily-messages`                                                                     |
| Daily briefing     | `/api/daily-briefing`                                                                     |
| Printing           | `/api/printing`                                                                           |
| Time announcements | `/api/time-announcements`                                                                 |
| Weather            | `/api/weather`                                                                            |
| Network devices    | `/api/network-devices`                                                                    |
| Backups            | `/api/backups`                                                                            |
| Settings           | `/api/settings`                                                                           |
| Plugins            | `/api/plugins`                                                                            |
| Telemetry          | `/api/telemetry`                                                                          |

Browse the full list of operations with their request and response schemas at
`/api/docs/` on any instance.

## Adding or changing a route

1. Declare or update its zod schema in `src/server/openapi/<domain>.ts`. Register
   any shared shapes with `component()`, so they appear under
   `#/components/schemas`.
2. Attach the schema to the route with `documented(<domain>Schemas.<operation>)`.
3. Run `npm run generate:openapi` and commit the updated `docs/api/openapi.json`.
4. Run `npm run check:openapi` (and `check:openapi-shapes` if the change touches a
   type in `src/shared`).

## Beyond HTTP

- **Domain events:** the server publishes a typed catalogue of domain events
  (`src/shared/events.ts`) that plugins subscribe to through the host API.
- **Background jobs:** feed syncing, briefing generation and nightly backups run on
  the built-in scheduler ([spec](../features/background-jobs-scheduler.md)).

## Not there yet

These are deliberately out of scope for the current household release:

- endpoints to issue, list or revoke keys
- outgoing webhooks
- a published client SDK

The generated `openapi.json` is a good starting point for generating a client in the
meantime.
