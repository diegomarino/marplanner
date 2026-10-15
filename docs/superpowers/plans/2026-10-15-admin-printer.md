# Admin Printer Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/admin/printing` into the reference app's Printer page: Settings | Diagnostics
tabs, settings wired to the existing `printer`/`printerTransport` objects and to the Bluetooth
transport, a "reset today's print" endpoint, and a recent-prints table.

**Architecture:** One additive server function + route (`resetTodaysPrints`,
`POST /api/printing/reset-today`) built on the existing `supersedePrintRecordTxn`. The client
transport's `pair()` now returns the device identity and accepts a preferred service/characteristic;
the shared printer session exposes it as `pairedDevice`. `PrintingManagement.tsx` becomes a small
shell with local-state tabs rendering two new components under `src/client/admin/printer/`.

**Tech Stack:** TypeScript, React 19, Vite, Fastify, better-sqlite3, Vitest + Testing Library,
Playwright. Node 24.21.0 (via `fnm`), npm.

**Spec:** `docs/superpowers/specs/2026-10-15-admin-printer-design.md` (read it first; this plan
argues from it).

## Global Constraints

- Work in your own git worktree/branch. Do NOT touch the main checkout at `<maintainer-workspace>`.
- Port behaviour, not mechanism; keep the server print queue, `alreadyPrinted` dedup, distinct dead-letter/retrying labels, ErrorNotice announcements.
- Page heading must equal the sidebar label: use `t("admin.sidebar.printer")` ("Printer"/"Impresora").
- Tabs are local React state inside `/admin/printing`. NEVER add URL sub-routes and never edit `src/client/admin/AdminRoutes.tsx` or `src/client/shell/routes.ts`.
- Reuse `src/client/components/ui/*` and `AdminPanel`, `ErrorNotice`, `Field`, `ConfirmDialog`. No new shared component. No `window.confirm`.
- Every load error gets a Retry button.
- All new strings go in `src/client/i18n/messages.ts`, one contiguous block per locale under the comment `// admin-printer`, inserted right after the `"admin.notFound.description"` line (en ~line 263, es ~line 1549). New keys are prefixed `admin.printer.`.
- Printing module public API stays stable: do not change the signature of any existing export of `src/server/modules/printing/index.ts` or `src/server/host-api/index.ts`; only add.
- No raw colour classes (`text-red-*`, `bg-gray-*`, hex); use tokens (`text-muted-foreground`, `bg-card`, `bg-muted`, `text-destructive`). No new `eslint-disable` comments.
- Shared files edited by parallel workers (keep edits minimal and contiguous): `src/client/i18n/messages.ts`, `src/shared/index.ts`, `tests/fixtures/assembly-cohort.json`, `docs/ui/household-contract.md`, `tests/e2e/daily-briefing.spec.ts`.
- E2E port for this work: `PORT=43203`.

## Review Focus

1. A device whose Bluetooth UUIDs are not RFC-4122 version 1-5 (the server validator rejects them): Save must show the field error, never a silent no-op. Pinned in Task 6 ("rejects a non-RFC UUID").
2. Pairing completes while the form has unsaved edits to paper width: the width edit must survive (only transport fields change). Pinned in Task 6 ("pairing keeps an unsaved width edit").
3. Reset when nothing exists for today must not error and must say so. Pinned in Task 1 (zeros) and Task 5 ("nothing" message).
4. A job whose member was deleted/unknown, or a failed members read: the row still renders with "—". Pinned in Task 5.
5. Partial save failure (printer PUT ok, printerTransport PUT 400): the form keeps the user's transport edits and shows the error. Pinned in Task 6.

---

### Task 0: Workspace setup

**Files:** none modified (copies the untracked spec/plan in).

- [ ] **Step 1: Copy the spec and plan into your branch** (they live untracked in the main checkout)

```bash
mkdir -p docs/superpowers/specs docs/superpowers/plans
cp <maintainer-workspace>/docs/superpowers/specs/2026-10-15-admin-printer-design.md docs/superpowers/specs/
cp <maintainer-workspace>/docs/superpowers/plans/2026-10-15-admin-printer.md docs/superpowers/plans/
```

- [ ] **Step 2: Install dependencies** (worktree `node_modules` may be an empty symlink)

```bash
fnm exec --using=24.21.0 npm ci
```

- [ ] **Step 3: Baseline the tests you will touch**

Run: `npx vitest run tests/client/printing-management.test.tsx tests/client/printing-surfaces.test.tsx tests/client/printing-executor.test.tsx tests/client/printing-transport.test.ts tests/client/printer-attention.test.tsx tests/boundary/printing-core.test.ts tests/boundary/printing-routes.test.ts`
Expected: all PASS. If anything fails before you change code, stop and report it.

- [ ] **Step 4: Commit** `git add docs/superpowers && git commit -m "docs(printer): add admin printer spec and plan"`.
  If every git command is refused in your worktree (known for isolated agents in this repo), leave
  all work uncommitted, keep going, and at the end report the full list of touched/created files.

---

### Task 1: Core `resetTodaysPrints`

**Files:**
- Modify: `src/shared/index.ts` (add DTO after `PrintingStatusResponse`, ~line 970)
- Modify: `src/server/modules/printing/index.ts` (add function after `supersedePrintRecord`, ~line 549; extend the shared type import at lines 19-27)
- Test: `tests/boundary/printing-core.test.ts`

**Interfaces:**
- Produces: `export interface ResetTodayPrintsResponse { targetDate: string; resetRecords: number; cancelledJobs: number; }` in `src/shared/index.ts`
- Produces: `export function resetTodaysPrints(now: number): ResetTodayPrintsResponse` in `src/server/modules/printing/index.ts` (throws `PrintingPluginInactiveError` when inactive)

- [ ] **Step 1: Add the DTO** to `src/shared/index.ts` directly after the `PrintingStatusResponse` interface (keep the `export interface Name {` one-line opener; the shapes gate parses it):

```ts
/** ResetTodayPrintsResponse — `POST /api/printing/reset-today`'s envelope: how many of the
 * household's today print records were made printable again and how many queued jobs were
 * cancelled. Declared HERE for shapes-gate coverage (see `ErrorResponse` above).
 */
export interface ResetTodayPrintsResponse {
  targetDate: string;
  resetRecords: number;
  cancelledJobs: number;
}
```

- [ ] **Step 2: Write the failing tests.** In `tests/boundary/printing-core.test.ts` add `resetTodaysPrints` and `hasTerminalFailedJob` to the import list from `../../src/server/modules/printing/index` (lines 10-31), then add this `describe` block right before the `describe("registerPrintableProvider — fetch-at-execute resolution (research D4)"` block:

```ts
  describe("resetTodaysPrints — admin reset of today's print (FR-016)", () => {
    it("makes a printed record printable again; the next enqueue creates a new job", () => {
      const params = { recordKey: "reset-printed", targetDate: TARGET_DATE, outputRef: "x" };
      const first = enqueuePrintJob(params, ANCHOR_MS);
      const claimed = claimJob(ANCHOR_MS)!;
      ackJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);
      expect(enqueuePrintJob(params, ANCHOR_MS + 2).alreadyPrinted).toBe(true);

      expect(resetTodaysPrints(ANCHOR_MS + 3)).toEqual({
        targetDate: TARGET_DATE,
        resetRecords: 1,
        cancelledJobs: 0,
      });

      const again = enqueuePrintJob(params, ANCHOR_MS + 4);
      expect(again.enqueued).toBe(true);
      expect(again.jobId).not.toBe(first.jobId);
      const printed = listJobs(ANCHOR_MS).jobs.find((j) => j.id === first.jobId)!;
      expect(printed.state).toBe("printed"); // history kept
    });

    it("cancels today's pending jobs and leaves other dates alone", () => {
      enqueuePrintJob(
        { recordKey: "reset-pending", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      enqueuePrintJob(
        { recordKey: "reset-other-day", targetDate: "2026-06-20", outputRef: "y" },
        ANCHOR_MS
      );

      const result = resetTodaysPrints(ANCHOR_MS + 1);

      expect(result).toEqual({ targetDate: TARGET_DATE, resetRecords: 1, cancelledJobs: 1 });
      const jobs = listJobs(ANCHOR_MS + 1).jobs;
      expect(jobs.find((j) => j.recordKey === "reset-pending")!.state).toBe("cancelled");
      expect(jobs.find((j) => j.recordKey === "reset-other-day")!.state).toBe("pending");
    });

    it("leaves a fetched-in-flight job running and does not count it (H2)", () => {
      enqueuePrintJob(
        { recordKey: "test-print:reset-inflight", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      getPayload(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1);

      const result = resetTodaysPrints(ANCHOR_MS + 2);

      expect(result.cancelledJobs).toBe(0);
      const job = listJobs(ANCHOR_MS + 2).jobs.find((j) => j.id === claimed.job.id)!;
      expect(job.state).toBe("claimed");
    });

    it("clears a dead-letter gate so a level-triggered producer can enqueue again", () => {
      enqueuePrintJob(
        { recordKey: "reset-dead", targetDate: TARGET_DATE, outputRef: "x" },
        ANCHOR_MS
      );
      const claimed = claimJob(ANCHOR_MS)!;
      failJob(claimed.job.id, claimed.leaseToken, ANCHOR_MS + 1, "boom", "render_failure");
      expect(hasTerminalFailedJob("reset-dead", TARGET_DATE)).toBe(true);

      resetTodaysPrints(ANCHOR_MS + 2);

      expect(hasTerminalFailedJob("reset-dead", TARGET_DATE)).toBe(false);
    });

    it("returns zeros when nothing exists for today", () => {
      expect(resetTodaysPrints(ANCHOR_MS)).toEqual({
        targetDate: TARGET_DATE,
        resetRecords: 0,
        cancelledJobs: 0,
      });
    });

    it("throws PrintingPluginInactiveError while the plugin is inactive", () => {
      __setPrintingPluginActiveForTests(false);
      expect(() => resetTodaysPrints(ANCHOR_MS)).toThrow(PrintingPluginInactiveError);
    });
  });
```

- [ ] **Step 3: Run and see it fail**

Run: `npx vitest run tests/boundary/printing-core.test.ts -t "resetTodaysPrints"`
Expected: FAIL (`resetTodaysPrints` is not exported).

- [ ] **Step 4: Implement.** In `src/server/modules/printing/index.ts` add `ResetTodayPrintsResponse` to the `import type {...} from "../../../shared"` list, then add after `supersedePrintRecord`:

```ts
/** Admin "reset today's print" (FR-016): supersedes EVERY print record of the household's today,
 * whatever its producer, so each becomes printable again — the test print can be re-enqueued and
 * daily-briefing's level-triggered auto-print re-enqueues on its next evaluation (new generation,
 * no dead-letter in it). Cancels today's pending and claimed-not-yet-fetched jobs through the same
 * `supersedePrintRecordTxn` regeneration uses; fetched-in-flight jobs finish (H2). Printed rows keep
 * their history. Plugin-gated like enqueue/claim (INV-06). Admin-only: not exported through the
 * host-api barrel.
 */
export function resetTodaysPrints(now: number): ResetTodayPrintsResponse {
  if (!isPrintingPluginActive()) throw new PrintingPluginInactiveError();
  const db = getDb();
  const targetDate = todayInHouseholdTz(now);

  const result = db.transaction((): ResetTodayPrintsResponse => {
    const records = db
      .prepare("SELECT record_key FROM print_records WHERE target_date = ? ORDER BY created_at ASC")
      .all(targetDate) as Array<Pick<PrintRecordRow, "record_key">>;
    const { cancelled } = db
      .prepare(
        `SELECT COUNT(*) AS cancelled FROM print_jobs
         WHERE record_id IN (SELECT id FROM print_records WHERE target_date = ?)
           AND (state = 'pending' OR (state = 'claimed' AND payload_served_at IS NULL))`
      )
      .get(targetDate) as { cancelled: number };
    for (const record of records) supersedePrintRecordTxn(record.record_key, targetDate, now);
    return { targetDate, resetRecords: records.length, cancelledJobs: cancelled };
  })();

  if (result.resetRecords > 0) notifyPrintingClaimSettled();
  return result;
}
```

- [ ] **Step 5: Run and see it pass**

Run: `npx vitest run tests/boundary/printing-core.test.ts`
Expected: PASS (all, including the new block).

- [ ] **Step 6: Commit** `git add src/shared/index.ts src/server/modules/printing/index.ts tests/boundary/printing-core.test.ts && git commit -m "feat(printing): reset today's print records"`

---

### Task 2: `POST /api/printing/reset-today` route, contract and docs

