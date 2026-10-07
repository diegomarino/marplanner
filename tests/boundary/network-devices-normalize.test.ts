import { describe, it, expect } from "vitest";
import {
  normalizeLiveClient,
  normalizeLiveClients,
} from "../../src/server/modules/network-devices/normalize";
import {
  unifiFixtureRawClients,
  UNIFI_FIXTURE_ONLINE_MAC,
  UNIFI_FIXTURE_BLOCKED_MAC,
  unifiFixtureIntegrationV1RawClients,
  UNIFI_INTEGRATION_V1_ONLINE_MAC,
  UNIFI_INTEGRATION_V1_BLOCKED_MAC,
  unifiFixtureCloudProjectionRawClients,
  UNIFI_CLOUD_PROJECTION_ONLINE_MAC,
  UNIFI_CLOUD_PROJECTION_BLOCKED_MAC,
} from "../helpers/unifi-fixtures";

/** docs/features/network-devices.md — normalization boundary tests (* "Shared DTOs" `LiveClient` — "NOTE: no ip field EXISTS", FR-012).
 * The fixture (`tests/helpers/unifi-fixtures.ts`) is a RAW response deliberately rich in IP
 * fields (`ip`, `last_ip`, `fixed_ip`) — this suite proves the drop against realistic input,
 * not a pre-cleaned stub.
 */
