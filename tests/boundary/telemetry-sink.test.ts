import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hashKey } from "../../src/server/auth/credentials";
import { getDb } from "../../src/server/db/client";
import { useIsolatedDb } from "../helpers/db";
import { __resetTelemetryStateForTests, writeClientLog } from "../../src/server/telemetry/index";
import { REDACTED_MARKER } from "../../src/server/telemetry/redact";
import {
  loadSinksFromEnv,
  fanOutToSinks,
  projectToSinkEnvelope,
  getSinkFailureCount,
  __setSinksForTests,
  __resetSinksForTests,
  __resetSinkFailureCountForTests,
  type TelemetrySink,
} from "../../src/server/telemetry/sink";
import type { TelemetrySinkEnvelope } from "../../src/shared";

/** external-sink seam (FR-015): a typed 5-field projection fed AFTER
 * redaction+insert, fire-and-forget (deferred via `setImmediate` — NOT
 * `queueMicrotask`, which still runs before the event loop reaches I/O and so does not actually
 * isolate the response path from a slow synchronous sink), failures swallowed+counted,
 * absent-by-default no-op.
 * `flushDeferredSinks` — every sink `send` is deferred via `setImmediate`, so any
 * assertion on sink-observed state must wait for the event loop's "check" phase to run first.
 * `setImmediate` here both PRODUCES the deferral under test and, called again from the test,
 * CONSUMES it deterministically — it schedules strictly after the already-queued sink callback,
 * so by the time this promise resolves every deferred sink callback has already run.
 * *(Traces: CLIENT-LOGGING-TELEMETRY-INV-07, CLIENT-LOGGING-TELEMETRY-INV-08,
 * CLIENT-LOGGING-TELEMETRY-AC-03)*
 */