**Files:**
- Modify: `src/server/routes/printing.ts` (import list lines 2-17; new handler after the `GET /api/printing/status` handler)
- Modify: `docs/api/printing/openapi.yaml` (schema after `PrintingStatusResponse`; path after `/api/printing/test-print`)
- Modify: `tests/fixtures/assembly-cohort.json` (`pluginRoutes`)
- Modify: `docs/features/printing.md` (FR-016)
- Test: `tests/boundary/printing-routes.test.ts`

**Interfaces:**
- Consumes: `resetTodaysPrints(now)` and `ResetTodayPrintsResponse` from Task 1.
- Produces: `POST /api/printing/reset-today` → 200 `ResetTodayPrintsResponse`; 400 `{error:"validation_error"}` for a non-object body or any body field; 409 `{error:"plugin_inactive"}`.

- [ ] **Step 1: Write the failing tests** in `tests/boundary/printing-routes.test.ts`:
  - add `{ method: "POST", url: "/api/printing/reset-today" },` to the `ROUTES` array (after the test-print entry) so the 401 matrix covers it;
  - `enqueuePrintJob`, `todayInHouseholdTz` and `__setPrintingPluginActiveForTests` are already imported (lines 5-11); append these tests inside the top-level `describe` (before its closing `});`):

```ts
  // ── POST /reset-today — admin "reset today's print" (FR-016) ──────────

  it("POST /reset-today — 200 makes today's test print printable again", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const today = todayInHouseholdTz(Date.now());
      enqueuePrintJob(
        { recordKey: "test-print", targetDate: today, outputRef: `test-print:${today}` },
        Date.now()
      );

      const res = await app.inject({
        method: "POST",
        url: "/api/printing/reset-today",
        cookies: { mp_device_key: deviceKey },
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ targetDate: today, resetRecords: 1, cancelledJobs: 1 });
    } finally {
      await app.close();
    }
  });

  it("POST /reset-today — 400 when the body carries any field", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/reset-today",
        cookies: { mp_device_key: deviceKey },
        payload: { targetDate: "2026-06-15" },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toBe("validation_error");
    } finally {
      await app.close();
    }
  });

  it("POST /reset-today — 409 plugin_inactive while the printing plugin is inactive", async () => {
    const deviceKey = await provisionRealDeviceKey();
    const app = await buildApp();
    try {
      __setPrintingPluginActiveForTests(false);
      const res = await app.inject({
        method: "POST",
        url: "/api/printing/reset-today",
        cookies: { mp_device_key: deviceKey },
      });
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body).error).toBe("plugin_inactive");
    } finally {
      await app.close();
    }
  });
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run tests/boundary/printing-routes.test.ts`
Expected: the three new tests FAIL with 404 (the 401 matrix may already pass because auth runs first).

- [ ] **Step 3: Implement the route.** Add `resetTodaysPrints,` to the import list from `../modules/printing/index` and add after the `/api/printing/status` handler:

```ts
  // FR-016: admin "reset today's print" — every print record of household-today becomes
  // printable again (supersede); takes no body.
  app.post("/api/printing/reset-today", async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body === undefined ? {} : request.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return reply
        .code(400)
        .send({ error: "validation_error", message: "Request body must be an object" });
    }
    const unknownKeys = Object.keys(body);
    if (unknownKeys.length > 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: `Unsupported field(s) in reset-today body: ${unknownKeys.join(", ")}`,
      });
    }
    try {
      return reply.code(200).send(resetTodaysPrints(Date.now()));
    } catch (err) {
      return handlePrintingError(err, reply);
    }
  });
```

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run tests/boundary/printing-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: OpenAPI.** In `docs/api/printing/openapi.yaml`, add under `components/schemas` right after `PrintingStatusResponse`:

```yaml
    ResetTodayPrintsResponse:
      type: object
      required:
        - targetDate
        - resetRecords
        - cancelledJobs
      additionalProperties: false
      properties:
        targetDate:
          type: string
          description: household-local today (YYYY-MM-DD) whose print records were reset
        resetRecords:
          type: integer
          minimum: 0
          description: print records made printable again (superseded)
        cancelledJobs:
          type: integer
          minimum: 0
          description: pending or claimed-not-yet-fetched jobs cancelled; fetched jobs finish (H2)
```

and under `paths`, right after the whole `/api/printing/test-print:` block (before `/api/printing/jobs:`):

```yaml
  /api/printing/reset-today:
    post:
      summary: >-
        admin "reset today's print" (FR-016) — supersede every print record of household-today so
        it can print again; cancels pending and claimed-not-yet-fetched jobs. Takes no body.
      responses:
        "429":
          $ref: "#/components/responses/AuthenticationBackoff"
        "200":
          description: today's print records were reset (zero counts when nothing existed)
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ResetTodayPrintsResponse"
        "400":
          description: a request body with any field
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "401":
          description: Missing, ambiguous or invalid API credential (shared authentication boundary).
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/AuthUnauthorized"
        "409":
          description: printing plugin inactive (FR-013)
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "503":
          description: The owning plugin is inactive or unavailable.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/PluginUnavailable"
```

- [ ] **Step 6: Cohort route list.** In `tests/fixtures/assembly-cohort.json` `pluginRoutes`, insert between the `POST /api/printing/jobs/{id}/fail` and `POST /api/printing/test-print` entries:

```json
    {
      "method": "POST",
      "path": "/api/printing/reset-today"
    },
```

- [ ] **Step 7: Feature doc.** In `docs/features/printing.md`, append after FR-015 (same bullet style):

```markdown
- **FR-016**: Given an admin resets today's print, when the request is processed, then every print record of the household's current date MUST be superseded (re-printable) and its pending or claimed-not-yet-fetched jobs cancelled exactly as FR-015, fetched-in-flight jobs MAY finish, printed job history MUST be kept, and the response MUST report the reset record and cancelled job counts. Inactive plugin: refused like enqueue (FR-013). Contract: `POST /api/printing/reset-today`.
```

- [ ] **Step 8: Contract gates**

Run: `npm run check:openapi && npm run check:openapi-shapes`
Expected: both exit 0. (`check:openapi` reads the cohort route list; if it reports a route-set difference, fix the JSON entry or the YAML path, never the tool.)

- [ ] **Step 9: Commit** `git add src/server/routes/printing.ts docs/api/printing/openapi.yaml tests/fixtures/assembly-cohort.json docs/features/printing.md tests/boundary/printing-routes.test.ts && git commit -m "feat(printing): POST /api/printing/reset-today"`

---

### Task 3: Transport `pair()` returns the device identity and honours a preference

**Files:**
- Modify: `src/client/printing/transport.ts`
- Test: `tests/client/printing-transport.test.ts`

**Interfaces:**
- Produces (exported from `src/client/printing/transport.ts`):
  - `export type PrinterEndpointPreference = Partial<Pick<PrinterTransportSettings, "serviceUuid" | "characteristicUuid">>;`
  - `PrintTransport.pair(preference?: PrinterEndpointPreference): Promise<PrinterTransportSettings>`
  - `export const FAKE_PRINTER_IDENTITY: PrinterTransportSettings = { deviceId: "fake-printer", name: "Fake printer", serviceUuid: "e7810a71-73ae-499d-8c15-faa9aef0c3f2", characteristicUuid: "bef8d6c9-9c21-4c9e-b632-bd58c1009f9f" }`
  - `export function orderCandidateServices(preferred?: string): (number | string)[]`
- `PrinterTransportSettings` is the existing type in `src/shared/index.ts` (import from `"../../shared"`).

- [ ] **Step 1: Write the failing tests** in `tests/client/printing-transport.test.ts` (add `FAKE_PRINTER_IDENTITY` and `orderCandidateServices` to the existing import from `@/printing/transport`):

Inside `describe("createFakePrintTransport (byte recorder + scriptable failures/disconnects)", ...)` add:

```ts
  it("pair() resolves the fake identity, honouring a preferred service/characteristic", async () => {
    const fake = createFakePrintTransport();
    await expect(fake.pair()).resolves.toEqual(FAKE_PRINTER_IDENTITY);
    await expect(
      fake.pair({
        serviceUuid: "000018f0-0000-1000-8000-00805f9b34fb",
        characteristicUuid: "00002af1-0000-1000-8000-00805f9b34fb",
      })
    ).resolves.toEqual({
      ...FAKE_PRINTER_IDENTITY,
      serviceUuid: "000018f0-0000-1000-8000-00805f9b34fb",
      characteristicUuid: "00002af1-0000-1000-8000-00805f9b34fb",
    });
  });
```

Inside `describe("createBluetoothPrintTransport pair() requestDevice filter shape (P1-1 regression)", ...)` add:

```ts
  it("orderCandidateServices puts a preferred service first without duplicating it", () => {
    expect(orderCandidateServices()).toEqual(BLUETOOTH_PRINTER_CANDIDATE_SERVICES);
    const preferred = "49535343-FE7D-4AE5-8FA9-9FAFD205E455";
    const ordered = orderCandidateServices(preferred);
    expect(ordered[0]).toBe(preferred.toLowerCase());
    expect(ordered).toHaveLength(BLUETOOTH_PRINTER_CANDIDATE_SERVICES.length);
  });

  it("pair() resolves the device identity and prefers the stored service and characteristic", async () => {
    const preferredService = "49535343-fe7d-4ae5-8fa9-9fafd205e455";
    const preferredCharacteristic = "49535343-8841-43f4-a8d4-ecbe34729bb3";
    const writable = (uuid: string) => ({
      uuid,
      properties: { write: true, writeWithoutResponse: false },
    });
    const getPrimaryService = vi.fn(async (id: number | string) => ({
      uuid: String(id),
      getCharacteristics: async () => [
        writable("0000ffff-0000-1000-8000-00805f9b34fb"),
        writable(preferredCharacteristic),
      ],
    }));
    const device = {
      id: "dev-1",
      name: "Thermal X",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      gatt: {
        connected: true,
        connect: vi.fn(async () => ({ getPrimaryService })),
        disconnect: vi.fn(),
      },
    };
    const requestDevice = vi.fn().mockResolvedValue(device);
    vi.stubGlobal("navigator", { ...globalThis.navigator, bluetooth: { requestDevice } });

    const identity = await createBluetoothPrintTransport().pair({
      serviceUuid: preferredService,
      characteristicUuid: preferredCharacteristic,
    });

    expect(requestDevice.mock.calls[0][0].optionalServices[0]).toBe(preferredService);
    expect(getPrimaryService).toHaveBeenNthCalledWith(1, preferredService);
    expect(identity).toEqual({
      deviceId: "dev-1",
      name: "Thermal X",
      serviceUuid: preferredService,
      characteristicUuid: preferredCharacteristic,
    });
  });
```

The existing filter-shape test (no preference) must keep passing unchanged: with no preference
`optionalServices` stays exactly `BLUETOOTH_PRINTER_CANDIDATE_SERVICES`.

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run tests/client/printing-transport.test.ts`
Expected: FAIL (missing exports; `pair()` resolves `undefined`).

- [ ] **Step 3: Implement** in `src/client/printing/transport.ts`:
  1. At the top (after the module doc), add `import type { PrinterTransportSettings } from "../../shared";` and the `PrinterEndpointPreference` type above.
  2. In `interface PrintTransport`, replace the `pair(): Promise<void>;` line (keep its doc, add one sentence: "Resolves the paired device's identity; a preference is tried first, never required.") with
     `pair(preference?: PrinterEndpointPreference): Promise<PrinterTransportSettings>;`
  3. Add `FAKE_PRINTER_IDENTITY` (exact value in Interfaces) next to `DEFAULT_PAIR_FAILURE`, and make the fake's `pair`:

```ts
    async pair(preference) {
      if (pairFailure) {
        const err = pairFailure;
        pairFailure = null;
        throw err;
      }
      ready = true;
      return {
        ...FAKE_PRINTER_IDENTITY,
        serviceUuid: preference?.serviceUuid || FAKE_PRINTER_IDENTITY.serviceUuid,
        characteristicUuid:
          preference?.characteristicUuid || FAKE_PRINTER_IDENTITY.characteristicUuid,
      };
    },
```

  4. After `BLUETOOTH_PRINTER_FILTER_SERVICE`, add:

```ts
/** The candidate services in try order: a stored preference (lower-cased) first, then the v1
 * candidates without it. With no preference this is the candidate list itself, so the
 * `requestDevice` call stays exactly v1's shape. */
