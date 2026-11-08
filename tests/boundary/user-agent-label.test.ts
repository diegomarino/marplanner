import { describe, expect, it } from "vitest";
import {
  defaultCredentialLabel,
  describeUserAgent,
} from "../../src/server/auth/user-agent-label.ts";

/** Dependency-free User-Agent parser behind provisioned keys' default labels. */
describe("user-agent-label", () => {
  it.each([
    [
      "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari",
      "iPadOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari",
      "iOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
      "Chrome",
      "iOS",
    ],
    [
      "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/132.0 Mobile/15E148 Safari/605.1.15",
      "Firefox",
      "iPadOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0.2849.80 Mobile/15E148 Safari/605.1.15",
      "Edge",
      "iOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Safari",
      "macOS",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome",
      "macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome",
      "Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      "Edge",
      "Windows",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 EdgA/130.0.0.0",
      "Edge",
      "Android",
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
      "Chrome",
      "Android",
    ],
    ["Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0", "Firefox", "Android"],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
      "Firefox",
      "Windows",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0", "Firefox", "Linux"],
    [
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Chrome",
      "Linux",
    ],
    ["curl/8.7.1", "curl", "Unknown"],
    ["node", "Node.js", "Unknown"],
    ["undici", "Node.js", "Unknown"],
    ["Node.js/24.0 (linux; x64)", "Node.js", "Linux"],
    ["Wget/1.21.4", "Unknown", "Unknown"],
    ["", "Unknown", "Unknown"],
  ])("parses %j as %s on %s", (userAgent, browser, os) => {
    expect(describeUserAgent(userAgent)).toEqual({ browser, os });
  });

  it("formats '<Browser> · <OS> · <date>'", () => {
    expect(
      defaultCredentialLabel(
        "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
        "2026-11-07"
      )
    ).toBe("Safari · iPadOS · 2026-11-07");
  });

  it("falls back to 'Device · <date>' without a User-Agent", () => {
    expect(defaultCredentialLabel(undefined, "2026-11-07")).toBe("Device · 2026-11-07");
    expect(defaultCredentialLabel("   ", "2026-11-07")).toBe("Device · 2026-11-07");
  });

  it("never exceeds 80 characters", () => {
    const label = defaultCredentialLabel("curl/8", "x".repeat(100));
    expect(label).toHaveLength(80);
    expect(label.startsWith("curl · Unknown · ")).toBe(true);
  });
});