function flushDeferredSinks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("telemetry sink seam (T012)", () => {
  useIsolatedDb();

  const ENVELOPE_KEYS = ["level", "component", "message", "receivedAt", "eventId"].sort();

  beforeEach(() => {
    __resetTelemetryStateForTests();
    __resetSinksForTests();
    __resetSinkFailureCountForTests();
    delete process.env.TELEMETRY_SINKS;
  });

  afterEach(() => {
    delete process.env.TELEMETRY_SINKS;
    __resetSinksForTests();
    __resetSinkFailureCountForTests();
  });

  function seedApiKey(): string {
    const rawKey = `mpk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    getDb()
      .prepare(
        "INSERT INTO api_keys (id, key_hash, scope, kind, created_at) VALUES (?, ?, '*', 'device', ?)"
      )
      .run(id, hashKey(rawKey), Date.now());
    return id;
  }

  function makeCapturingSink(opts?: { throwOn?: number }): {
    sink: TelemetrySink;
    calls: TelemetrySinkEnvelope[];
  } {
    const calls: TelemetrySinkEnvelope[] = [];
    let invocation = 0;
    const sink: TelemetrySink = {
      name: "capturing-fake",
      send: (envelope) => {
        invocation += 1;
        if (opts?.throwOn === invocation) {
          throw new Error("fake sink synchronous failure");
        }
        calls.push(envelope);
      },
    };
    return { sink, calls };
  }

  // Corpus incl. hostile/redacted entries (quickstart §1 flavor): plain, secret-laden message,
  // secret-laden data, an i18n-style payload, and one structurally-invalid entry that must be
  // DROPPED (never reaching insert, and therefore never reaching the sink).
  const CORPUS: Array<{ raw: unknown; accepted: boolean }> = [
    { raw: { level: "info", component: "kiosk.boot", message: "started" }, accepted: true },
    {
      raw: {
        level: "error",
        component: "auth",
        message: "device key mpk-abc123DEF_ghi leaked in the wild",
      },
      accepted: true,
    },
    {
      raw: {
        level: "warn",
        component: "net",
        message: "connectivity probe",
        data: { ip: "192.168.1.5", token: "s3cr3t-value" },
      },
      accepted: true,
    },
    {
      raw: {
        level: "debug",
        component: "i18n",
        message: "missing translation key",
        data: { translationId: "home.title" },
      },
      accepted: true,
    },
    { raw: { level: "bogus-level", component: "x", message: "y" }, accepted: false },
  ];

  describe("CLIENT-LOGGING-TELEMETRY-INV-07: the 5-field projection", () => {
    it("a fake sink receives exactly the five envelope fields for every accepted corpus entry, and `data` appears in zero payloads", async () => {
      const apiKeyId = seedApiKey();
      const { sink, calls } = makeCapturingSink();
      __setSinksForTests([sink]);

      let expectedAccepted = 0;
      for (const { raw, accepted } of CORPUS) {
        const result = writeClientLog(apiKeyId, [raw]);
        expect(result.accepted).toBe(accepted ? 1 : 0);
        if (accepted) expectedAccepted += 1;
      }

      await flushDeferredSinks();

      expect(calls).toHaveLength(expectedAccepted);
      for (const envelope of calls) {
        const keys = Object.keys(envelope).sort();
        expect(keys).toEqual(ENVELOPE_KEYS);
        expect(keys).not.toContain("data");
        expect("data" in envelope).toBe(false);
        expect(typeof envelope.level).toBe("string");
        expect(typeof envelope.component).toBe("string");
        expect(typeof envelope.message).toBe("string");
        expect(typeof envelope.receivedAt).toBe("number");
        expect(typeof envelope.eventId).toBe("string");
      }
    });

    it("projectToSinkEnvelope() returns exactly the five fields (identity projection over TelemetrySinkEnvelope)", () => {
      const input: TelemetrySinkEnvelope = {
        level: "info",
        component: "c",
        message: "m",
        receivedAt: 1234,
        eventId: "evt-1",
      };
      const envelope = projectToSinkEnvelope(input);
      expect(envelope).toEqual(input);
      expect(Object.keys(envelope).sort()).toEqual(ENVELOPE_KEYS);
    });

    it("F4: TelemetrySinkEnvelope rejects a data-carrying value at compile time, even through an intermediate variable", () => {
      const dataCarrying = {
        level: "info" as const,
        component: "c",
        message: "m",
        receivedAt: 1,
        eventId: "evt-1",
        data: { secretLookingKey: "should never reach a sink" },
      };
      // @ts-expect-error — `data` is `never` on TelemetrySinkEnvelope. `dataCarrying` is a
      // VARIABLE (not an object literal passed directly), so this is NOT merely the excess-
      // property check catching a fresh literal — ordinary structural assignability rejects
      // the variable form too because of the shared `data` property.
      fanOutToSinks([], dataCarrying);

      // Sanity: the plain 5-field literal is accepted without complaint.
      fanOutToSinks([], {
        level: "info",
        component: "c",
        message: "m",
        receivedAt: 1,
        eventId: "evt-1",
      });
    });

    it("F1: loadSinksFromEnv() ignores prototype-chain names — never resolves through Object.prototype", () => {
      process.env.TELEMETRY_SINKS = "__proto__,constructor,toString,valueOf,hasOwnProperty";
      expect(() => loadSinksFromEnv()).not.toThrow();
      expect(loadSinksFromEnv()).toEqual([]);
    });

    it("F5: sinks observe the POST-redaction message — the secret-laden corpus entry's envelope never carries the raw mpk- token", async () => {
      const apiKeyId = seedApiKey();
      const { sink, calls } = makeCapturingSink();
      __setSinksForTests([sink]);

      for (const { raw } of CORPUS) {
        writeClientLog(apiKeyId, [raw]);
      }
      await flushDeferredSinks();

      const secretEntry = calls.find((c) => c.component === "auth");
      expect(secretEntry?.message).toBe(`device key ${REDACTED_MARKER} leaked in the wild`);
      for (const envelope of calls) {
        expect(envelope.message).not.toContain("mpk-");
        expect(envelope.component).not.toContain("mpk-");
      }
    });
  });

  describe("CLIENT-LOGGING-TELEMETRY-INV-08: absent-by-default, deploy-level, never a household setting", () => {
    it("loadSinksFromEnv() returns [] when TELEMETRY_SINKS is unset", () => {
      delete process.env.TELEMETRY_SINKS;
      expect(loadSinksFromEnv()).toEqual([]);
    });

    it("loadSinksFromEnv() returns [] for a configured-but-unrecognized name (no built-in ships this slice)", () => {
      process.env.TELEMETRY_SINKS = "some-future-sink,another-one";
      expect(loadSinksFromEnv()).toEqual([]);
    });

    it("no-sink config produces byte-equal ingest responses to a configured-sink run for the same input", async () => {
      const apiKeyId = seedApiKey();
      const entry = { level: "info", component: "kiosk.boot", message: "identical input" };

      __resetSinksForTests(); // env-loaded default: TELEMETRY_SINKS unset -> []
      const resultNoSink = writeClientLog(apiKeyId, [entry]);

      const { sink } = makeCapturingSink();
      __setSinksForTests([sink]);
      const resultWithSink = writeClientLog(apiKeyId, [entry]);

      expect(resultWithSink).toEqual(resultNoSink);
      expect(JSON.stringify(resultWithSink)).toBe(JSON.stringify(resultNoSink));
      await flushDeferredSinks();
    });
  });

  describe("F2: accounting integrity under a poisoned TELEMETRY_SINKS value", () => {
    it("accepted+dropped always equals the entry count, rows are inserted, and a later call remains healthy", async () => {
      process.env.TELEMETRY_SINKS =
        "__proto__,constructor,toString,valueOf,hasOwnProperty,a-totally-made-up-name";
      __resetSinksForTests(); // force this poisoned value to be (re-)read

      const apiKeyId = seedApiKey();
      const entries = [
        { level: "info", component: "a", message: "one" },
        { level: "info", component: "b", message: "two" },
        { level: "info", component: "c", message: "three" },
      ];

      const result = writeClientLog(apiKeyId, entries);
      expect(result.accepted + result.dropped).toBe(entries.length);
      expect(result).toEqual({ accepted: 3, dropped: 0 });

      const rows = getDb()
        .prepare("SELECT component FROM client_log ORDER BY component")
        .all() as Array<{ component: string }>;
      expect(rows.map((r) => r.component)).toEqual(["a", "b", "c"]);

      await flushDeferredSinks();

      // The seam is not left wedged/poisoned by the earlier (attempted) bad config — a
      // subsequent, unrelated call still succeeds normally.
      const followUp = writeClientLog(apiKeyId, [
        { level: "info", component: "d", message: "four" },
      ]);
      expect(followUp).toEqual({ accepted: 1, dropped: 0 });
    });
  });

  describe("F6: insert precedes sink fan-out — never a fan-out for a DROPPED entry", () => {
    it("a sink's send() can already SELECT the freshly-inserted row by event_id (weak positive check — see the drop-table test below for the discriminating one)", async () => {
      const apiKeyId = seedApiKey();
      let observedRow: { event_id: string } | undefined;
      const orderingSink: TelemetrySink = {
        name: "ordering-check",
        send: (envelope) => {
          observedRow = getDb()
            .prepare("SELECT event_id FROM client_log WHERE event_id = ?")
            .get(envelope.eventId) as { event_id: string } | undefined;
        },
      };
      __setSinksForTests([orderingSink]);

      writeClientLog(apiKeyId, [
        { level: "info", component: "order", message: "insert-before-send" },
      ]);

      await flushDeferredSinks();

      expect(observedRow).toBeDefined();
      expect(observedRow?.event_id).toBeTruthy();
    });

    // The SELECT-by-event_id test above is near-vacuous after fan-out is deferred: the SELECT-by-event_id test above is near-vacuous once fan-out is
    // deferred — a mutation that moves the `dispatchToActiveSinks` call BEFORE the insert still
    // passes it (the deferred sink runs on the next event-loop tick either way, by which point
    // the insert has always already happened, mutated ordering or not). This is the
    // discriminating replacement: force the insert itself to fail (drop the table), so an
    // entry that is DROPPED (never durably written) must never reach a sink at all. A mutant
    // that fans out regardless of insert success fails this test; the current code passes it.
    it("a DROPPED entry (insert fails because the table doesn't exist) never fans out to any sink", async () => {
      const apiKeyId = seedApiKey();
      const { sink, calls } = makeCapturingSink();
      __setSinksForTests([sink]);

      getDb().exec("DROP TABLE client_log");

      const result = writeClientLog(apiKeyId, [
        { level: "info", component: "no-table", message: "insert will throw" },
      ]);
      expect(result).toEqual({ accepted: 0, dropped: 1 });

      await flushDeferredSinks();

      expect(calls).toHaveLength(0);
    });
  });

  describe("F3: sink send() is deferred off the synchronous ingest path", () => {
    it("a sink's send() has not run yet immediately after writeClientLog() returns, only after the event loop reaches the setImmediate check phase", async () => {
      const apiKeyId = seedApiKey();
      let sent = false;
      const deferredSink: TelemetrySink = {
        name: "deferred-check",
        send: () => {
          sent = true;
        },
      };
      __setSinksForTests([deferredSink]);

      writeClientLog(apiKeyId, [{ level: "info", component: "defer", message: "check" }]);
      expect(sent).toBe(false); // not yet — deferred via setImmediate

      await flushDeferredSinks();
      expect(sent).toBe(true);
    });
  });

  describe("CLIENT-LOGGING-TELEMETRY-AC-03: a throwing sink is swallowed", () => {
    it("a synchronously-throwing sink never affects the ingest result, increments the failure counter, and later entries in the same batch still fan out", async () => {
      const apiKeyId = seedApiKey();
      const { sink, calls } = makeCapturingSink({ throwOn: 1 });
      __setSinksForTests([sink]);

      const result = writeClientLog(apiKeyId, [
        { level: "info", component: "a", message: "first — sink throws on this one" },
        { level: "info", component: "b", message: "second — sink must still receive this" },
        { level: "info", component: "c", message: "third — sink must still receive this too" },
      ]);

      // Ingest is unaffected by the sink failure: all three well-formed entries are accepted,
      // decided synchronously — this holds even though every sink send is deferred.
      expect(result).toEqual({ accepted: 3, dropped: 0 });

      await flushDeferredSinks();

      expect(getSinkFailureCount()).toBe(1);
      // The first call threw (not captured); the following two were captured normally.
      expect(calls).toHaveLength(2);
      expect(calls.map((c) => c.component)).toEqual(["b", "c"]);
    });

    it("an asynchronously-rejecting sink is swallowed without an unhandled rejection, and increments the failure counter", async () => {
      const apiKeyId = seedApiKey();
      const calls: TelemetrySinkEnvelope[] = [];
      let seen = 0;
      const asyncSink: TelemetrySink = {
        name: "async-fake",
        send: async (envelope) => {
          seen += 1;
          if (seen === 1) {
            throw new Error("fake async sink rejection");
          }
          calls.push(envelope);
        },
      };
      __setSinksForTests([asyncSink]);

      const result = writeClientLog(apiKeyId, [
        { level: "warn", component: "a", message: "first — async sink rejects" },
        { level: "warn", component: "b", message: "second — async sink resolves" },
      ]);

      expect(result).toEqual({ accepted: 2, dropped: 0 });

      // Fire-and-forget: give the deferred sink callback a turn to settle before asserting.
      await flushDeferredSinks();

      expect(getSinkFailureCount()).toBe(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.component).toBe("b");
    });
  });

  describe("fanOutToSinks() direct unit coverage", () => {
    it("dispatches to every sink in the list and never throws even when every sink throws", async () => {
      const envelope: TelemetrySinkEnvelope = {
        level: "info",
        component: "c",
        message: "m",
        receivedAt: 1,
        eventId: "evt-1",
      };
      const throwingSinks: TelemetrySink[] = [
        {
          name: "always-throws-1",
          send: () => {
            throw new Error("boom-1");
          },
        },
        {
          name: "always-throws-2",
          send: () => {
            throw new Error("boom-2");
          },
        },
      ];
      __resetSinkFailureCountForTests();
      expect(() => fanOutToSinks(throwingSinks, envelope)).not.toThrow();

      await flushDeferredSinks();
      expect(getSinkFailureCount()).toBe(2);
    });

    it("with zero sinks, fanOutToSinks() is a pure no-op", () => {
      __resetSinkFailureCountForTests();
      expect(() =>
        fanOutToSinks([], {
          level: "info",
          component: "c",
          message: "m",
          receivedAt: 1,
          eventId: "evt-1",
        })
      ).not.toThrow();
      expect(getSinkFailureCount()).toBe(0);
    });
  });
});