export function orderCandidateServices(preferred?: string): (number | string)[] {
  if (!preferred) return BLUETOOTH_PRINTER_CANDIDATE_SERVICES;
  const normalized = preferred.toLowerCase();
  return [
    normalized,
    ...BLUETOOTH_PRINTER_CANDIDATE_SERVICES.filter((service) => service !== normalized),
  ];
}
```

  5. Replace the Bluetooth transport's `pair()` body with:

```ts
    async pair(preference) {
      ensureBluetoothAvailable();
      const services = orderCandidateServices(preference?.serviceUuid);
      const preferredCharacteristic = preference?.characteristicUuid?.toLowerCase();
      const paired = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLUETOOTH_PRINTER_FILTER_SERVICE] }],
        optionalServices: services,
      });
      device = paired;
      paired.addEventListener("gattserverdisconnected", notifyUnexpectedDisconnect);
      const server = await connectGattWithRetry();

      for (const serviceId of services) {
        let service: BluetoothRemoteGATTService;
        try {
          service = await server.getPrimaryService(serviceId);
        } catch {
          continue;
        }
        let characteristics: BluetoothRemoteGATTCharacteristic[];
        try {
          characteristics = await service.getCharacteristics();
        } catch {
          continue;
        }
        const writableCharacteristics = characteristics.filter(
          (c) => c.properties.write || c.properties.writeWithoutResponse
        );
        const writable =
          writableCharacteristics.find((c) => c.uuid === preferredCharacteristic) ??
          writableCharacteristics[0];
        if (writable) {
          characteristic = writable;
          return {
            deviceId: paired.id,
            name: paired.name ?? "",
            serviceUuid: service.uuid,
            characteristicUuid: writable.uuid,
          };
        }
      }

      // (keep the existing comment block about disconnecting before throwing)
      detachDeviceListener();
      device?.gatt?.disconnect();
      device = null;
      throw new PrintTransportError(
        "characteristic_not_found",
        "No writable characteristic found in candidate Bluetooth printer services."
      );
    },
```

  Also update the module doc's sentence "no persisted `deviceId`/`getDevices` silent-reconnect path"
  to add: "the stored `printerTransport` UUIDs are only a try-first preference; pairing still needs
  the gesture".

- [ ] **Step 4: Run and see them pass**

Run: `npx vitest run tests/client/printing-transport.test.ts`
Expected: PASS. (Typecheck errors in `PrintExecutor.tsx` are fixed in Task 4; do not run `tsc` yet.)

- [ ] **Step 5: Commit** `git add src/client/printing/transport.ts tests/client/printing-transport.test.ts && git commit -m "feat(printing): pairing returns the printer identity and accepts a preferred endpoint"`

---

### Task 4: Printer session exposes `pairedDevice` and `pair(preference)`

**Files:**
- Modify: `src/client/printing/PrintExecutor.tsx`
- Modify: `src/client/printing/PrinterAttention.tsx:39`
- Modify: `src/client/admin/PrintingManagement.tsx:125` (temporary one-line fix; rewritten in Task 7)
- Test: `tests/client/printing-executor.test.tsx`

**Interfaces:**
- Consumes: `PrinterEndpointPreference`, `PrintTransport.pair(preference)` from Task 3.
- Produces: `PrinterSession` (exported from `src/client/printing/PrintExecutor.tsx`, re-exported hook `usePrinterSession` from `@/printing/PrinterSession`):

```ts
export interface PrinterSession {
  active: boolean;
  displayState: DisplayState;
  stateLabelKey: /* unchanged union */;
  canPair: boolean;
  /** The identity resolved by the last successful pairing; kept across disconnects. */
  pairedDevice: PrinterTransportSettings | null;
  pair: (preference?: PrinterEndpointPreference) => void;
}
```

- [ ] **Step 1: Write the failing tests** in `tests/client/printing-executor.test.tsx`:
  - in `ExecutorSessionProbe`, change `onClick={session.pair}` to `onClick={() => session.pair()}` and add, after the pair button block:

```tsx
      <output data-testid="print-executor-paired-device">
        {session.pairedDevice?.deviceId ?? ""}
      </output>
```

  - add inside `describe("PrintExecutor", ...)`:

```ts
  it("exposes the paired device identity after a successful pair", async () => {
    const transport = createFakePrintTransport();
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true })); // capability
    mockFetch.mockResolvedValue(new Response(null, { status: 204 })); // claims: nothing to do

    renderExecutor({ transport, pollIntervalMs: 60_000 });
    expect(screen.getByTestId("print-executor-paired-device")).toHaveTextContent("");
    fireEvent.click(screen.getByTestId("print-executor-pair-button"));
    await flushMicrotasks();

    expect(screen.getByTestId("print-executor-state")).toHaveTextContent("Ready");
    expect(screen.getByTestId("print-executor-paired-device")).toHaveTextContent("fake-printer");
  });

  it("passes a pairing preference through to the transport", async () => {
    const transport = createFakePrintTransport();
    const pairSpy = vi.spyOn(transport, "pair");
    mockFetch.mockResolvedValueOnce(jsonResponse({ registered: true }));
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));

    function PreferenceProbe() {
      const session = usePrinterSession();
      return (
        <button
          type="button"
          data-testid="pair-with-preference"
          onClick={() =>
            session?.pair({ serviceUuid: "000018f0-0000-1000-8000-00805f9b34fb" })
          }
        >
          pair
        </button>
      );
    }
    render(
      <LanguageProvider>
        <PrintExecutor transport={transport} pollIntervalMs={60_000}>
          <PreferenceProbe />
        </PrintExecutor>
      </LanguageProvider>
    );
    fireEvent.click(screen.getByTestId("pair-with-preference"));
    await flushMicrotasks();

    expect(pairSpy).toHaveBeenCalledWith({ serviceUuid: "000018f0-0000-1000-8000-00805f9b34fb" });
  });
```

- [ ] **Step 2: Run and see them fail**

Run: `npx vitest run tests/client/printing-executor.test.tsx`
Expected: the two new tests FAIL (`pairedDevice` undefined / preference not forwarded).

- [ ] **Step 3: Implement** in `src/client/printing/PrintExecutor.tsx`:
  - imports: add `PrinterTransportSettings` to the `import type {...} from "../../shared"` and `type PrinterEndpointPreference` to the `./transport` import;
  - extend `PrinterSession` as in Interfaces;
  - state: `const [pairedDevice, setPairedDevice] = useState<PrinterTransportSettings | null>(null);`
  - replace `handlePair` with:

```ts
  const handlePair = useCallback(
    (preference?: PrinterEndpointPreference) => {
      setConnection("pairing");
      setLastError(null);
      transport
        .pair(preference)
        // FR-021/ADR-035: capability registration happens HERE, before this promise chain ever
        // lets the poll effect see connection === "paired" (no first-claim race).
        .then(async (identity) => {
          await registerCapability();
          return identity;
        })
        .then((identity) => {
          setPairedDevice(identity);
          setConnection("paired");
        })
        .catch((err: unknown) => {
          // (keep the existing comment about disconnecting the orphaned GATT connection)
          transport.disconnect();
          setConnection("unpaired");
          setLastError(describeError(err));
        });
    },
    [registerCapability, transport]
  );
```

  - add `pairedDevice,` to BOTH provider values (the inactive-plugin value object and `session`).
- [ ] **Step 4: Fix the two other call sites** (TypeScript rejects passing a click event as the preference):
  - `src/client/printing/PrinterAttention.tsx:39`: `onClick={() => session.pair()}`
  - `src/client/admin/PrintingManagement.tsx:125`: `onClick={() => printerSession.pair()}`

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run tests/client/printing-executor.test.tsx tests/client/printer-attention.test.tsx tests/client/printing-surfaces.test.tsx tests/client/printing-transport.test.ts && npm run typecheck`
Expected: PASS, typecheck exit 0.

- [ ] **Step 6: Commit** `git add src/client/printing tests/client/printing-executor.test.tsx src/client/admin/PrintingManagement.tsx && git commit -m "feat(printing): printer session exposes the paired device"`

---

### Task 5: i18n block and the Diagnostics tab

**Files:**
- Modify: `src/client/i18n/messages.ts` (two `// admin-printer` blocks)
- Create: `src/client/admin/printer/PrinterDiagnosticsTab.tsx`
- Create: `tests/client/helpers/fetchRoutes.ts`
- Create: `tests/client/printer-diagnostics-tab.test.tsx`

**Interfaces:**
- Consumes: `POST /api/printing/reset-today` (Task 2), `ResetTodayPrintsResponse` (Task 1).
- Produces:
  - `export function PrinterDiagnosticsTab(): React.JSX.Element` (root `data-testid="printer-diagnostics"`)
  - `export const RECENT_PRINTS_LIMIT = 50`
  - `export function printSourceKey(recordKey: string): MessageKey | null`
  - test helper `stubFetchRoutes(routes: Record<string, RouteHandler>)` and `json(body, status?)` in `tests/client/helpers/fetchRoutes.ts`

- [ ] **Step 1: Add the i18n keys.** In `src/client/i18n/messages.ts`, insert right after the en line `"admin.notFound.description": "Open a known admin destination to continue.",`:

```ts
    // admin-printer
    "admin.printer.description": "Printer preferences, connection and diagnostics.",
    "admin.printer.tabs": "Printer sections",
    "admin.printer.tab.settings": "Settings",
    "admin.printer.tab.diagnostics": "Diagnostics",
    "admin.printer.retry": "Retry",
    "admin.printer.settings.loading": "Loading printer settings…",
    "admin.printer.settings.loadError": "The printer settings could not be loaded.",
    "admin.printer.plugin.title": "Printing plugin",
    "admin.printer.plugin.manage": "Manage plugins",
    "admin.printer.autoPrint.title": "Auto-print after morning chores",
    "admin.printer.autoPrint.on": "On",
    "admin.printer.autoPrint.off": "Off",
    "admin.printer.autoPrint.manage": "Change in Daily Briefing",
    "admin.printer.autoPrint.loadError": "The auto-print setting could not be read.",
    "admin.printer.paperWidth": "Paper width (dots)",
    "admin.printer.paperWidth.hint": "Printouts are currently rendered at 576 dots (80 mm paper).",
    "admin.printer.paperWidth.invalid": "Enter a whole number greater than 0.",
    "admin.printer.bluetooth.title": "Bluetooth",
    "admin.printer.bluetooth.description": "The printer connects to this browser over Bluetooth.",
    "admin.printer.connection": "Connection",
    "admin.printer.connectedTo": "Connected to {name}",
    "admin.printer.name": "Friendly name",
    "admin.printer.deviceId": "Device ID (set when you pair)",
    "admin.printer.advanced": "Advanced (UUIDs)",
    "admin.printer.serviceUuid": "Service UUID",
    "admin.printer.characteristicUuid": "Characteristic UUID",
    "admin.printer.transport.invalid":
      "Pair a printer, or fill in the name, device ID and both UUIDs.",
    "admin.printer.pairedUnsaved": "Printer paired. Save to remember it.",
    "admin.printer.defaultName": "Thermal printer",
    "admin.printer.save": "Save",
    "admin.printer.saving": "Saving…",
    "admin.printer.saved": "Saved.",
    "admin.printer.saveError": "The printer settings could not be saved.",
    "admin.printer.reset.button": "Reset today's print",
    "admin.printer.reset.title": "Reset today's print?",
    "admin.printer.reset.description":
      "Everything printed or queued for today can print again. Today's queued jobs are cancelled; a job already sending finishes.",
    "admin.printer.reset.confirm": "Reset",
    "admin.printer.reset.cancel": "Cancel",
    "admin.printer.reset.done":
      "Today's print was reset: {records} record(s) can print again, {jobs} queued job(s) cancelled.",
    "admin.printer.reset.nothing": "Nothing was printed or queued today.",
    "admin.printer.reset.error": "Could not reset today's print.",
    "admin.printer.recent.title": "Recent prints",
    "admin.printer.recent.refresh": "Refresh",
    "admin.printer.recent.limited": "Showing the latest 50.",
    "admin.printer.col.when": "When",
    "admin.printer.col.date": "For",
    "admin.printer.col.member": "Member",
    "admin.printer.col.source": "Source",
    "admin.printer.col.status": "Status",
    "admin.printer.col.attempts": "Attempts",
    "admin.printer.col.reason": "Failure reason",
    "admin.printer.source.test": "Test print",
    "admin.printer.source.briefing": "Daily briefing",
```

and right after the es line `"admin.notFound.description": "Abre un destino de administración conocido para continuar.",`:

