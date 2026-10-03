import { describe, it, expect } from "vitest";
import {
  boundData,
  boundAndRedact,
  redactEntry,
  redactString,
  DEFAULT_LIMITS,
  TRUNCATED_MARKER,
  REDACTED_MARKER,
} from "../../src/server/telemetry/redact";

/** redaction/bounding corpus (Constitution II, CLIENT-LOGGING-TELEMETRY-INV-04 / -AC-01).
 * Per quickstart.md §1: every deny-list key name; mpk-/mpg-; MAC `:`/`-`; IPv4; IPv6; nested
 * beyond depth; over-size; over-keys; secrets inside `message`; secrets/MACs inside
 * `component`; a secret straddling the truncation boundary; self-referential object;
 * bound-before-redact order.
 */
describe("telemetry redact.ts corpus", () => {
  const DENY_LIST_KEYS = [
    "token",
    "apiKey",
    "myPin",
    "secretValue",
    "Cookie",
    "Authorization",
    "password",
    "callbackUrl",
  ];

  it("CLIENT-LOGGING-TELEMETRY-AC-01: every deny-list key name redacts its whole value", () => {
    for (const key of DENY_LIST_KEYS) {
      const { data } = boundAndRedact({
        message: "m",
        component: "c",
        data: { [key]: "innocuous-looking-value" },
      });
      expect((data as Record<string, unknown>)[key]).toBe(REDACTED_MARKER);
    }
  });

  it("CLIENT-LOGGING-TELEMETRY-AC-01: mpk-/mpg- value patterns redact regardless of key name", () => {
    const { data } = boundAndRedact({
      message: "m",
      component: "c",
      data: { note: "device key mpk-abc123DEF_ghi and mpg-xyz987" },
    });
    const note = (data as Record<string, unknown>).note as string;
    expect(note).not.toMatch(/mpk-/i);
    expect(note).not.toMatch(/mpg-/i);
    expect(note).toContain(REDACTED_MARKER);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-04: MAC addresses in `:` and `-` forms are redacted", () => {
    const { data } = boundAndRedact({
      message: "m",
      component: "c",
      data: { colon: "mac 00:1A:2B:3C:4D:5E seen", dash: "mac 00-1a-2b-3c-4d-5e seen" },
    });
    const d = data as Record<string, unknown>;
    expect(d.colon).not.toMatch(
      /[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2}/i
    );
    expect(d.dash).not.toMatch(
      /[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}-[0-9a-f]{2}/i
    );
    expect(d.colon).toContain(REDACTED_MARKER);
    expect(d.dash).toContain(REDACTED_MARKER);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-04: IPv4 addresses are redacted", () => {
    const { data } = boundAndRedact({
      message: "m",
      component: "c",
      data: { ip: "client at 192.168.1.42 failed" },
    });
    const ip = (data as Record<string, unknown>).ip as string;
    expect(ip).not.toContain("192.168.1.42");
    expect(ip).toContain(REDACTED_MARKER);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-04: IPv6 addresses are redacted", () => {
    const { data } = boundAndRedact({
      message: "m",
      component: "c",
      data: { ip: "client at fe80:0:0:0:202:b3ff:fe1e:8329 failed" },
    });
    const ip = (data as Record<string, unknown>).ip as string;
    expect(ip).not.toContain("fe80:0:0:0:202:b3ff:fe1e:8329");
    expect(ip).toContain(REDACTED_MARKER);
  });

  it("CLIENT-LOGGING-TELEMETRY-AC-01 / CLIENT-LOGGING-TELEMETRY-AC-02: secret in `message` is redacted", () => {
    const { message } = boundAndRedact({
      message: "auth failed with mpk-supersecret123",
      component: "c",
      data: {},
    });
    expect(message).not.toContain("mpk-supersecret123");
    expect(message).toContain(REDACTED_MARKER);
  });

  it("Codex F1: secret/MAC in `component` is redacted (component is attacker-controlled + sink-forwarded)", () => {
    const { component } = boundAndRedact({
      message: "m",
      component: "svc mpk-leaked00 00:1A:2B:3C:4D:5E",
      data: {},
    });
    expect(component).not.toContain("mpk-leaked00");
    expect(component).not.toMatch(/00:1A:2B:3C:4D:5E/i);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-04: nesting beyond maxDepth is truncated", () => {
    // depth 0..7 — one level past DEFAULT_LIMITS.maxDepth (6)
    let leaf: unknown = { secretAtBottom: "mpk-shouldneverappear" };
    for (let i = 0; i < 7; i++) leaf = { nested: leaf };
    const bounded = boundData(leaf);
    const serialized = JSON.stringify(bounded);
    expect(serialized).toContain(TRUNCATED_MARKER);
    expect(serialized).not.toContain("mpk-shouldneverappear");
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-04: over-key-count is truncated", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < DEFAULT_LIMITS.maxKeys + 20; i++) wide[`k${i}`] = `v${i}`;
    const bounded = boundData(wide) as Record<string, unknown>;
    const keyCount = Object.keys(bounded).length;
    expect(keyCount).toBeLessThanOrEqual(DEFAULT_LIMITS.maxKeys + 1); // +1 for the __truncated__ marker
    expect(JSON.stringify(bounded)).toContain(TRUNCATED_MARKER);
  });

  it("CLIENT-LOGGING-TELEMETRY-INV-04: over-size data is wholesale truncated (never a partial slice)", () => {
    const big = { padding: "x".repeat(20_000) };
    const bounded = boundData(big);
    expect(bounded).toBe(TRUNCATED_MARKER);
  });

  it("never-partial-secrets: a secret value straddling the size-truncation boundary yields zero partial bytes", () => {
    // Pad the payload so total size crosses maxBytes right around where the secret sits.
    const secret = "mpk-boundarysecretTOKENvalue1234567890";
    const padLen = DEFAULT_LIMITS.maxBytes - 40; // close to the boundary, but the whole object still overflows once combined with JSON overhead + the secret
    const data = { pad: "y".repeat(padLen), secret };
    const bounded = boundData(data);
    const serialized = JSON.stringify(bounded);
    // Wholesale truncation: either the top-level value collapsed entirely, or (if somehow
    // under budget) the secret string is fully present — never a partial substring of it.
    const secretPrefix = secret.slice(0, secret.length - 5);
    const secretSuffixOnly = secret.slice(5);
    const containsFullSecret = serialized.includes(secret);
    const containsPartialPrefix = !containsFullSecret && serialized.includes(secretPrefix);
    const containsPartialSuffix = !containsFullSecret && serialized.includes(secretSuffixOnly);
    expect(containsPartialPrefix).toBe(false);
    expect(containsPartialSuffix).toBe(false);
    // In this specific construction the payload is over budget -> wholesale truncated.
    expect(bounded).toBe(TRUNCATED_MARKER);
  });

  it("self-referential data does not crash, is truncated at the cycle, and still redacts normally elsewhere", () => {
    type Cyclic = { self?: Cyclic; secret: string };
    const cyclic: Cyclic = { secret: "mpk-cyclicsecret" };
    cyclic.self = cyclic;

    // boundData alone (structural only) must not crash/hang and must truncate the cycle.
    const bounded = boundData(cyclic) as Record<string, unknown>;
    expect(bounded.self).toBe(TRUNCATED_MARKER);
    expect(bounded.secret).toBe("mpk-cyclicsecret"); // untouched — redaction is a separate pass

    // boundAndRedact (bound then redact) still redacts the non-cyclic secret normally.
    const { data } = boundAndRedact({ message: "m", component: "c", data: cyclic });
    const redacted = data as Record<string, unknown>;
    expect(redacted.self).toBe(TRUNCATED_MARKER);
    expect(redacted.secret).toBe(REDACTED_MARKER);
  });

  it("bound-before-redact order: a secret past the depth cutoff is truncated, never redacted-then-shown", () => {
    // At depth 7 (beyond maxDepth=6) the redact pass never even sees the secret — bound already
    // replaced the whole subtree with TRUNCATED_MARKER, not REDACTED_MARKER.
    let leaf: unknown = { secretKey: "mpk-deepsecret" };
    for (let i = 0; i < 7; i++) leaf = { nested: leaf };
    const { data } = boundAndRedact({ message: "m", component: "c", data: leaf });
    const serialized = JSON.stringify(data);
    expect(serialized).toContain(TRUNCATED_MARKER);
    expect(serialized).not.toContain("mpk-deepsecret");
  });

  it("zero secret bytes across the whole corpus (SC-001)", () => {
    const secrets = ["mpk-corpusSecretA", "mpg-corpusSecretB", "00:1A:2B:3C:4D:5E", "10.20.30.40"];
    const payload = {
      token: secrets[0],
      note: `${secrets[1]} and ${secrets[2]} and ${secrets[3]}`,
    };
    const { data } = boundAndRedact({ message: secrets[2], component: secrets[3], data: payload });
    const serialized = JSON.stringify(data);
    for (const secret of secrets) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("redactString is a pure leaf-level helper reused by both message and component paths", () => {
    expect(redactString("plain text")).toBe("plain text");
    expect(redactString("mpk-abc")).toBe(REDACTED_MARKER);
  });

  it("redactEntry never touches an already-bounded, non-object data value", () => {
    const result = redactEntry({ message: "hi", component: "c", data: "mpk-plainstring" });
    expect(result.data).toBe(REDACTED_MARKER);
  });

  it("data:undefined stays undefined through both bound and redact", () => {
    const bounded = boundData(undefined);
    expect(bounded).toBeUndefined();
    const { data } = boundAndRedact({ message: "m", component: "c" });
    expect(data).toBeUndefined();
  });

  describe("B1: IPv6 compressed / bracketed / IPv4-mapped forms are redacted", () => {
    const IPV6_POSITIVES = [
      "::1",
      "2001:db8::1",
      "[2001:db8::1]:8080",
      "fe80::1ff:fe23:4567:890a",
      "::ffff:192.168.1.1",
      "2001:0db8:0000:0000:0000:0000:0000:0001",
    ];

    for (const address of IPV6_POSITIVES) {
      it(`redacts "${address}"`, () => {
        const redacted = redactString(`reached ${address} while connecting`);
        expect(redacted).not.toContain(address);
        expect(redacted).toContain(REDACTED_MARKER);
      });
    }

    it("does NOT match a plain HH:MM time or bare hex (over-matching guard)", () => {
      expect(redactString("meeting at 12:30 sharp")).toBe("meeting at 12:30 sharp");
      expect(redactString("checksum deadbeef")).toBe("checksum deadbeef");
    });

    it("does not disturb an already-redacted MAC address (order safety)", () => {
      const redacted = redactString("mac 00:1A:2B:3C:4D:5E seen");
      expect(redacted).toBe("mac [redacted] seen");
    });
  });

  describe("B2: mpk-/mpg- credential prefixes redact even glued to adjacent word characters", () => {
    it('redacts "prefixmpk-token123" (no word boundary before the prefix)', () => {
      const redacted = redactString("leak: prefixmpk-token123 end");
      expect(redacted).not.toContain("mpk-token123");
      expect(redacted).toContain(REDACTED_MARKER);
    });

    it('redacts "xmpg-token456" (no word boundary before the prefix)', () => {
      const redacted = redactString("leak: xmpg-token456 end");
      expect(redacted).not.toContain("mpg-token456");
      expect(redacted).toContain(REDACTED_MARKER);
    });
  });

  it("Codex P2a: post-redaction marker expansion past maxBytes is wholesale truncated (never partial)", () => {
    // 750 short IPv4 matches (~7 chars each) each expand to the 10-char REDACTED_MARKER: the
    // pre-redaction structure serializes to ~7180 bytes (comfortably under the 8192 budget),
    // but post-redaction it grows to ~8260 bytes (over budget) purely from marker expansion.
    const ips = Array.from({ length: 750 }, (_, i) => `1.1.1.${i % 250}`);
    const data = { note: ips.join(" ") };
    const bounded = boundData(data);
    expect(bounded).not.toBe(TRUNCATED_MARKER); // pre-redaction: within budget
    const redacted = redactEntry({ message: "m", component: "c", data: bounded });
    expect(redacted.data).toBe(TRUNCATED_MARKER); // post-redaction: wholesale truncated
  });

  describe("Codex F7: __proto__/constructor/prototype keys are never touched by the traversal", () => {
    it("boundData skips a JSON.parse'd own __proto__ property entirely (no prototype pollution, no leak)", () => {
      const hostile = JSON.parse('{"__proto__":{"polluted":true},"safe":"ok"}') as Record<
        string,
        unknown
      >;
      // Sanity: JSON.parse really did create an own enumerable "__proto__" data property.
      expect(Object.prototype.hasOwnProperty.call(hostile, "__proto__")).toBe(true);

      const bounded = boundData(hostile) as Record<string, unknown>;
      expect(bounded.safe).toBe("ok");
      expect(Object.prototype.hasOwnProperty.call(bounded, "__proto__")).toBe(false);
      // The accumulator's own prototype must be the ordinary Object.prototype — never swapped.
      expect(Object.getPrototypeOf(bounded)).toBe(Object.prototype);
      expect(JSON.stringify(bounded)).not.toContain("polluted");
    });

    it("boundAndRedact skips constructor/prototype keys the same way", () => {
      const hostile = JSON.parse(
        '{"constructor":{"bad":1},"prototype":{"bad":2},"safe":"ok"}'
      ) as Record<string, unknown>;
      const { data } = boundAndRedact({ message: "m", component: "c", data: hostile });
      const out = data as Record<string, unknown>;
      expect(out.safe).toBe("ok");
      expect(Object.prototype.hasOwnProperty.call(out, "constructor")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(out, "prototype")).toBe(false);
    });
  });

  it("PLUGIN-SYSTEM-AC-05: redacts lifecycle exception credentials, config, private locations, and network identifiers", () => {
    const raw = [
      "Error: activation failed",
      "Authorization: Bearer super-secret-token",
      "DATABASE_URL=sqlite:///Users/operator/private/marplanner.db",
      "callback https://router.lan/admin?api_key=hidden",
      "config /etc/marplanner/operator.json",
      "windows C:\\Users\\operator\\secrets.json",
      "mac 00:1A:2B:3C:4D:5E",
      "ipv4 192.168.1.42",
      "ipv6 [fd00::1234]:8080",
    ].join("\n");

    const redacted = redactString(raw);

    expect(redacted).toContain("Error: activation failed");
    for (const secret of [
      "super-secret-token",
      "DATABASE_URL=",
      "sqlite:///Users/operator/private/marplanner.db",
      "https://router.lan/admin?api_key=hidden",
      "/etc/marplanner/operator.json",
      "C:\\Users\\operator\\secrets.json",
      "00:1A:2B:3C:4D:5E",
      "192.168.1.42",
      "fd00::1234",
    ]) {
      expect(redacted, secret).not.toContain(secret);
    }
  });

  it("PLUGIN-SYSTEM-AC-05: redacts opaque operator/private config and credential fields wholesale", () => {
    const { data } = boundAndRedact({
      message: "plugin lifecycle fault",
      component: "plugins.lifecycle",
      data: {
        operatorConfig: { tenant: "household-private", region: "lan-only" },
        privateConfiguration: "custom deployment topology",
        credentials: { clientId: "private-client", material: "opaque-value" },
        phase: "mounting",
      },
    });

    expect(data).toEqual({
      operatorConfig: REDACTED_MARKER,
      privateConfiguration: REDACTED_MARKER,
      credentials: REDACTED_MARKER,
      phase: "mounting",
    });
  });
});
