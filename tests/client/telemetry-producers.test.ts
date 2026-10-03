import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { createElement } from "react";
import { useIsolatedDb } from "../helpers/db";
import type { MessageKey } from "../../src/client/i18n/messages";

/** A catalog key guaranteed not to exist in either `messages.en` or `messages.es`. */
const MISSING_KEY_PROBE = "__telemetry_test_probe__.does.not.exist" as unknown as MessageKey;

/** — global capture + i18n producer jsdom tests .
 */
describe("telemetry producers", () => {
  describe("global error/unhandledrejection capture (FR-008)", () => {
    beforeEach(() => {
      document.body.innerHTML = '<div id="root"></div>';
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      document.body.innerHTML = "";
    });

    /** Mock the Shell so importing the real entry doesn't try to render/fetch the whole
     * app. `registerShellService` is a no-op stand-in: `main.tsx` now
     * also side-effect-imports `./time-announcements/service`, which calls it at module
     * import time — the mock must provide it or that import throws.
     */
    async function loadMainWithMockShellAndLoggerSpy() {
      vi.resetModules();
      vi.doMock("../../src/client/shell/Shell", () => ({
        Shell: () => null,
        registerShellService: () => () => {},
      }));
      const logger = await import("../../src/client/lib/logger");
      const sent: unknown[][] = [];
      logger.__setTransportForTests((entries) => {
        sent.push(entries);
      });
      await import("../../src/client/main");
      return { logger, sent };
    }

    it("an uncaught error becomes a client.global/error entry with a stable message and the raw text in data (INV-03 pattern)", async () => {
      const { logger, sent } = await loadMainWithMockShellAndLoggerSpy();

      const err = new Error("boom uncaught");
      const event = new ErrorEvent("error", { error: err, message: err.message });
      window.dispatchEvent(event);

      await logger.__flushNowForTests();
      expect(sent).toHaveLength(1);
      const entry = sent[0][0] as {
        level: string;
        component: string;
        message: string;
        data?: { message?: string; stack?: string };
      };
      expect(entry.level).toBe("error");
      expect(entry.component).toBe("client.global");
      expect(entry.message).toBe("unhandled_error");
      expect(entry.data?.message).toBe("boom uncaught");
    });

    it("a bare resource-load Event (not an ErrorEvent) is ignored (P3-2/623 review)", async () => {
      const { logger, sent } = await loadMainWithMockShellAndLoggerSpy();

      // Failed <img>/<script>/<link> loads dispatch a plain Event on window, not an ErrorEvent.
      const event = new Event("error");
      window.dispatchEvent(event);

      await logger.__flushNowForTests();
      expect(sent).toHaveLength(0);
    });

    it("an unhandled promise rejection becomes a client.global/error entry with a stable message and the raw text in data (INV-03 pattern)", async () => {
      const { logger, sent } = await loadMainWithMockShellAndLoggerSpy();

      const err = new Error("boom rejection");
      const event = new Event("unhandledrejection") as unknown as PromiseRejectionEvent;
      Object.defineProperty(event, "reason", { value: err });
      window.dispatchEvent(event);

      await logger.__flushNowForTests();
      expect(sent).toHaveLength(1);
      const entry = sent[0][0] as {
        level: string;
        component: string;
        message: string;
        data?: { message?: string };
      };
      expect(entry.level).toBe("error");
      expect(entry.component).toBe("client.global");
      expect(entry.message).toBe("unhandled_rejection");
      expect(entry.data?.message).toBe("boom rejection");
    });

    it("a non-Error rejection reason is stringified into data.message rather than throwing", async () => {
      const { logger, sent } = await loadMainWithMockShellAndLoggerSpy();

      const event = new Event("unhandledrejection") as unknown as PromiseRejectionEvent;
      Object.defineProperty(event, "reason", { value: "plain string reason" });
      expect(() => window.dispatchEvent(event)).not.toThrow();

      await logger.__flushNowForTests();
      expect(sent).toHaveLength(1);
      const entry = sent[0][0] as { message: string; data?: { message?: string } };
      expect(entry.message).toBe("unhandled_rejection");
      expect(entry.data?.message).toBe("plain string reason");
    });
  });

  describe("i18n missing-key producer (FR-009/AC-08, research D6)", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network in this test")));
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    /** Mocks the shared logger so we can assert exactly what the i18n hook logs. */
    async function loadI18nWithMockLogger() {
      vi.resetModules();
      const logSpy = vi.fn();
      vi.doMock("../../src/client/lib/logger", () => ({ log: logSpy }));
      const i18n = await import("../../src/client/i18n/index");
      return { i18n, logSpy };
    }

    it("CLIENT-LOGGING-TELEMETRY-AC-08/CLIENT-LOGGING-TELEMETRY-INV-13: useT() outside a provider (englishFallback path) logs warn/i18n/missing_key with `translationId`, never `key`", async () => {
      const { i18n, logSpy } = await loadI18nWithMockLogger();

      const { result } = renderHook(() => i18n.useT());
      const t = result.current;
      const rendered = t(MISSING_KEY_PROBE);

      expect(rendered).toBe(MISSING_KEY_PROBE); // englishFallback: unknown key renders as the key itself
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith("warn", "i18n", "missing_key", {
        translationId: MISSING_KEY_PROBE,
        locale: "en",
      });
      // pin: the payload property must be `translationId`, never `key` — the server
      // deny-list matches `/key/i` on property NAMES and would redact the identifier away.
      const payload = logSpy.mock.calls[0][3] as Record<string, unknown>;
      expect(Object.keys(payload)).not.toContain("key");
    });

    it("CLIENT-LOGGING-TELEMETRY-AC-08/CLIENT-LOGGING-TELEMETRY-INV-13: useT() inside LanguageProvider (the `messages[language][key] ?? messages.en[key]` branch) also logs, with the provider's language", async () => {
      const { i18n, logSpy } = await loadI18nWithMockLogger();

      const { result } = renderHook(() => i18n.useT(), {
        wrapper: ({ children }) => createElement(i18n.LanguageProvider, null, children),
      });
      result.current(MISSING_KEY_PROBE);

      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledWith("warn", "i18n", "missing_key", {
        translationId: MISSING_KEY_PROBE,
        locale: "en", // LanguageProvider starts at "en" before the settings fetch resolves
      });
    });

    it("seen-set: the same missing key only fires once per session, but a different key fires again", async () => {
      const { i18n, logSpy } = await loadI18nWithMockLogger();
      const otherMissingKey = `${MISSING_KEY_PROBE}.other`;

      const { result } = renderHook(() => i18n.useT());
      const t = result.current;

      t(MISSING_KEY_PROBE);
      t(MISSING_KEY_PROBE);
      t(MISSING_KEY_PROBE);
      expect(logSpy).toHaveBeenCalledTimes(1);

      t(otherMissingKey as typeof MISSING_KEY_PROBE);
      expect(logSpy).toHaveBeenCalledTimes(2);
    });

    it("a key that resolves normally never logs", async () => {
      const { i18n, logSpy } = await loadI18nWithMockLogger();

      const { result } = renderHook(() => i18n.useT());
      const rendered = result.current("members.management.title");

      expect(rendered).toBe("Members Management");
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("ingest round-trip: translationId survives the real redact pipeline (Codex F6)", () => {
    useIsolatedDb();

    it("a payload keyed `translationId` is stored verbatim, not redacted", async () => {
      const { writeClientLog, getClientLogPage } = await import("../../src/server/telemetry/index");
      const translationId = "some.missing.catalog.key";

      const result = writeClientLog("producer-test-caller", [
        {
          level: "warn",
          component: "i18n",
          message: "missing_key",
          data: { translationId, locale: "en" },
        },
      ]);
      expect(result).toEqual({ accepted: 1, dropped: 0 });

      const page = getClientLogPage({});
      expect(page).not.toBeNull();
      const row = page!.rows[0];
      const data = JSON.parse(row.data as string) as { translationId: string; locale: string };
      expect(data.translationId).toBe(translationId);
      expect(data.translationId).not.toContain("[redacted]");
    });

    it("regression pin: the SAME identifier under a property literally named `key` WOULD be redacted — that's why the producer uses `translationId`", async () => {
      const { writeClientLog, getClientLogPage } = await import("../../src/server/telemetry/index");
      const translationId = "some.missing.catalog.key";

      const result = writeClientLog("producer-test-caller-2", [
        {
          level: "warn",
          component: "i18n",
          message: "missing_key",
          data: { key: translationId, locale: "en" },
        },
      ]);
      expect(result).toEqual({ accepted: 1, dropped: 0 });

      const page = getClientLogPage({});
      expect(page).not.toBeNull();
      const row = page!.rows[0];
      const data = JSON.parse(row.data as string) as { key: string };
      expect(data.key).toBe("[redacted]");
    });
  });
});