```ts
    // admin-printer
    "admin.printer.description": "Preferencias, conexión y diagnóstico de la impresora.",
    "admin.printer.tabs": "Secciones de la impresora",
    "admin.printer.tab.settings": "Ajustes",
    "admin.printer.tab.diagnostics": "Diagnóstico",
    "admin.printer.retry": "Reintentar",
    "admin.printer.settings.loading": "Cargando ajustes de la impresora…",
    "admin.printer.settings.loadError": "No se pudieron cargar los ajustes de la impresora.",
    "admin.printer.plugin.title": "Complemento de impresión",
    "admin.printer.plugin.manage": "Gestionar complementos",
    "admin.printer.autoPrint.title": "Imprimir al terminar las tareas de la mañana",
    "admin.printer.autoPrint.on": "Activada",
    "admin.printer.autoPrint.off": "Desactivada",
    "admin.printer.autoPrint.manage": "Cambiar en el resumen diario",
    "admin.printer.autoPrint.loadError": "No se pudo leer la impresión automática.",
    "admin.printer.paperWidth": "Ancho del papel (puntos)",
    "admin.printer.paperWidth.hint":
      "Las impresiones se generan ahora a 576 puntos (papel de 80 mm).",
    "admin.printer.paperWidth.invalid": "Introduce un número entero mayor que 0.",
    "admin.printer.bluetooth.title": "Bluetooth",
    "admin.printer.bluetooth.description":
      "La impresora se conecta a este navegador por Bluetooth.",
    "admin.printer.connection": "Conexión",
    "admin.printer.connectedTo": "Conectada a {name}",
    "admin.printer.name": "Nombre",
    "admin.printer.deviceId": "ID del dispositivo (se rellena al emparejar)",
    "admin.printer.advanced": "Avanzado (UUID)",
    "admin.printer.serviceUuid": "UUID del servicio",
    "admin.printer.characteristicUuid": "UUID de la característica",
    "admin.printer.transport.invalid":
      "Empareja una impresora o rellena el nombre, el ID del dispositivo y los dos UUID.",
    "admin.printer.pairedUnsaved": "Impresora emparejada. Guarda para recordarla.",
    "admin.printer.defaultName": "Impresora térmica",
    "admin.printer.save": "Guardar",
    "admin.printer.saving": "Guardando…",
    "admin.printer.saved": "Guardado.",
    "admin.printer.saveError": "No se pudieron guardar los ajustes de la impresora.",
    "admin.printer.reset.button": "Reiniciar la impresión de hoy",
    "admin.printer.reset.title": "¿Reiniciar la impresión de hoy?",
    "admin.printer.reset.description":
      "Todo lo impreso o en cola hoy se podrá volver a imprimir. Se cancelan los trabajos en cola de hoy; uno que ya se esté enviando termina.",
    "admin.printer.reset.confirm": "Reiniciar",
    "admin.printer.reset.cancel": "Cancelar",
    "admin.printer.reset.done":
      "Impresión de hoy reiniciada: {records} registro(s) se pueden volver a imprimir, {jobs} trabajo(s) en cola cancelado(s).",
    "admin.printer.reset.nothing": "Hoy no se ha impreso ni encolado nada.",
    "admin.printer.reset.error": "No se pudo reiniciar la impresión de hoy.",
    "admin.printer.recent.title": "Impresiones recientes",
    "admin.printer.recent.refresh": "Actualizar",
    "admin.printer.recent.limited": "Se muestran las 50 más recientes.",
    "admin.printer.col.when": "Cuándo",
    "admin.printer.col.date": "Para",
    "admin.printer.col.member": "Miembro",
    "admin.printer.col.source": "Origen",
    "admin.printer.col.status": "Estado",
    "admin.printer.col.attempts": "Intentos",
    "admin.printer.col.reason": "Motivo del fallo",
    "admin.printer.source.test": "Impresión de prueba",
    "admin.printer.source.briefing": "Resumen diario",
```

Run `npx prettier --write src/client/i18n/messages.ts` (line wrapping is enforced by `format:check`).

- [ ] **Step 2: Create the fetch router helper** `tests/client/helpers/fetchRoutes.ts`:

```ts
import { vi } from "vitest";

export type RouteHandler = (init?: RequestInit) => Response | Promise<Response>;

/** Stubs global `fetch` with a `"METHOD /path?query"` table so a component's parallel reads
 * cannot steal each other's queued responses. An unexpected request rejects loudly. */
export function stubFetchRoutes(routes: Record<string, RouteHandler>) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url.pathname}${url.search}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler(init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}
```

- [ ] **Step 3: Write the failing tests** `tests/client/printer-diagnostics-tab.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { PrinterDiagnosticsTab, RECENT_PRINTS_LIMIT } from "@/admin/printer/PrinterDiagnosticsTab";
import type { PrintJob } from "../../src/shared";
import { json, stubFetchRoutes } from "./helpers/fetchRoutes";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: "en",
    weekStartDay: 1,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
  }),
}));

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function makeJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: "job-1",
    recordKey: "test-print",
    outputRef: "test-print:2026-10-15",
    targetDate: "2026-10-15",
    memberId: null,
    state: "printed",
    derivedState: "printed",
    attempts: 0,
    failureReason: null,
    claimedAt: null,
    printedAt: null,
    createdAt: Date.UTC(2026, 9, 15, 6, 30),
    updatedAt: Date.UTC(2026, 9, 15, 6, 30),
    ...overrides,
  };
}

const MEMBERS = [{ id: "m-lisa", displayName: "Lisa" }];

function routes(jobs: PrintJob[], extra: Record<string, () => Response> = {}) {
  return stubFetchRoutes({
    "GET /api/printing/jobs": () => json({ jobs }),
    "GET /api/members?lifecycle=all": () => json(MEMBERS),
    ...extra,
  });
}

function renderTab() {
  return render(
    <LanguageProvider>
      <PrinterDiagnosticsTab />
    </LanguageProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrinterDiagnosticsTab — recent prints", () => {
  it("renders member, source, status, attempts and failure reason per job", async () => {
    routes([
      makeJob({
        id: "j-brief",
        recordKey: "daily-briefing:m-lisa",
        memberId: "m-lisa",
        state: "failed",
        derivedState: "dead-letter",
        attempts: 2,
        failureReason: "render_failure: provider error",
      }),
      makeJob({ id: "j-test" }),
      makeJob({ id: "j-other", recordKey: "custom-producer:1", memberId: "m-gone" }),
    ]);
    renderTab();
    await flush();

    const brief = screen.getByTestId("printing-job-j-brief");
    expect(within(brief).getByText("Lisa")).toBeInTheDocument();
    expect(within(brief).getByText("Daily briefing")).toBeInTheDocument();
    expect(within(brief).getByText("2")).toBeInTheDocument();
    expect(within(brief).getByText("render_failure: provider error")).toBeInTheDocument();
    expect(screen.getByTestId("printing-job-state-j-brief")).toHaveTextContent("Dead-lettered");
    expect(screen.getByTestId("printing-job-state-j-brief")).toHaveAttribute("role", "alert");
    expect(within(screen.getByTestId("printing-job-j-test")).getByText("Test print")).toBeInTheDocument();
    const other = screen.getByTestId("printing-job-j-other");
    expect(within(other).getByText("custom-producer:1")).toBeInTheDocument();
    expect(within(other).getByText("—")).toBeInTheDocument(); // unknown member
  });

  it("still renders the table with '—' when the members read fails", async () => {
    stubFetchRoutes({
      "GET /api/printing/jobs": () => json({ jobs: [makeJob({ memberId: "m-lisa" })] }),
      "GET /api/members?lifecycle=all": () => json({ error: "boom" }, 500),
    });
    renderTab();
    await flush();
    expect(within(screen.getByTestId("printing-job-job-1")).getByText("—")).toBeInTheDocument();
  });

  it("shows at most RECENT_PRINTS_LIMIT rows and says so", async () => {
    const many = Array.from({ length: RECENT_PRINTS_LIMIT + 5 }, (_, i) => makeJob({ id: `j${i}` }));
    routes(many);
    renderTab();
    await flush();
    expect(screen.getAllByTestId(/^printing-job-j\d+$/)).toHaveLength(RECENT_PRINTS_LIMIT);
    expect(screen.getByText("Showing the latest 50.")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    routes([]);
    renderTab();
    await flush();
    expect(screen.getByTestId("printing-jobs-empty")).toBeInTheDocument();
  });

  it("offers Retry after a jobs load failure and recovers", async () => {
    let fail = true;
    stubFetchRoutes({
      "GET /api/printing/jobs": () => (fail ? json({ error: "x" }, 500) : json({ jobs: [makeJob()] })),
      "GET /api/members?lifecycle=all": () => json(MEMBERS),
    });
    renderTab();
    await flush();
    expect(screen.getByTestId("printing-list-error")).toHaveTextContent("Failed to load print jobs.");
    fail = false;
    fireEvent.click(screen.getByTestId("printing-jobs-retry"));
    await flush();
    expect(screen.getByTestId("printing-job-job-1")).toBeInTheDocument();
  });

  it("Refresh reloads the jobs", async () => {
    const mock = routes([]);
    renderTab();
    await flush();
    fireEvent.click(screen.getByTestId("printing-jobs-refresh"));
    await flush();
    const jobReads = mock.mock.calls.filter(([input]) => String(input).endsWith("/api/printing/jobs"));
    expect(jobReads).toHaveLength(2);
  });
});

describe("PrinterDiagnosticsTab — test print", () => {
  it.each([
    [json({ enqueued: true, jobId: "j9" }), "Test print enqueued.", false],
    [json({ enqueued: false, jobId: "j9", alreadyPrinted: true }), "Already printed for today — not re-enqueued.", false],
    [json({ error: "plugin_inactive" }, 409), "The Printing plugin is inactive.", true],
    [json({ error: "x" }, 500), "Failed to trigger the test print.", true],
  ])("shows the trigger outcome (%#)", async (response, message, isAlert) => {
    routes([], { "POST /api/printing/test-print": () => response });
    renderTab();
    await flush();
    fireEvent.click(screen.getByTestId("printing-trigger-test-print"));
    await flush();
    const result = screen.getByTestId("printing-trigger-result");
    expect(result).toHaveTextContent(message);
    if (isAlert) expect(result).toHaveAttribute("role", "alert");
    else expect(result).not.toHaveAttribute("role", "alert");
  });
});

describe("PrinterDiagnosticsTab — reset today's print", () => {
  async function openAndConfirm() {
    fireEvent.click(screen.getByTestId("printing-reset-today"));
    fireEvent.click(await screen.findByTestId("printing-reset-today-confirm"));
    await flush();
  }

  it("confirms, posts, reports the counts and reloads the table", async () => {
    const mock = routes([], {
      "POST /api/printing/reset-today": () =>
        json({ targetDate: "2026-10-15", resetRecords: 2, cancelledJobs: 1 }),
    });
    renderTab();
    await flush();
    await openAndConfirm();
    expect(screen.getByTestId("printing-reset-today-result")).toHaveTextContent(
      "Today's print was reset: 2 record(s) can print again, 1 queued job(s) cancelled."
    );
    const jobReads = mock.mock.calls.filter(([input]) => String(input).endsWith("/api/printing/jobs"));
    expect(jobReads).toHaveLength(2);
  });

  it("says when there was nothing to reset", async () => {
    routes([], {
      "POST /api/printing/reset-today": () =>
        json({ targetDate: "2026-10-15", resetRecords: 0, cancelledJobs: 0 }),
    });
    renderTab();
    await flush();
    await openAndConfirm();
    expect(screen.getByTestId("printing-reset-today-result")).toHaveTextContent(
      "Nothing was printed or queued today."
    );
  });

  it.each([
    [409, "The Printing plugin is inactive."],
    [500, "Could not reset today's print."],
  ])("announces a %s failure", async (status, message) => {
    routes([], { "POST /api/printing/reset-today": () => json({ error: "x" }, status) });
    renderTab();
    await flush();
    await openAndConfirm();
    const result = screen.getByTestId("printing-reset-today-result");
    expect(result).toHaveTextContent(message);
    expect(result).toHaveAttribute("role", "alert");
  });

  it("Cancel closes the dialog without posting", async () => {
    const mock = routes([]);
    renderTab();
    await flush();
    fireEvent.click(screen.getByTestId("printing-reset-today"));
    fireEvent.click(await screen.findByTestId("printing-reset-today-cancel"));
    await flush();
    expect(mock.mock.calls.some(([input]) => String(input).includes("reset-today"))).toBe(false);
  });
});
```

Run: `npx vitest run tests/client/printer-diagnostics-tab.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement** `src/client/admin/printer/PrinterDiagnosticsTab.tsx`:

```tsx
/** Printer diagnostics (FR-016/SC-003): test print through the server queue, "reset today's
 * print", and the recent-prints table. Dead-letter and failed rows are announced through
 * ErrorNotice; every other status is plain text, never collapsed into "pending". */
