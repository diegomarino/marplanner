import { describe, expect, it, vi } from "vitest";
import { getDb } from "../../src/server/db/client";
import {
  listExternalSources,
  upsertExternalSource,
} from "../../src/server/modules/calendar/external-sources";
import { fetchIcs } from "../../src/server/modules/calendar/fetch-ics";
import { useIsolatedDb } from "../helpers/db";

describe("calendar external-source domain seam", () => {
  useIsolatedDb();

  it("rejects unsafe URLs before persistence, including credentials, private literals, and private DNS answers", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]);

    await expect(
      upsertExternalSource(
        {
          id: "credentials",
          name: "Credentials",
          provider: "google",
          feedUrl: "https://user:secret@example.test/feed",
          enabled: true,
          pollIntervalMin: 60,
        },
        { lookup }
      )
    ).rejects.toMatchObject({ code: "unsafe_url", message: "unsafe_url" });
    await expect(
      upsertExternalSource(
        {
          id: "loopback",
          name: "Loopback",
          provider: "google",
          feedUrl: "http://127.0.0.1/feed",
          enabled: true,
          pollIntervalMin: 60,
        },
        { lookup }
      )
    ).rejects.toMatchObject({ code: "unsafe_url", message: "unsafe_url" });
    await expect(
      upsertExternalSource(
        {
          id: "dns",
          name: "DNS",
          provider: "google",
          feedUrl: "https://calendar.example.test/feed",
          enabled: true,
          pollIntervalMin: 60,
        },
        { lookup }
      )
    ).rejects.toMatchObject({ code: "unsafe_url", message: "unsafe_url" });
    expect(
      getDb().prepare("SELECT COUNT(*) AS count FROM calendar_external_sources").get()
    ).toEqual({ count: 0 });
  });

  it("rejects numeric special-use literal ranges and DNS results with any unsafe answer", async () => {
    const input = {
      name: "Unsafe address",
      provider: "ics_generic",
      enabled: true,
      pollIntervalMin: 60,
    };

    for (const [id, feedUrl] of [
      ["deprecated-6to4-relay", "https://192.88.99.1/feed"],
      ["this-network", "https://0.1.2.3/feed"],
      ["private-a", "https://10.0.0.1/feed"],
      ["shared-space", "https://100.64.0.1/feed"],
      ["loopback", "https://127.0.0.1/feed"],
      ["link-local", "https://169.254.1.1/feed"],
      ["private-b", "https://172.16.0.1/feed"],
      ["protocol-assignments", "https://192.0.0.1/feed"],
      ["documentation-one", "https://192.0.2.1/feed"],
      ["private-c", "https://192.168.0.1/feed"],
      ["benchmark", "https://198.18.0.1/feed"],
      ["documentation-two", "https://198.51.100.1/feed"],
      ["documentation-three", "https://203.0.113.1/feed"],
      ["multicast", "https://224.0.0.1/feed"],
      ["deprecated-site-local", "https://[fec0::1]/feed"],
      ["unspecified-v6", "https://[::]/feed"],
      ["loopback-v6", "https://[::1]/feed"],
      ["mapped-loopback", "https://[::ffff:7f00:1]/feed"],
      ["compatible-private", "https://[::10.0.0.1]/feed"],
      ["nat64-private", "https://[64:ff9b::a00:1]/feed"],
      ["reserved-ipv4", "https://240.0.0.1/feed"],
      ["limited-broadcast", "https://255.255.255.255/feed"],
      ["discard-only-v6", "https://[100::1]/feed"],
      ["ietf-special-use", "https://[2001::1]/feed"],
      ["deprecated-6to4", "https://[2002::1]/feed"],
      ["local-translation", "https://[64:ff9b:1::1]/feed"],
      ["documentation-ipv6", "https://[3fff::1]/feed"],
      ["segment-routing-v6", "https://[5f00::1]/feed"],
      ["unique-local-v6", "https://[fc00::1]/feed"],
      ["link-local-v6", "https://[fe80::1]/feed"],
      ["multicast-v6", "https://[ff02::1]/feed"],
    ]) {
      await expect(
        upsertExternalSource({ ...input, id, feedUrl }, { lookup: vi.fn() })
      ).rejects.toMatchObject({ code: "unsafe_url", message: "unsafe_url" });
    }

    await expect(
      upsertExternalSource(
        { ...input, id: "mixed-dns", feedUrl: "https://calendar.example.test/feed" },
        {
          lookup: async () => [
            { address: "8.8.8.8", family: 4 },
            { address: "192.88.99.1", family: 4 },
          ],
        }
      )
    ).rejects.toMatchObject({ code: "unsafe_url", message: "unsafe_url" });
  });

  it("normalizes unknown providers and imports through provider-agnostic ICS retrieval", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const rawUrl = "https://calendar.example.test/private/feed?token=top-secret";
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);

    await upsertExternalSource(
      {
        id: "source",
        name: "Team calendar",
        provider: "unrecognized",
        feedUrl: rawUrl,
        enabled: true,
        pollIntervalMin: 60,
      },
      { lookup }
    );

    const importedBody = await fetchIcs(rawUrl, {
      lookup,
      transport: async () => "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
    });

    expect(listExternalSources()).toEqual([
      {
        id: "source",
        name: "Team calendar",
        provider: "ics_generic",
        maskedUrl: "https://calendar.example.test/***",
        enabled: true,
        pollIntervalMin: 60,
        phase: null,
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastErrorCode: null,
        consecutiveFailures: 0,
        lastImportedCount: 0,
        lastSkippedCount: 0,
      },
    ]);
    expect(importedBody).toContain("BEGIN:VCALENDAR");
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(listExternalSources())).not.toContain(rawUrl);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("defaults polling to 15 minutes and rejects out-of-range API values", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);

    await upsertExternalSource(
      {
        id: "default-polling",
        name: "Default polling",
        provider: "ics_generic",
        feedUrl: "https://calendar.example.test/default",
      },
      { lookup }
    );
    expect(listExternalSources()[0]?.pollIntervalMin).toBe(15);

    for (const pollIntervalMin of [0, 1.5, 1441]) {
      await expect(
        upsertExternalSource(
          {
            id: `invalid-${pollIntervalMin}`,
            name: "Invalid polling",
            provider: "ics_generic",
            feedUrl: `https://calendar.example.test/invalid-${pollIntervalMin}`,
            pollIntervalMin,
          },
          { lookup }
        )
      ).rejects.toMatchObject({ code: "invalid_external_source" });
    }

    await expect(
      upsertExternalSource(
        {
          id: "name-too-long",
          name: "x".repeat(121),
          provider: "ics_generic",
          feedUrl: "https://calendar.example.test/name-too-long",
        },
        { lookup }
      )
    ).rejects.toMatchObject({ code: "invalid_external_source" });
  });
});