describe("network-devices normalize", () => {
  it("drops every IP-shaped field structurally: no output entry ever carries ip/last_ip/fixed_ip", () => {
    const entries = normalizeLiveClients(unifiFixtureRawClients());

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // `LiveClient` has NO ip field to even assign to — this is a structural assertion via
      // the object's own keys, not merely "value happens to be undefined".
      expect(Object.keys(entry).sort()).toEqual(["displayName", "isBlocked", "mac"]);
      expect(entry).not.toHaveProperty("ip");
      expect(entry).not.toHaveProperty("last_ip");
      expect(entry).not.toHaveProperty("fixed_ip");
    }

    // Belt-and-suspenders: scan the serialized output for any IPv4-shaped substring at all.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });

  it("skips MAC-less entries entirely (never throws, never appears in output)", () => {
    const entries = normalizeLiveClients(unifiFixtureRawClients());
    // The fixture's 5 raw entries include one MAC-less and one malformed-MAC entry — exactly
    // 3 should survive normalization.
    expect(entries).toHaveLength(3);
  });

  it("skips malformed-MAC entries (not a throw)", () => {
    expect(() => normalizeLiveClients(unifiFixtureRawClients())).not.toThrow();
    const result = normalizeLiveClient({ mac: "not-a-mac-address", blocked: false });
    expect(result).toBeNull();
  });

  it("canonicalizes MAC casing (uppercase raw -> lowercase output)", () => {
    const entries = normalizeLiveClients(unifiFixtureRawClients());
    const online = entries.find((e) => e.mac === UNIFI_FIXTURE_ONLINE_MAC);
    expect(online).toBeDefined();
    expect(online!.mac).toBe(online!.mac.toLowerCase());
  });

  it("carries the controller's blocked flag through (block-sta stay-visible shape, research D3)", () => {
    const entries = normalizeLiveClients(unifiFixtureRawClients());
    const blocked = entries.find((e) => e.mac === UNIFI_FIXTURE_BLOCKED_MAC);
    expect(blocked).toBeDefined();
    expect(blocked!.isBlocked).toBe(true);

    const online = entries.find((e) => e.mac === UNIFI_FIXTURE_ONLINE_MAC);
    expect(online!.isBlocked).toBe(false);
  });

  it("prefers `name` over `hostname` for displayName, falling back to null when neither is present", () => {
    expect(
      normalizeLiveClient({ mac: "aa:bb:cc:dd:ee:10", name: "Real Name", hostname: "raw-host" })
    ).toEqual({ mac: "aa:bb:cc:dd:ee:10", displayName: "Real Name", isBlocked: false });
    expect(normalizeLiveClient({ mac: "aa:bb:cc:dd:ee:11", hostname: "raw-host" })).toEqual({
      mac: "aa:bb:cc:dd:ee:11",
      displayName: "raw-host",
      isBlocked: false,
    });
    expect(normalizeLiveClient({ mac: "aa:bb:cc:dd:ee:12" })).toEqual({
      mac: "aa:bb:cc:dd:ee:12",
      displayName: null,
      isBlocked: false,
    });
  });

  it("null/absent mac -> null (never throws)", () => {
    expect(normalizeLiveClient({})).toBeNull();
    expect(normalizeLiveClient({ mac: 12345 })).toBeNull();
    expect(normalizeLiveClient({ mac: "" })).toBeNull();
  });

  // ── Integration v1 camelCase shape (architect update 2026-09-05) ────────────

  describe("Integration v1 camelCase fields (macAddress/isBlocked, LOCAL PROVEN path)", () => {
    it("drops ipAddress structurally too — the same IP-rich fixture, camelCase form", () => {
      const entries = normalizeLiveClients(unifiFixtureIntegrationV1RawClients());

      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(["displayName", "isBlocked", "mac"]);
        expect(entry).not.toHaveProperty("ipAddress");
      }
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    });

    it("skips MAC-less and malformed-macAddress entries the same way as the legacy shape", () => {
      const entries = normalizeLiveClients(unifiFixtureIntegrationV1RawClients());
      expect(entries).toHaveLength(3); // 5 raw entries, 1 MAC-less + 1 malformed skipped
    });

    it("canonicalizes macAddress casing (uppercase raw -> lowercase output)", () => {
      const entries = normalizeLiveClients(unifiFixtureIntegrationV1RawClients());
      const online = entries.find((e) => e.mac === UNIFI_INTEGRATION_V1_ONLINE_MAC);
      expect(online).toBeDefined();
      expect(online!.mac).toBe(online!.mac.toLowerCase());
    });

    it("reads isBlocked (camelCase boolean) as the blocked flag", () => {
      const entries = normalizeLiveClients(unifiFixtureIntegrationV1RawClients());
      const blocked = entries.find((e) => e.mac === UNIFI_INTEGRATION_V1_BLOCKED_MAC);
      expect(blocked).toBeDefined();
      expect(blocked!.isBlocked).toBe(true);

      const online = entries.find((e) => e.mac === UNIFI_INTEGRATION_V1_ONLINE_MAC);
      expect(online!.isBlocked).toBe(false);
    });

    it("macAddress (camelCase) is preferred over a coincidentally-present legacy mac field", () => {
      const result = normalizeLiveClient({ macAddress: "AA:BB:CC:DD:EE:20", mac: "not-a-mac" });
      expect(result?.mac).toBe("aa:bb:cc:dd:ee:20");
    });

    it("falls back to legacy `mac` when macAddress is absent", () => {
      const result = normalizeLiveClient({ mac: "AA:BB:CC:DD:EE:21" });
      expect(result?.mac).toBe("aa:bb:cc:dd:ee:21");
    });
  });

  // ── CLOUD Integration v1 projection (live finding, 2026-09-05) ──────────────
  //
  // Live-probed against a real console (HTTP 200, 23 clients): the cloud-proxied Integration v1
  // /clients response is a REDUCED projection with NO isBlocked and NO hostname — blocked state
  // lives in access.type instead (normalize.ts's extractRawAccessType). Without this fix, every
  // cloud-path client would normalize to isBlocked=false regardless of its real access.type,
  // silently "correcting" legitimate blocks back to unblocked on the next reconciliation pass
  // (the SC-008 class of belief corruption).

  describe("CLOUD Integration v1 projection fields (access.type, live finding 2026-09-05)", () => {
    it("drops ipAddress structurally too — the same IP-rich fixture, reduced-projection form", () => {
      const entries = normalizeLiveClients(unifiFixtureCloudProjectionRawClients());

      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(["displayName", "isBlocked", "mac"]);
        expect(entry).not.toHaveProperty("ipAddress");
      }
      const serialized = JSON.stringify(entries);
      expect(serialized).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    });

    it("skips MAC-less and malformed-macAddress entries the same way as the other two shapes", () => {
      const entries = normalizeLiveClients(unifiFixtureCloudProjectionRawClients());
      expect(entries).toHaveLength(3); // 5 raw entries, 1 MAC-less + 1 malformed skipped
    });

    it('access.type "BLOCKED" -> isBlocked=true (the field this fix adds — RED without it)', () => {
      const entries = normalizeLiveClients(unifiFixtureCloudProjectionRawClients());
      const blocked = entries.find((e) => e.mac === UNIFI_CLOUD_PROJECTION_BLOCKED_MAC);
      expect(blocked).toBeDefined();
      expect(blocked!.isBlocked).toBe(true);
    });

    it('access.type "DEFAULT" -> isBlocked=false, never a false positive', () => {
      const entries = normalizeLiveClients(unifiFixtureCloudProjectionRawClients());
      const online = entries.find((e) => e.mac === UNIFI_CLOUD_PROJECTION_ONLINE_MAC);
      expect(online).toBeDefined();
      expect(online!.isBlocked).toBe(false);
    });

    it("no display name (no name, no hostname — the cloud projection has neither) -> displayName null", () => {
      const result = normalizeLiveClient({
        macAddress: "AA:BB:CC:DD:EE:30",
        ipAddress: "10.0.0.9",
        access: { type: "DEFAULT" },
      });
      expect(result).toEqual({
        mac: "aa:bb:cc:dd:ee:30",
        displayName: null,
        isBlocked: false,
      });
    });

    it("isBlocked (when present) is still preferred over access.type — LOCAL priority unaffected", () => {
      const result = normalizeLiveClient({
        macAddress: "AA:BB:CC:DD:EE:31",
        isBlocked: false,
        access: { type: "BLOCKED" },
      });
      expect(result?.isBlocked).toBe(false);
    });

    it("a non-object access value is ignored, falling through to the legacy `blocked` field", () => {
      expect(normalizeLiveClient({ mac: "AA:BB:CC:DD:EE:32", access: "not-an-object" })).toEqual({
        mac: "aa:bb:cc:dd:ee:32",
        displayName: null,
        isBlocked: false,
      });
      expect(
        normalizeLiveClient({ mac: "AA:BB:CC:DD:EE:33", access: "not-an-object", blocked: true })
      ).toEqual({
        mac: "aa:bb:cc:dd:ee:33",
        displayName: null,
        isBlocked: true,
      });
    });
  });
});