import { useEffect, useId, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { authFetch } from "@/lib/credential";
import { useHouseholdSettingsContext } from "@/lib/householdSettings";
import { notifyPrintIntentEnqueued } from "@/printing/queueWakeup";
import type {
  JobsListResponse,
  Member,
  PrintJob,
  ResetTodayPrintsResponse,
  TestPrintResponse,
} from "../../../shared";

export const RECENT_PRINTS_LIMIT = 50;

const STATE_LABEL_KEYS: Record<PrintJob["derivedState"], MessageKey> = {
  pending: "printing.management.state.pending",
  claimed: "printing.management.state.claimed",
  printed: "printing.management.state.printed",
  failed: "printing.management.state.failed",
  cancelled: "printing.management.state.cancelled",
  "dead-letter": "printing.management.state.deadLetter",
  retrying: "printing.management.state.retrying",
};

/** dead-letter/failed are the two terminal-and-bad outcomes worth announcing. */
function isUnhealthyState(state: PrintJob["derivedState"]): boolean {
  return state === "dead-letter" || state === "failed";
}

/** The producer behind a record key, when it is one we name; otherwise null (show the key). */
export function printSourceKey(recordKey: string): MessageKey | null {
  if (recordKey === "test-print") return "admin.printer.source.test";
  if (recordKey.startsWith("daily-briefing:")) return "admin.printer.source.briefing";
  return null;
}

type Notice = { text: string; unhealthy: boolean; testId: string };

export function PrinterDiagnosticsTab(): React.JSX.Element {
  const { t, language } = useTranslation();
  const household = useHouseholdSettingsContext();
  const headingId = useId();
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [memberNames, setMemberNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [busy, setBusy] = useState<"test" | "reset" | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function loadJobs(): Promise<void> {
    setLoading(true);
    setListFailed(false);
    const membersRead = authFetch("/api/members?lifecycle=all", { credentials: "include" })
      .then(async (response) => (response.ok ? ((await response.json()) as Member[]) : []))
      .catch((): Member[] => []);
    try {
      const response = await authFetch("/api/printing/jobs", { credentials: "include" });
      if (!response.ok) throw new Error(`jobs: ${response.status}`);
      const data = (await response.json()) as JobsListResponse;
      const members = await membersRead;
      setJobs(data.jobs);
      setMemberNames(new Map(members.map((member) => [member.id, member.displayName])));
    } catch {
      setListFailed(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadJobs();
  }, []);

  async function triggerTestPrint(): Promise<void> {
    setBusy("test");
    setNotice(null);
    try {
      const response = await authFetch("/api/printing/test-print", {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 409) {
        setNotice({
          text: t("printing.management.trigger.pluginInactive"),
          unhealthy: true,
          testId: "printing-trigger-result",
        });
        return;
      }
      if (!response.ok) throw new Error(`test-print: ${response.status}`);
      const data = (await response.json()) as TestPrintResponse;
      if (data.enqueued) notifyPrintIntentEnqueued();
      setNotice({
        text: t(
          data.alreadyPrinted
            ? "printing.management.trigger.alreadyPrinted"
            : "printing.management.trigger.enqueued"
        ),
        unhealthy: false,
        testId: "printing-trigger-result",
      });
      await loadJobs();
    } catch {
      setNotice({
        text: t("printing.management.trigger.error"),
        unhealthy: true,
        testId: "printing-trigger-result",
      });
    } finally {
      setBusy(null);
    }
  }

  async function resetToday(): Promise<void> {
    setBusy("reset");
    setNotice(null);
    try {
      const response = await authFetch("/api/printing/reset-today", {
        method: "POST",
        credentials: "include",
      });
      if (response.status === 409) {
        setNotice({
          text: t("printing.management.trigger.pluginInactive"),
          unhealthy: true,
          testId: "printing-reset-today-result",
        });
        return;
      }
      if (!response.ok) throw new Error(`reset-today: ${response.status}`);
      const data = (await response.json()) as ResetTodayPrintsResponse;
      setNotice({
        text:
          data.resetRecords === 0
            ? t("admin.printer.reset.nothing")
            : t("admin.printer.reset.done")
                .replace("{records}", String(data.resetRecords))
                .replace("{jobs}", String(data.cancelledJobs)),
        unhealthy: false,
        testId: "printing-reset-today-result",
      });
      await loadJobs();
    } catch {
      setNotice({
        text: t("admin.printer.reset.error"),
        unhealthy: true,
        testId: "printing-reset-today-result",
      });
    } finally {
      setBusy(null);
    }
  }

  const formatter = new Intl.DateTimeFormat(language === "es" ? "es-ES" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    ...(household?.timezone ? { timeZone: household.timezone } : {}),
  });
  const visibleJobs = jobs.slice(0, RECENT_PRINTS_LIMIT);
  const columns: MessageKey[] = [
    "admin.printer.col.when",
    "admin.printer.col.date",
    "admin.printer.col.member",
    "admin.printer.col.source",
    "admin.printer.col.status",
    "admin.printer.col.attempts",
    "admin.printer.col.reason",
  ];

  return (
    <div className="flex flex-col gap-6" data-testid="printer-diagnostics">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          data-testid="printing-trigger-test-print"
          disabled={busy !== null}
          onClick={() => void triggerTestPrint()}
        >
          {busy === "test"
            ? t("printing.management.triggering")
            : t("printing.management.triggerButton")}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="printing-reset-today"
          disabled={busy !== null}
          onClick={() => setConfirmOpen(true)}
        >
          {t("admin.printer.reset.button")}
        </Button>
      </div>
      {notice &&
        (notice.unhealthy ? (
          <ErrorNotice message={notice.text} data-testid={notice.testId} politeness="assertive" />
        ) : (
          <p data-testid={notice.testId} className="text-muted-foreground text-sm">
            {notice.text}
          </p>
        ))}

      <section className="flex flex-col gap-3" aria-labelledby={headingId}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 id={headingId} className="text-lg font-semibold">
            {t("admin.printer.recent.title")}
          </h3>
          <Button
            type="button"
            variant="outline"
            data-testid="printing-jobs-refresh"
            disabled={loading}
            onClick={() => void loadJobs()}
          >
            {t("admin.printer.recent.refresh")}
          </Button>
        </div>
        {loading ? (
          <p className="text-muted-foreground text-sm">{t("printing.management.loading")}</p>
        ) : listFailed ? (
          <div className="flex flex-col items-start gap-3">
            <ErrorNotice message={t("printing.management.loadError")} data-testid="printing-list-error" />
            <Button
              type="button"
              variant="outline"
              data-testid="printing-jobs-retry"
              onClick={() => void loadJobs()}
            >
              {t("admin.printer.retry")}
            </Button>
          </div>
        ) : jobs.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="printing-jobs-empty">
            {t("printing.management.empty")}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table data-testid="printing-jobs-table" className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b">
                    {columns.map((key) => (
                      <th key={key} scope="col" className="py-2 pr-4 font-semibold">
                        {t(key)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleJobs.map((job) => {
                    const sourceKey = printSourceKey(job.recordKey);
                    const memberName = job.memberId ? memberNames.get(job.memberId) : undefined;
                    return (
                      <tr
                        key={job.id}
                        data-testid={`printing-job-${job.id}`}
                        className="border-b align-top last:border-0"
                      >
                        <td className="py-2 pr-4 whitespace-nowrap">
                          {formatter.format(job.createdAt)}
                        </td>
                        <td className="py-2 pr-4 whitespace-nowrap">{job.targetDate}</td>
                        <td className="py-2 pr-4">{memberName ?? "—"}</td>
                        <td className="py-2 pr-4">{sourceKey ? t(sourceKey) : job.recordKey}</td>
                        <td className="py-2 pr-4">
                          {isUnhealthyState(job.derivedState) ? (
                            <ErrorNotice
                              message={t(STATE_LABEL_KEYS[job.derivedState])}
                              data-testid={`printing-job-state-${job.id}`}
                              politeness="polite"
                              className="border-0 bg-transparent p-0 text-sm"
                            />
                          ) : (
                            <span data-testid={`printing-job-state-${job.id}`}>
                              {t(STATE_LABEL_KEYS[job.derivedState])}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-4 tabular-nums">{job.attempts}</td>
                        <td className="py-2 pr-4">{job.failureReason ?? ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {jobs.length > RECENT_PRINTS_LIMIT && (
              <p className="text-muted-foreground text-sm">{t("admin.printer.recent.limited")}</p>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("admin.printer.reset.title")}
        description={t("admin.printer.reset.description")}
        confirmLabel={t("admin.printer.reset.confirm")}
        cancelLabel={t("admin.printer.reset.cancel")}
        onConfirm={() => void resetToday()}
        confirmTestId="printing-reset-today-confirm"
        cancelTestId="printing-reset-today-cancel"
      />
    </div>
  );
}
```

  The table cell `<ErrorNotice>` renders a `<p>` inside a `<td>`, which is valid. Only coloured
  scale classes (`text-red-600`, `bg-gray-100`, …) count as UI debt; `text-sm`/`text-lg` are fine.

- [ ] **Step 5: Run and see them pass**

Run: `npx vitest run tests/client/printer-diagnostics-tab.test.tsx && npm run typecheck && npx eslint src/client/admin/printer tests/client/printer-diagnostics-tab.test.tsx tests/client/helpers/fetchRoutes.ts`
Expected: PASS / exit 0. If request keys never match, print `String(input)` once: `appUrl` prefixes the `<meta name="mp-base-path">` base path, which is empty in jsdom.

- [ ] **Step 6: Commit** `git add src/client/i18n/messages.ts src/client/admin/printer/PrinterDiagnosticsTab.tsx tests/client/helpers/fetchRoutes.ts tests/client/printer-diagnostics-tab.test.tsx && git commit -m "feat(admin): printer diagnostics tab with reset and recent prints"`

---

### Task 6: Settings tab

**Files:**
- Create: `src/client/admin/printer/PrinterSettingsTab.tsx`
- Create: `tests/client/printer-settings-tab.test.tsx`

**Interfaces:**
- Consumes: `usePrinterSession()` → `PrinterSession` with `pairedDevice`, `pair(preference?)` (Task 4); `FAKE_PRINTER_IDENTITY` (Task 3, tests only); i18n keys (Task 5); `stubFetchRoutes`, `json` (Task 5).
- Produces:
  - `export function PrinterSettingsTab(): React.JSX.Element` (root `data-testid="printer-settings"`)
  - `export function isTransportValid(transport: PrinterTransportSettings): boolean`
  - `export function parsePaperWidth(raw: string): number | null`

- [ ] **Step 1: Write the failing tests** `tests/client/printer-settings-tab.test.tsx`:

```tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import {
  PrinterSettingsTab,
  isTransportValid,
  parsePaperWidth,
} from "@/admin/printer/PrinterSettingsTab";
import { PrinterSessionProvider } from "@/printing/PrinterSession";
import { createFakePrintTransport, FAKE_PRINTER_IDENTITY } from "@/printing/transport";
import { json, stubFetchRoutes, type RouteHandler } from "./helpers/fetchRoutes";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: "en",
    weekStartDay: 1,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
  }),
}));
vi.mock("@/printing/pluginStatus", () => ({ usePrintingPluginActive: () => true }));

const EMPTY = { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" };
const KITCHEN = {
  deviceId: "dev-kitchen",
  name: "Kitchen",
  serviceUuid: "000018f0-0000-1000-8000-00805f9b34fb",
  characteristicUuid: "00002af1-0000-1000-8000-00805f9b34fb",
};

function settings(printerTransport = EMPTY, paperWidthDots = 576) {
  return { locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 }, printer: { paperWidthDots }, printerTransport };
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function baseRoutes(extra: Record<string, RouteHandler> = {}) {
  return stubFetchRoutes({
    "GET /api/settings": () => json(settings()),
    "GET /api/daily-briefing/settings": () => json({ autoPrintTrigger: "morning_complete" }),
    "POST /api/printing/capability": () => json({ registered: true }),
    "POST /api/printing/claim": () => new Response(null, { status: 204 }),
    ...extra,
  });
}

function renderTab(withSession = false) {
  const tab = <PrinterSettingsTab />;
  return render(
    <LanguageProvider>
      {withSession ? (
        <PrinterSessionProvider transport={createFakePrintTransport()} pollIntervalMs={60_000}>
          {tab}
        </PrinterSessionProvider>
      ) : (
        tab
      )}
    </LanguageProvider>
  );
}

function putBodies(mock: ReturnType<typeof stubFetchRoutes>) {
  return mock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([, init]) => JSON.parse(String(init?.body)));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("printer settings helpers", () => {
  it("parsePaperWidth accepts whole numbers > 0 only", () => {
    expect(parsePaperWidth("576")).toBe(576);
    expect(parsePaperWidth(" 384 ")).toBe(384);
    for (const raw of ["", "0", "-1", "1.5", "abc"]) expect(parsePaperWidth(raw)).toBeNull();
  });

  it("isTransportValid mirrors the server rule", () => {
    expect(isTransportValid(EMPTY)).toBe(true);
    expect(isTransportValid(KITCHEN)).toBe(true);
    expect(isTransportValid({ ...EMPTY, name: "Kitchen" })).toBe(false);
    // a UUID whose version nibble is not 1-5 is rejected, like the server does
    expect(isTransportValid({ ...KITCHEN, serviceUuid: "49535343-fe7d-fae5-8fa9-9fafd205e455" })).toBe(false);
  });
});

describe("PrinterSettingsTab", () => {
  it("shows plugin state, auto-print state, paper width and the stored printer", async () => {
    baseRoutes({ "GET /api/settings": () => json(settings(KITCHEN, 576)) });
    renderTab();
    await flush();
    expect(screen.getByTestId("printer-plugin-state")).toHaveTextContent("Active");
    expect(screen.getByTestId("printer-autoprint-state")).toHaveTextContent("On");
    expect(screen.getByTestId("printer-paper-width")).toHaveValue(576);
    expect(screen.getByTestId("printer-name")).toHaveValue("Kitchen");
    expect(screen.getByTestId("printer-device-id")).toHaveValue("dev-kitchen");
    expect(screen.getByTestId("printer-device-id")).toHaveAttribute("readonly");
    expect(screen.getByTestId("printer-service-uuid")).toHaveValue(KITCHEN.serviceUuid);
    expect(screen.getByTestId("printer-settings-save")).toBeDisabled(); // nothing changed
  });

  it("offers Retry when the settings cannot be loaded", async () => {
    let fail = true;
    baseRoutes({ "GET /api/settings": () => (fail ? json({ error: "x" }, 500) : json(settings())) });
    renderTab();
    await flush();
    expect(screen.getByTestId("printer-settings-error")).toHaveTextContent(
      "The printer settings could not be loaded."
    );
    fail = false;
    fireEvent.click(screen.getByTestId("printer-settings-retry"));
    await flush();
    expect(screen.getByTestId("printer-paper-width")).toBeInTheDocument();
  });

  it("auto-print read failure shows its own Retry and does not block the form", async () => {
    let fail = true;
    baseRoutes({
      "GET /api/daily-briefing/settings": () =>
        fail ? json({ error: "x" }, 500) : json({ autoPrintTrigger: null }),
    });
    renderTab();
    await flush();
    expect(screen.getByTestId("printer-autoprint-error")).toBeInTheDocument();
    expect(screen.getByTestId("printer-paper-width")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByTestId("printer-autoprint-retry"));
    await flush();
    expect(screen.getByTestId("printer-autoprint-state")).toHaveTextContent("Off");
  });

  it("saves only the changed object and shows Saved", async () => {
    const mock = baseRoutes({ "PUT /api/settings": () => json(settings(EMPTY, 384)) });
    renderTab();
    await flush();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "384" } });
    fireEvent.click(screen.getByTestId("printer-settings-save"));
    await flush();
    expect(putBodies(mock)).toEqual([{ object: "printer", settings: { paperWidthDots: 384 } }]);
    expect(screen.getByTestId("printer-settings-saved")).toHaveTextContent("Saved.");
  });

  it("blocks Save on an invalid width or a half-filled printer", async () => {
    baseRoutes();
    renderTab();
    await flush();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "0" } });
    expect(screen.getByText("Enter a whole number greater than 0.")).toBeInTheDocument();
    expect(screen.getByTestId("printer-settings-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "576" } });
    fireEvent.change(screen.getByTestId("printer-name"), { target: { value: "Kitchen" } });
    expect(screen.getByTestId("printer-transport-error")).toBeInTheDocument();
    expect(screen.getByTestId("printer-settings-save")).toBeDisabled();
  });

  it("keeps the edits and shows the error when the transport save fails after the width saved", async () => {
    const mock = baseRoutes({
      "GET /api/settings": () => json(settings(KITCHEN)),
      "PUT /api/settings": (init) =>
        JSON.parse(String(init?.body)).object === "printer"
          ? json(settings(KITCHEN, 384))
          : json({ error: "invalid_settings" }, 400),
    });
    renderTab();
    await flush();
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "384" } });
    fireEvent.change(screen.getByTestId("printer-name"), { target: { value: "Hall" } });
    fireEvent.click(screen.getByTestId("printer-settings-save"));
    await flush();
    expect(putBodies(mock).map((body) => body.object)).toEqual(["printer", "printerTransport"]);
    expect(screen.getByTestId("printer-settings-save-error")).toHaveTextContent(
      "The printer settings could not be saved."
    );
    expect(screen.getByTestId("printer-name")).toHaveValue("Hall");
  });

  it("pairing fills the printer fields, keeps an unsaved width edit, and Save persists them", async () => {
    const mock = baseRoutes({
      "PUT /api/settings": (init) => {
        const body = JSON.parse(String(init?.body));
        return json(
          body.object === "printer"
            ? settings(EMPTY, body.settings.paperWidthDots)
            : settings(body.settings, 384)
        );
      },
    });
    renderTab(true);
    await flush();
    expect(screen.getByTestId("printer-connection-status")).toHaveTextContent("Not paired");
    fireEvent.change(screen.getByTestId("printer-paper-width"), { target: { value: "384" } });
    fireEvent.click(screen.getByTestId("printing-management-pair"));
    await flush();

    expect(screen.getByTestId("printer-device-id")).toHaveValue(FAKE_PRINTER_IDENTITY.deviceId);
    expect(screen.getByTestId("printer-name")).toHaveValue(FAKE_PRINTER_IDENTITY.name);
    expect(screen.getByTestId("printer-paper-width")).toHaveValue(384);
    expect(screen.getByTestId("printer-paired-unsaved")).toBeInTheDocument();
    expect(screen.getByTestId("printer-connection-status")).toHaveTextContent(
      `Connected to ${FAKE_PRINTER_IDENTITY.name}`
    );

    fireEvent.click(screen.getByTestId("printer-settings-save"));
    await flush();
    expect(putBodies(mock)).toEqual([
      { object: "printer", settings: { paperWidthDots: 384 } },
      { object: "printerTransport", settings: FAKE_PRINTER_IDENTITY },
    ]);
    expect(screen.queryByTestId("printer-paired-unsaved")).not.toBeInTheDocument();
  });

  it("passes the stored UUIDs as the pairing preference", async () => {
    baseRoutes({ "GET /api/settings": () => json(settings(KITCHEN)) });
    const transport = createFakePrintTransport();
    const pairSpy = vi.spyOn(transport, "pair");
    render(
      <LanguageProvider>
        <PrinterSessionProvider transport={transport} pollIntervalMs={60_000}>
          <PrinterSettingsTab />
        </PrinterSessionProvider>
      </LanguageProvider>
    );
    await flush();
    fireEvent.click(screen.getByTestId("printing-management-pair"));
    await flush();
    expect(pairSpy).toHaveBeenCalledWith({
      serviceUuid: KITCHEN.serviceUuid,
      characteristicUuid: KITCHEN.characteristicUuid,
    });
    // a different device id: the device's own name replaces the stored one
    expect(screen.getByTestId("printer-name")).toHaveValue(FAKE_PRINTER_IDENTITY.name);
  });
});
```

Run: `npx vitest run tests/client/printer-settings-tab.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement** `src/client/admin/printer/PrinterSettingsTab.tsx`:

```tsx
/** Printer settings (FR-017): plugin and auto-print state, paper width, and the Bluetooth printer
 * this household uses. Reads/writes the existing `printer` and `printerTransport` settings objects
 * one object per PUT. Pairing (shared printer session) fills the printer fields; Save persists
 * them. Auto-print belongs to Daily Briefing (Printing FR-006): shown read-only with a link. */
import { useCallback, useEffect, useRef, useState } from "react";

import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { appUrl } from "@/lib/base-path";
import { authFetch } from "@/lib/credential";
import { usePluginActive } from "@/plugins/contributions";
import { usePrinterSession } from "@/printing/PrinterSession";
import { navigateHousehold } from "@/shell/routes";
import type { EffectiveSettings, PrinterTransportSettings } from "../../../shared";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMPTY_TRANSPORT: PrinterTransportSettings = {
  deviceId: "",
  name: "",
  serviceUuid: "",
  characteristicUuid: "",
};
const DEFAULT_PAPER_WIDTH = 576;

/** Mirrors the server's `printerTransport` rule (settings/index.ts): all four empty, or a named
 * device with two RFC-4122 (version 1-5) UUIDs. */
export function isTransportValid(transport: PrinterTransportSettings): boolean {
  const { deviceId, name, serviceUuid, characteristicUuid } = transport;
  if ([deviceId, name, serviceUuid, characteristicUuid].every((value) => value.length === 0)) {
    return true;
  }
  return (
    deviceId.trim().length > 0 &&
    name.trim().length > 0 &&
    UUID_PATTERN.test(serviceUuid) &&
    UUID_PATTERN.test(characteristicUuid)
  );
}

/** A whole number of dots greater than zero, or null. */
export function parsePaperWidth(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sameTransport(a: PrinterTransportSettings, b: PrinterTransportSettings): boolean {
  return (
    a.deviceId === b.deviceId &&
    a.name === b.name &&
    a.serviceUuid === b.serviceUuid &&
    a.characteristicUuid === b.characteristicUuid
  );
}

/** An in-app admin link (the `PluginUnavailable` pattern; `navigateAdmin` would be an import cycle). */
function AdminLink({
  path,
  testId,
  children,
}: {
  path: "/admin/plugins" | "/admin/daily-briefing";
  testId: string;
  children: string;
}) {
  return (
    <Button asChild variant="outline" className="w-fit">
      <a
        href={appUrl(path)}
        data-testid={testId}
        onClick={(event) => {
          event.preventDefault();
          navigateHousehold(path);
        }}
      >
        {children}
      </a>
    </Button>
  );
}

function AutoPrintLine() {
  const t = useT();
  const [state, setState] = useState<"loading" | "on" | "off" | "error">("loading");

  const load = useCallback(() => {
    authFetch("/api/daily-briefing/settings", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`briefing settings: ${response.status}`);
        const data = (await response.json()) as { autoPrintTrigger: "morning_complete" | null };
        setState(data.autoPrintTrigger === "morning_complete" ? "on" : "off");
      })
      .catch(() => setState("error"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="font-medium">{t("admin.printer.autoPrint.title")}</span>
      {state === "error" ? (
        <>
          <ErrorNotice
            message={t("admin.printer.autoPrint.loadError")}
            data-testid="printer-autoprint-error"
            politeness="polite"
          />
          <Button
            type="button"
            variant="outline"
            data-testid="printer-autoprint-retry"
            onClick={() => {
              setState("loading");
              load();
            }}
          >
            {t("admin.printer.retry")}
          </Button>
        </>
      ) : state === "loading" ? null : (
        <span data-testid="printer-autoprint-state">
          {t(state === "on" ? "admin.printer.autoPrint.on" : "admin.printer.autoPrint.off")}
        </span>
      )}
      <AdminLink path="/admin/daily-briefing" testId="printer-autoprint-link">
        {t("admin.printer.autoPrint.manage")}
      </AdminLink>
    </div>
  );
}

export function PrinterSettingsTab(): React.JSX.Element {
  const t = useT();
  const session = usePrinterSession();
  const briefingActive = usePluginActive("daily-briefing");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [reloadToken, setReloadToken] = useState(0);
  const [paperWidth, setPaperWidth] = useState("");
  const [transport, setTransport] = useState<PrinterTransportSettings>(EMPTY_TRANSPORT);
  const [baseline, setBaseline] = useState<{
    paperWidthDots: number;
    transport: PrinterTransportSettings;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pairedUnsaved, setPairedUnsaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function apply(settings: EffectiveSettings): void {
    const paperWidthDots = settings.printer?.paperWidthDots ?? DEFAULT_PAPER_WIDTH;
    const nextTransport = settings.printerTransport ?? EMPTY_TRANSPORT;
    setPaperWidth(String(paperWidthDots));
    setTransport(nextTransport);
    setBaseline({ paperWidthDots, transport: nextTransport });
  }

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/settings", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`settings: ${response.status}`);
        const data = (await response.json()) as EffectiveSettings;
        if (cancelled) return;
        apply(data);
        setLoadState("ready");
      })
      .catch(() => {
        if (!cancelled) setLoadState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // A pairing that completes while this tab is open fills the printer fields (never on mount:
  // a session paired earlier must not overwrite what is stored).
  const pairedDevice = session?.pairedDevice ?? null;
  const seenPairedDevice = useRef(pairedDevice);
  useEffect(() => {
    if (!pairedDevice || pairedDevice === seenPairedDevice.current) return;
    seenPairedDevice.current = pairedDevice;
    const fallbackName = t("admin.printer.defaultName");
    setTransport((current) => ({
      deviceId: pairedDevice.deviceId,
      serviceUuid: pairedDevice.serviceUuid,
      characteristicUuid: pairedDevice.characteristicUuid,
      name:
        current.deviceId === pairedDevice.deviceId && current.name.trim()
          ? current.name
          : pairedDevice.name.trim() || fallbackName,
    }));
    setPairedUnsaved(true);
    setSaved(false);
  }, [pairedDevice, t]);

  const width = parsePaperWidth(paperWidth);
  const transportValid = isTransportValid(transport);
  const widthChanged = baseline !== null && width !== null && width !== baseline.paperWidthDots;
  const transportChanged = baseline !== null && !sameTransport(transport, baseline.transport);
  const canSave =
    !saving && width !== null && transportValid && (widthChanged || transportChanged);

  function editTransport(patch: Partial<PrinterTransportSettings>): void {
    setTransport((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  async function put(object: "printer" | "printerTransport", settings: unknown) {
    const response = await authFetch("/api/settings", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ object, settings }),
    });
    if (!response.ok) {
      throw new LocalizedApiError(await responseMessage(response, t("admin.printer.saveError")));
    }
    return (await response.json()) as EffectiveSettings;
  }

  async function save(): Promise<void> {
    if (!canSave || width === null || baseline === null) return;
    setSaving(true);
    setSaveError(null);
    try {
      if (widthChanged) {
        const afterWidth = await put("printer", { paperWidthDots: width });
        const savedWidth = afterWidth.printer?.paperWidthDots ?? width;
        setBaseline((current) => (current ? { ...current, paperWidthDots: savedWidth } : current));
        setPaperWidth(String(savedWidth));
      }
      if (transportChanged) {
        const afterTransport = await put("printerTransport", transport);
        const savedTransport = afterTransport.printerTransport ?? transport;
        setBaseline((current) => (current ? { ...current, transport: savedTransport } : current));
        setTransport(savedTransport);
      }
      setSaved(true);
      setPairedUnsaved(false);
    } catch (cause) {
      setSaveError(
        cause instanceof LocalizedApiError ? cause.message : t("admin.printer.saveError")
      );
    } finally {
      setSaving(false);
    }
  }

  if (loadState === "loading") {
    return (
      <p className="text-muted-foreground text-sm" data-testid="printer-settings">
        {t("admin.printer.settings.loading")}
      </p>
    );
  }
  if (loadState === "error") {
    return (
      <div className="flex flex-col items-start gap-3" data-testid="printer-settings">
        <ErrorNotice
          message={t("admin.printer.settings.loadError")}
          data-testid="printer-settings-error"
        />
        <Button
          type="button"
          variant="outline"
          data-testid="printer-settings-retry"
          onClick={() => {
            setLoadState("loading");
            setReloadToken((token) => token + 1);
          }}
        >
          {t("admin.printer.retry")}
        </Button>
      </div>
    );
  }

  const connected =
    session !== null &&
    pairedDevice !== null &&
    (session.displayState === "paired" ||
      session.displayState === "printing" ||
      session.displayState === "error");
  const statusText =
    connected && pairedDevice
      ? t("admin.printer.connectedTo").replace("{name}", pairedDevice.name || pairedDevice.deviceId)
      : t(session?.stateLabelKey ?? "printing.executor.state.unpaired");
  const pluginActive = session?.active ?? true;

  return (
    <div className="flex flex-col gap-6" data-testid="printer-settings">
      <section className="bg-card flex flex-col gap-3 rounded-lg p-4 shadow">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{t("admin.printer.plugin.title")}</span>
          <span data-testid="printer-plugin-state">
            {t(pluginActive ? "plugins.state.active" : "plugins.state.inactive")}
          </span>
          <AdminLink path="/admin/plugins" testId="printer-plugin-link">
            {t("admin.printer.plugin.manage")}
          </AdminLink>
        </div>
        {briefingActive && <AutoPrintLine />}
      </section>

      <section className="bg-card flex flex-col gap-4 rounded-lg p-4 shadow">
        <Field
          label={t("admin.printer.paperWidth")}
          hint={t("admin.printer.paperWidth.hint")}
          error={width === null ? t("admin.printer.paperWidth.invalid") : null}
        >
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="w-40"
            data-testid="printer-paper-width"
            value={paperWidth}
            onChange={(event) => {
              setPaperWidth(event.target.value);
              setSaved(false);
            }}
          />
        </Field>
      </section>

      <section className="bg-card flex flex-col gap-4 rounded-lg p-4 shadow">
        <div className="flex flex-col gap-1">
          <h3 className="text-lg font-semibold">{t("admin.printer.bluetooth.title")}</h3>
          <p className="text-muted-foreground text-sm">
            {t("admin.printer.bluetooth.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">{t("admin.printer.connection")}</span>
          <span data-testid="printer-connection-status" role="status" aria-live="polite">
            {statusText}
          </span>
          {session?.canPair && (
            <Button
              type="button"
              variant="outline"
              data-testid="printing-management-pair"
              onClick={() =>
                session.pair({
                  serviceUuid: transport.serviceUuid || undefined,
                  characteristicUuid: transport.characteristicUuid || undefined,
                })
              }
            >
              {t(
                session.displayState === "disconnected"
                  ? "printing.executor.repairButton"
                  : "printing.executor.pairButton"
              )}
            </Button>
          )}
        </div>
        {pairedUnsaved && (
          <p className="text-sm" data-testid="printer-paired-unsaved" role="status">
            {t("admin.printer.pairedUnsaved")}
          </p>
        )}
        <Field label={t("admin.printer.name")}>
          <Input
            data-testid="printer-name"
            value={transport.name}
            onChange={(event) => editTransport({ name: event.target.value })}
          />
        </Field>
        <Field label={t("admin.printer.deviceId")}>
          <Input data-testid="printer-device-id" value={transport.deviceId} readOnly />
        </Field>
        <details data-testid="printer-advanced">
          <summary className="cursor-pointer font-semibold">{t("admin.printer.advanced")}</summary>
          <div className="mt-3 flex flex-col gap-3">
            <Field label={t("admin.printer.serviceUuid")}>
              <Input
                className="font-mono"
                data-testid="printer-service-uuid"
                value={transport.serviceUuid}
                onChange={(event) => editTransport({ serviceUuid: event.target.value.trim() })}
              />
            </Field>
            <Field label={t("admin.printer.characteristicUuid")}>
              <Input
                className="font-mono"
                data-testid="printer-characteristic-uuid"
                value={transport.characteristicUuid}
                onChange={(event) =>
                  editTransport({ characteristicUuid: event.target.value.trim() })
                }
              />
            </Field>
          </div>
        </details>
        {!transportValid && (
          <ErrorNotice
            message={t("admin.printer.transport.invalid")}
            data-testid="printer-transport-error"
            politeness="polite"
          />
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          data-testid="printer-settings-save"
          disabled={!canSave}
          onClick={() => void save()}
        >
          {saving ? t("admin.printer.saving") : t("admin.printer.save")}
        </Button>
        {saved && (
          <p className="text-muted-foreground text-sm" data-testid="printer-settings-saved" role="status">
            {t("admin.printer.saved")}
          </p>
        )}
      </div>
      <ErrorNotice message={saveError} data-testid="printer-settings-save-error" />
    </div>
  );
}
```

Notes for the implementer:
- The form is a plain `div`, not `<form>`, so Enter does nothing surprising; Save is the only write.
- `pairedUnsaved` clears only after a successful save, matching the test.
- If `jsdom` reports `toHaveValue(576)` as a string for `type="number"`, keep the number assertion: Testing Library returns numbers for number inputs.

- [ ] **Step 3: Run and see them pass**

Run: `npx vitest run tests/client/printer-settings-tab.test.tsx && npm run typecheck && npx eslint src/client/admin/printer tests/client/printer-settings-tab.test.tsx`
Expected: PASS / exit 0.

- [ ] **Step 4: Commit** `git add src/client/admin/printer/PrinterSettingsTab.tsx tests/client/printer-settings-tab.test.tsx && git commit -m "feat(admin): printer settings tab wired to printer and printerTransport"`

---

### Task 7: Page shell and the existing page tests

**Files:**
- Modify (rewrite): `src/client/admin/PrintingManagement.tsx`
- Modify (rewrite): `tests/client/printing-management.test.tsx`
- Modify: `tests/client/printing-surfaces.test.tsx` (the four `PrintingManagement — ...` describe blocks, lines 126-end)

**Interfaces:**
- Consumes: `PrinterSettingsTab`, `PrinterDiagnosticsTab` (Tasks 5-6).
- Produces: `export function PrintingManagement(): React.JSX.Element` (unchanged name/export; root testid `printing-management`; tab testids `printing-tab-settings`, `printing-tab-diagnostics`).

- [ ] **Step 1: Rewrite the failing page test** `tests/client/printing-management.test.tsx` (replace the whole file; the per-feature cases now live in the two tab test files):

```tsx
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LanguageProvider } from "@/i18n";
import { PrintingManagement } from "@/admin/PrintingManagement";
import { json, stubFetchRoutes } from "./helpers/fetchRoutes";

vi.mock("@/lib/householdSettings", () => ({
  useHouseholdSettingsContext: () => ({
    timezone: "Europe/Madrid",
    language: "en",
    weekStartDay: 1,
    weatherLat: null,
    weatherLon: null,
    weatherLabel: null,
  }),
}));

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrintingManagement", () => {
  it("is titled like the sidebar and opens on Settings; Diagnostics loads the jobs", async () => {
    const mock = stubFetchRoutes({
      "GET /api/settings": () =>
        json({
          locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
          printer: { paperWidthDots: 576 },
          printerTransport: { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" },
        }),
      "GET /api/daily-briefing/settings": () => json({ autoPrintTrigger: null }),
      "GET /api/printing/jobs": () => json({ jobs: [] }),
      "GET /api/members?lifecycle=all": () => json([]),
    });
    render(
      <LanguageProvider>
        <PrintingManagement />
      </LanguageProvider>
    );
    await flush();

    expect(screen.getByRole("heading", { name: "Printer" })).toBeInTheDocument();
    expect(screen.getByTestId("printing-tab-settings")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("printer-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("printer-diagnostics")).not.toBeInTheDocument();
    expect(mock.mock.calls.some(([input]) => String(input).endsWith("/api/printing/jobs"))).toBe(false);

    fireEvent.click(screen.getByTestId("printing-tab-diagnostics"));
    await flush();
    expect(screen.getByTestId("printing-tab-diagnostics")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("printing-jobs-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("printer-settings")).not.toBeInTheDocument();
  });
});
```

Run: `npx vitest run tests/client/printing-management.test.tsx`
Expected: FAIL (old page has no tabs / heading "Printing").

- [ ] **Step 2: Rewrite** `src/client/admin/PrintingManagement.tsx` (replace the whole file):

```tsx
/** Printer admin page (FR-012/FR-013/FR-016/FR-017). Two local-state tabs — never URL sub-routes:
 * `resolveHouseholdRoute` only matches exact admin paths, so a sub-path would relock admin on every
 * switch. Settings is the default (reference parity); only the open tab is mounted, so each tab
 * reads fresh data when opened. */
import { useState } from "react";

import { AdminPanel } from "@/components/AdminPanel";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { PrinterDiagnosticsTab } from "./printer/PrinterDiagnosticsTab";
import { PrinterSettingsTab } from "./printer/PrinterSettingsTab";

type PrinterTab = "settings" | "diagnostics";

export function PrintingManagement(): React.JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<PrinterTab>("settings");
  const tabs: Array<{ id: PrinterTab; label: string }> = [
    { id: "settings", label: t("admin.printer.tab.settings") },
    { id: "diagnostics", label: t("admin.printer.tab.diagnostics") },
  ];

  return (
    <AdminPanel
      title={t("admin.sidebar.printer")}
      description={t("admin.printer.description")}
      data-testid="printing-management"
    >
      <div
        role="tablist"
        aria-label={t("admin.printer.tabs")}
        className="bg-muted flex w-fit gap-1 rounded-lg border p-1"
      >
        {tabs.map((entry) => (
          <Button
            key={entry.id}
            type="button"
            role="tab"
            variant={tab === entry.id ? "default" : "ghost"}
            aria-selected={tab === entry.id}
            data-testid={`printing-tab-${entry.id}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      <div role="tabpanel" aria-label={tabs.find((entry) => entry.id === tab)?.label}>
        {tab === "settings" ? <PrinterSettingsTab /> : <PrinterDiagnosticsTab />}
      </div>
    </AdminPanel>
  );
}
```

- [ ] **Step 3: Run the page test** `npx vitest run tests/client/printing-management.test.tsx` → PASS.

- [ ] **Step 4: Update `tests/client/printing-surfaces.test.tsx`** (PrintingManagement blocks only; keep the file's header and helpers). Replace the `fetch` queues with `stubFetchRoutes` from `./helpers/fetchRoutes` and this route table (add a local helper):

```ts
function printerRoutes(jobs: PrintJob[], extra: Record<string, () => Response> = {}) {
  return stubFetchRoutes({
    "GET /api/settings": () =>
      new Response(
        JSON.stringify({
          locale: { timezone: "Europe/Madrid", language: "en", weekStartDay: 1 },
          printer: { paperWidthDots: 576 },
          printerTransport: { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" },
        }),
        { status: 200 }
      ),
    "GET /api/daily-briefing/settings": () =>
      new Response(JSON.stringify({ autoPrintTrigger: null }), { status: 200 }),
    "GET /api/printing/jobs": () => jobsResponse(jobs),
    "GET /api/members?lifecycle=all": () => new Response("[]", { status: 200 }),
    "POST /api/printing/capability": () => jsonResponse({ registered: true }),
    "POST /api/printing/claim": () => new Response(null, { status: 204 }),
    ...extra,
  });
}

async function openDiagnostics(): Promise<void> {
  fireEvent.click(await screen.findByTestId("printing-tab-diagnostics"));
  await flushMicrotasks();
}
```

  Then adapt each test:
  - **AdminPanel adoption**: unchanged intent; assert the region is labelled "Printer".
  - **shared printer session**: `printerRoutes([])`, render inside `PrinterSessionProvider`, `await screen.findByTestId("printing-management-pair")` (Settings tab), click, assert a call to `/api/printing/capability` (unchanged assertion).
  - **kiosk density** (three tests): open Diagnostics before measuring. Census on Diagnostics with a loaded table = 5 controls (2 tabs + test print + reset + refresh); while the trigger is in flight = 5 (test print and reset disabled, still mounted); after an unhealthy result = 5. The jobs-load-failure variant = 6 (adds `printing-jobs-retry`). For the in-flight phase, register `"POST /api/printing/test-print"` in `extra` with a handler returning a promise you resolve later (`() => new Promise<Response>((resolve) => { resolveTrigger = () => resolve(jsonResponse({ error: "plugin_inactive" }, 409)); })`). Add one more phase on the Settings tab (no session provider, auto-print readable): expected 10 controls (2 tabs, plugin link, auto-print link, paper width, name, device id, service UUID, characteristic UUID, save). These counts are derived from the DOM described in Tasks 5-7; if the real census differs, print `Array.from(document.querySelectorAll(CENSUS_CONTROL_SELECTOR)).map((e) => e.outerHTML.slice(0, 80))`, confirm every counted control is intentional, use the real number, and write a one-line comment listing what is counted. `assertKioskDensityCompliant` must pass in every phase; if a control fails it (for example the readonly input or the in-`<details>` inputs), fix the component styling, not the test.
  - **DELIBERATE NEGATIVE**: unchanged mechanics, on Diagnostics, targeting `printing-trigger-test-print`.
  - **ErrorNotice announcements**: open Diagnostics first; the jobs-load failure alert text stays "Failed to load print jobs."; dead-letter row state is the alert, the pending row is not; plugin-inactive trigger result is an alert; enqueued result is not.

  Note: with `stubFetchRoutes`, do not also call `vi.stubGlobal("fetch", ...)` in those tests.

- [ ] **Step 5: Run the printing client suite**

Run: `npx vitest run tests/client/printing-management.test.tsx tests/client/printing-surfaces.test.tsx tests/client/printer-settings-tab.test.tsx tests/client/printer-diagnostics-tab.test.tsx tests/client/printing-executor.test.tsx tests/client/printer-attention.test.tsx tests/client/printing-i18n-parity.test.ts tests/client/admin-gate.test.tsx tests/client/admin-gate-panel-reset.test.tsx tests/client/admin-gate-printing-nav.test.tsx tests/client/shell-routes.test.tsx`
Expected: PASS. `admin-gate*.test.tsx` and `shell-routes.test.tsx` only check that `printing-management` mounts/unmounts; if one now fails on an unexpected fetch, add the missing route response to that test's fetch mock rather than changing the component.

- [ ] **Step 6: Commit** `git add src/client/admin/PrintingManagement.tsx tests/client/printing-management.test.tsx tests/client/printing-surfaces.test.tsx && git commit -m "feat(admin): printer page with Settings and Diagnostics tabs"`

---

### Task 8: E2E specs and UI contract doc

**Files:**
- Modify: `tests/e2e/printing.spec.ts`
- Modify: `tests/e2e/daily-briefing.spec.ts:943-946` and `:1031-1034`
- Modify: `tests/e2e/admin-unlock-resilience.spec.ts:141-143`
- Modify: `docs/ui/household-contract.md:69`
- Modify: `docs/features/printing.md` (FR-017)

- [ ] **Step 1: `tests/e2e/printing.spec.ts`**
  1. `reopenPrintingPanel` (lines 139-144): after the `printing-management` visibility check add
     `await page.getByTestId("printing-tab-diagnostics").click();`
  2. Step 5 of the first test (after `await expect(management).toBeVisible();`, ~line 199) add
     `await management.getByTestId("printing-tab-diagnostics").click();`
  3. At the end of the first test (after the `testPrintJobsToday` assertion, ~line 299) append:

```ts
  // 11) Reset today's print (FR-016) through the real UI: the same record becomes printable and
  // a new test print is enqueued and printed by the paired executor.
  const resetResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/printing/reset-today") && response.request().method() === "POST"
  );
  await page.getByTestId("printing-reset-today").click();
  await page.getByTestId("printing-reset-today-confirm").click();
  const resetBody = (await (await resetResponse).json()) as {
    resetRecords: number;
    cancelledJobs: number;
  };
  expect(resetBody.resetRecords).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("printing-reset-today-result")).toBeVisible();

  const thirdTriggerResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/printing/test-print") && response.request().method() === "POST"
  );
  await page.getByTestId("printing-trigger-test-print").click();
  const thirdTriggerBody = (await (await thirdTriggerResponse).json()) as {
    enqueued: boolean;
    jobId: string | null;
  };
  expect(thirdTriggerBody.enqueued).toBe(true);
  expect(thirdTriggerBody.jobId).not.toBe(jobId);
  await expect
    .poll(async () => (await fetchJob(page.request, thirdTriggerBody.jobId!))?.derivedState, {
      timeout: 15_000,
      intervals: [100],
    })
    .toBe("printed");
