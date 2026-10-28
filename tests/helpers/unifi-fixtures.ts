import type { RawUniFiClient } from "../../src/server/modules/network-devices/client";

/** docs/features/network-devices.md — a RAW UniFi client-list response, deliberately
 * RICH in IP fields (`ip`, `last_ip`, `fixed_ip`) so `normalize.ts`'s structural IP drop
 * (NETWORK-DEVICES-INV-06) is proven against realistic controller input, not a pre-cleaned
 * stub. Also carries: mixed-case MACs (canonicalization), a MAC-less entry and
 * a malformed-MAC entry (both must be skipped, never thrown), and a `blocked: true` entry
 * (block-sta stay-visible shape).
 */
export function unifiFixtureRawClients(): RawUniFiClient[] {
  return [
    {
      mac: "AA:BB:CC:DD:EE:01",
      hostname: "martas-ipad",
      name: "Marta's iPad",
      ip: "192.168.1.42",
      last_ip: "192.168.1.42",
      fixed_ip: "192.168.1.100",
      blocked: false,
      essid: "HomeWifi",
      signal: -45,
    },
    {
      mac: "aa:bb:cc:dd:ee:02",
      hostname: "kitchen-echo",
      ip: "192.168.1.43",
      last_ip: "192.168.1.43",
      blocked: true,
    },
    {
      // MAC-less entry — must be skipped by normalize, never thrown.
      hostname: "no-mac-device",
      ip: "192.168.1.99",
      blocked: false,
    },
    {
      // Malformed MAC — must also be skipped.
      mac: "not-a-mac-address",
      ip: "192.168.1.55",
      blocked: false,
    },
    {
      // No display name at all (no name, no hostname) — displayName must resolve to null.
      mac: "AA:BB:CC:DD:EE:03",
      ip: "10.0.0.5",
      last_ip: "10.0.0.5",
      blocked: false,
    },
  ];
}

/** The single healthy, blocked-flag-false entry above, for tests that want one known device. */
export const UNIFI_FIXTURE_ONLINE_MAC = "aa:bb:cc:dd:ee:01";
/** The single healthy, blocked-flag-true entry above (block-sta stay-visible shape). */
export const UNIFI_FIXTURE_BLOCKED_MAC = "aa:bb:cc:dd:ee:02";

/** Architect update 2026-09-05 — a RAW Integration v1 client-list response (LOCAL, PROVEN path),
 * shaped exactly like the homelab `scripts/check-clients.sh`'s own field reads
 * (`.name //.hostname`, `.ipAddress`, `.macAddress`, `.type`, `.ssid`, `.isBlocked`) —
 * deliberately RICH in the `ipAddress` field (the structural drop applies here too) plus the
 * same MAC-less/malformed-MAC/no-display-name edge cases the legacy fixture above covers.
 */
export function unifiFixtureIntegrationV1RawClients(): RawUniFiClient[] {
  return [
    {
      macAddress: "AA:BB:CC:DD:EE:01",
      hostname: "martas-ipad",
      name: "Marta's iPad",
      ipAddress: "192.168.1.42",
      type: "WIRELESS",
      ssid: "HomeWifi",
      isBlocked: false,
    },
    {
      macAddress: "aa:bb:cc:dd:ee:02",
      hostname: "kitchen-echo",
      ipAddress: "192.168.1.43",
      type: "WIRELESS",
      ssid: "HomeWifi",
      isBlocked: true,
    },
    {
      // MAC-less entry — must be skipped by normalize, never thrown.
      hostname: "no-mac-device",
      ipAddress: "192.168.1.99",
      type: "WIRED",
      isBlocked: false,
    },
    {
      // Malformed MAC — must also be skipped.
      macAddress: "not-a-mac-address",
      ipAddress: "192.168.1.55",
      isBlocked: false,
    },
    {
      // No display name at all (no name, no hostname) — displayName must resolve to null.
      macAddress: "AA:BB:CC:DD:EE:03",
      ipAddress: "10.0.0.5",
      type: "WIRED",
      isBlocked: false,
    },
  ];
}

/** The single healthy, isBlocked-false entry above, for tests that want one known device. */
export const UNIFI_INTEGRATION_V1_ONLINE_MAC = "aa:bb:cc:dd:ee:01";
/** The single healthy, isBlocked-true entry above. */
export const UNIFI_INTEGRATION_V1_BLOCKED_MAC = "aa:bb:cc:dd:ee:02";

/** Live finding (2026-09-05) — a RAW response in the REAL cloud-proxied Integration v1 `/clients`
 * shape (live-probed against a real console, HTTP 200, 23 clients): a REDUCED projection —
 * exactly `access`/`connectedAt`/`id`/`ipAddress`/`macAddress`/`name`/`type`/`uplinkDeviceId` —
 * with NO `isBlocked` field and NO `hostname` field at all (unlike the LOCAL Integration v1
 * shape above). Blocked state lives in `access.type` instead
 * (`src/server/modules/network-devices/normalize.ts`'s `extractRawAccessType`) — `"DEFAULT"` is
 * the only value observed live so far; the `"BLOCKED"` entry below is the UNOBSERVED, presumed
 * value (see that function's doc comment for the full caveat). Deliberately RICH in `ipAddress`
 * too, same structural-drop proof as the other two fixtures, plus the same MAC-less/malformed/
 * no-display-name edge cases.
 */
export function unifiFixtureCloudProjectionRawClients(): RawUniFiClient[] {
  return [
    {
      id: "client-1",
      macAddress: "AA:BB:CC:DD:EE:01",
      name: "Marta's iPad",
      ipAddress: "192.168.1.42",
      type: "WIRELESS",
      connectedAt: "2026-09-05T10:00:00Z",
      uplinkDeviceId: "ap-1",
      access: { type: "DEFAULT" },
    },
    {
      id: "client-2",
      macAddress: "aa:bb:cc:dd:ee:02",
      name: "Kitchen Echo",
      ipAddress: "192.168.1.43",
      type: "WIRED",
      connectedAt: "2026-09-05T09:00:00Z",
      uplinkDeviceId: "switch-1",
      access: { type: "BLOCKED" }, // UNOBSERVED live — presumed per extractRawAccessType's caveat.
    },
    {
      // MAC-less entry — must be skipped by normalize, never thrown.
      id: "client-3",
      name: "no-mac-device",
      ipAddress: "192.168.1.99",
      type: "WIRED",
      access: { type: "DEFAULT" },
    },
    {
      // Malformed MAC — must also be skipped.
      id: "client-4",
      macAddress: "not-a-mac-address",
      ipAddress: "192.168.1.55",
      access: { type: "DEFAULT" },
    },
    {
      // No display name at all — the cloud projection has no `hostname` field to even fall
      // back to — displayName must resolve to null.
      id: "client-5",
      macAddress: "AA:BB:CC:DD:EE:03",
      ipAddress: "10.0.0.5",
      type: "WIRED",
      access: { type: "DEFAULT" },
    },
  ];
}

/** The single healthy, access.type "DEFAULT" entry above, for tests that want one known device. */
export const UNIFI_CLOUD_PROJECTION_ONLINE_MAC = "aa:bb:cc:dd:ee:01";
/** The single access.type "BLOCKED" entry above (UNOBSERVED live value, presumed). */
export const UNIFI_CLOUD_PROJECTION_BLOCKED_MAC = "aa:bb:cc:dd:ee:02";