```

  4. In the second test, after `await expect(page.getByTestId("printing-management-pair")).toBeHidden({ timeout: 10_000 });` append (Settings tab is the default):

```ts
  // Pairing fills the printer fields from the fake transport; Save writes printerTransport.
  try {
    await expect(page.getByTestId("printer-device-id")).toHaveValue("fake-printer");
    const saveResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/settings") && response.request().method() === "PUT"
    );
    await page.getByTestId("printer-settings-save").click();
    expect((await saveResponse).status()).toBe(200);
    await expect(page.getByTestId("printer-settings-saved")).toBeVisible();
    const stored = (await (await page.request.get("/api/settings")).json()) as {
      printerTransport?: { deviceId: string };
    };
    expect(stored.printerTransport?.deviceId).toBe("fake-printer");
  } finally {
    await page.request.put("/api/settings", {
      data: {
        object: "printerTransport",
        settings: { deviceId: "", name: "", serviceUuid: "", characteristicUuid: "" },
      },
    });
  }
```

- [ ] **Step 2: `tests/e2e/daily-briefing.spec.ts`**: after each of the two
  `await expect(page.getByTestId("printing-management")).toBeVisible();` lines (943-944 and
  1031-1032) insert `await page.getByTestId("printing-tab-diagnostics").click();`. Change nothing else
  in that file (another worker edits it).

- [ ] **Step 3: `tests/e2e/admin-unlock-resilience.spec.ts:141-143`**: the printer page's primary
  action is now the tab control visible on load:

```ts
  {
    path: "/admin/printing",
    primary: (page: Page) => page.getByTestId("printing-tab-diagnostics"),
  },
```

- [ ] **Step 4: Docs.** `docs/ui/household-contract.md` line 69 becomes:

```markdown
12. `/admin/printing` — Printer: Settings tab (plugin and auto-print state, paper width, Bluetooth
    printer with pair/re-pair, name, device id and UUIDs, saved to `printer`/`printerTransport`) and
    Diagnostics tab (test print, reset today's print, recent prints)
```

  `docs/features/printing.md`: append after FR-016:

```markdown
- **FR-017**: Given the admin Printer page, when an admin edits the paper width or the Bluetooth printer and saves, then the client MUST write the `printer` and `printerTransport` settings objects (one object per request, only the changed ones); pairing MUST resolve the device identity (device id, name, service and characteristic UUIDs) and fill those fields without persisting them, and the stored UUIDs MUST be offered to the next pairing as a try-first preference. Pairing outside the admin page never writes settings. Auto-print stays owned by Daily Briefing and is shown read-only.
```

- [ ] **Step 5: Run the affected e2e specs** (build happens inside the web server command):

```bash
PORT=43203 npx playwright test tests/e2e/printing.spec.ts tests/e2e/admin-unlock-resilience.spec.ts tests/e2e/daily-briefing.spec.ts tests/e2e/household-shell-skeleton.spec.ts tests/e2e/accessible-names-audit.spec.ts --workers=3
```

Expected: all PASS. On failure, read the trace/screenshot under `test-results/`, fix the cause,
re-run only the failing spec, then re-run this full command.

- [ ] **Step 6: Commit** `git add tests/e2e docs/ui/household-contract.md docs/features/printing.md && git commit -m "test(e2e): printer tabs, reset today's print and transport save"`

---

### Task 9: Cohort resync and the verification gate

**Files:**
- Modify: `tests/fixtures/assembly-cohort.json` (`testCohorts`, `coveragePolicy`)

- [ ] **Step 1: Commit everything first** — `check:standard` must run on a clean, committed tree
  (`git status` shows nothing). If git is refused in your worktree, run the gate anyway and say so in
  the report.

- [ ] **Step 2: Run the gate once to collect evidence**

```bash
fnm exec --using=24.21.0 npm run check:standard 2>&1 | tee /tmp/printer-check-1.log
```

Expected: it fails at `check:preflight` / `check:coverage` / `check:test-cohorts:standard` because
the fixture does not list the new files and test cases yet. (If it fails earlier — format, lint,
typecheck, build, a test — fix that first: `npx prettier --write <file>` for format.)

- [ ] **Step 3: Resync `tests/fixtures/assembly-cohort.json`** from the real run, never by guessing:
  - `testCohorts.runners.vitest.files`: add `tests/client/printer-settings-tab.test.tsx` and
    `tests/client/printer-diagnostics-tab.test.tsx` with their case ids, and replace the case arrays
    of `tests/client/printing-management.test.tsx`, `tests/client/printing-surfaces.test.tsx`,
    `tests/client/printing-executor.test.tsx`, `tests/client/printing-transport.test.ts`,
    `tests/boundary/printing-core.test.ts`, `tests/boundary/printing-routes.test.ts`. Take the exact
    ids from `.quality/vitest-results.json` (each assertion result's `fullName`, which is the
    `describe` titles + test title joined by spaces; compare with an existing entry such as
    `"settings-write printing active with no printerTransport row fills empty defaults (APP-SETTINGS-REGISTRY-AC-06)"`
    to confirm the format). Parameterised `it.each` cases appear once per row.
  - `coveragePolicy.files`: add entries for `src/client/admin/printer/PrinterSettingsTab.tsx` and
    `src/client/admin/printer/PrinterDiagnosticsTab.tsx` (`"layer": "client"`), and update the entries
    of `src/client/admin/PrintingManagement.tsx`, `src/client/printing/transport.ts`,
    `src/client/printing/PrintExecutor.tsx`, `src/server/modules/printing/index.ts`,
    `src/server/routes/printing.ts`. Take `minimumTotals` (lines/statements/functions/branches totals)
    and the rates from `coverage/coverage-final.json` for those files (the verifier prints the observed
    numbers when it fails; use them). Rates must not drop below the previous floors for files you
    only extended; if one would, add a test instead of lowering the floor. Keep the JSON key order and
    2-space formatting (`npx prettier --write tests/fixtures/assembly-cohort.json`).

- [ ] **Step 4: Commit the fixture** `git add tests/fixtures/assembly-cohort.json && git commit -m "test: resync assembly cohort for the printer page"`

- [ ] **Step 5: Run the full gate on the clean tree**

```bash
fnm exec --using=24.21.0 npm run check:standard
```

Expected: exit 0. Repeat Steps 3-5 until it passes. Also re-run the e2e command from Task 8 Step 5
if any source changed since it last passed.

---

### Task 10: Commit on the worktree branch and report

- [ ] **Step 1:** `git status` is clean and `git log --oneline main..HEAD` lists the task commits
  (including the spec/plan copy).
- [ ] **Step 2:** Report back: branch name, final commit SHA, `npm run check:standard` result,
  the exact Playwright command and its pass count (PORT=43203), the list of files created/modified,
  and any deviation from this plan with its reason (for example a changed density census count).
  If git was refused in the worktree, report the worktree path and the full list of touched and
  created files instead of a SHA so the coordinator can collect the work by patch.
