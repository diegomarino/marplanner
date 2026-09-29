import { createHash } from "node:crypto";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchIcsResult,
  type CalendarFeedHttpResponse,
  type CalendarFeedRequestContext,
} from "../../src/server/modules/calendar/fetch-ics";

const VALID_CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

function response(
  status: number,
  body = "",
  headers: Record<string, string> = {}
): CalendarFeedHttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: new Headers(headers),
    body:
      bytes.byteLength === 0
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
    dispose: vi.fn(async () => undefined),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "CalendarFeedFetchError",
    code,
    message: code,
  });
}

function invokePinnedLookup(
  lookup: LookupFunction
): Promise<Array<{ address: string; family: number }>> {
  return new Promise((resolve, reject) => {
    lookup("calendar.example.test", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses as Array<{ address: string; family: number }>);
    });
  });
}

describe("calendar ICS retrieval boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes zero requests for unsafe initial or mixed-DNS destinations", async () => {
    const request = vi.fn();

    await expectCode(
      fetchIcsResult("ftp://calendar.example.test/private.ics", {}, { request }),
      "unsafe_url"
    );
    await expectCode(
      fetchIcsResult("https://user:secret@calendar.example.test/private.ics", {}, { request }),
      "unsafe_url"
    );
    await expectCode(fetchIcsResult("http://127.0.0.1/private.ics", {}, { request }), "unsafe_url");
    await expectCode(
      fetchIcsResult(
        "https://calendar.example.test/feed.ics",
        {},
        {
          lookup: async () => [
            { address: "8.8.8.8", family: 4 },
            { address: "10.0.0.8", family: 4 },
          ],
          request,
        }
      ),
      "unsafe_url"
    );

    expect(request).not.toHaveBeenCalled();
  });

  it("pins each connection lookup to the complete validated DNS answer set", async () => {
    const firstAnswers = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(firstAnswers)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const connectedAddresses: Array<{ address: string; family: number }> = [];
    const request = vi.fn(async (context: CalendarFeedRequestContext) => {
      connectedAddresses.push(...(await invokePinnedLookup(context.lookup)));
      return response(200, VALID_CALENDAR, { "content-type": "text/calendar" });
    });

    await fetchIcsResult("https://calendar.example.test/feed.ics", {}, { lookup, request });

    expect(connectedAddresses).toEqual(firstAnswers);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("revalidates every manual redirect and never requests an unsafe redirect target", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([
        { address: "8.8.4.4", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ]);
    const request = vi.fn(async () =>
      response(302, "", { location: "https://redirect.example.test/feed.ics" })
    );

    await expectCode(
      fetchIcsResult("https://calendar.example.test/feed.ics", {}, { lookup, request }),
      "unsafe_url"
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("follows at most five redirects", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]);
    const request = vi.fn(async (context: CalendarFeedRequestContext) =>
      response(302, "", {
        location: `/redirect-${Number(context.url.pathname.split("-")[1] ?? 0) + 1}`,
      })
    );

    await expectCode(
      fetchIcsResult("https://calendar.example.test/redirect-0", {}, { lookup, request }),
      "unavailable"
    );

    expect(request).toHaveBeenCalledTimes(6);
    expect(lookup).toHaveBeenCalledTimes(6);
  });

  it("sends conditional headers and returns a 304 outcome without reading a body", async () => {
    const request = vi.fn(async (_context: CalendarFeedRequestContext) => response(304));

    const result = await fetchIcsResult(
      "https://calendar.example.test/feed.ics",
      { etag: '"feed-v1"', lastModified: "Mon, 21 Sep 2026 10:00:00 GMT" },
      { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request }
    );

    expect(result).toEqual({ kind: "not_modified" });
    expect(request.mock.calls[0]?.[0].headers).toEqual({
      "if-none-match": '"feed-v1"',
      "if-modified-since": "Mon, 21 Sep 2026 10:00:00 GMT",
    });
  });

  it("returns unchanged when an accepted payload matches the previous content hash", async () => {
    const contentHash = createHash("sha256").update(VALID_CALENDAR).digest("hex");

    const result = await fetchIcsResult(
      "https://calendar.example.test/feed.ics",
      { contentHash },
      {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        request: async () =>
          response(200, VALID_CALENDAR, {
            "content-type": "application/octet-stream",
            etag: '"feed-v2"',
          }),
      }
    );

    expect(result).toEqual({
      kind: "unchanged",
      contentHash,
      etag: '"feed-v2"',
      lastModified: null,
    });
  });

  it("aborts the complete retrieval after twelve seconds", async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      async (context: CalendarFeedRequestContext): Promise<CalendarFeedHttpResponse> =>
        new Promise((_resolve, reject) => {
          context.signal.addEventListener("abort", () => reject(context.signal.reason), {
            once: true,
          });
        })
    );

    const pending = fetchIcsResult(
      "https://calendar.example.test/feed.ics",
      {},
      { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request }
    );
    const rejection = expectCode(pending, "timeout");
    await vi.advanceTimersByTimeAsync(12_000);

    await rejection;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("applies the same twelve-second deadline while DNS resolution is stalled", async () => {
    vi.useFakeTimers();
    const request = vi.fn();
    const pending = fetchIcsResult(
      "https://calendar.example.test/feed.ics",
      {},
      { lookup: async () => new Promise(() => undefined), request }
    );
    const rejection = expectCode(pending, "timeout");

    await vi.advanceTimersByTimeAsync(12_000);

    await rejection;
    expect(request).not.toHaveBeenCalled();
  });

  it("cancels a response body that stalls past the shared deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const pending = fetchIcsResult(
      "https://calendar.example.test/feed.ics",
      {},
      {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        request: async () => ({
          status: 200,
          headers: new Headers({ "content-type": "text/calendar" }),
          body: new ReadableStream<Uint8Array>({ cancel }),
          dispose: vi.fn(async () => undefined),
        }),
      }
    );
    const rejection = expectCode(pending, "timeout");

    await vi.advanceTimersByTimeAsync(12_000);

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("normalizes Undici timeout failures to the stable timeout code", async () => {
    await expectCode(
      fetchIcsResult(
        "https://calendar.example.test/feed.ics",
        {},
        {
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
          request: async () => {
            throw Object.assign(new Error("headers timed out"), {
              code: "UND_ERR_HEADERS_TIMEOUT",
            });
          },
        }
      ),
      "timeout"
    );
  });

  it("cancels a streaming body as soon as it exceeds two MiB", async () => {
    const cancel = vi.fn(async () => undefined);
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    const request = vi.fn(async (): Promise<CalendarFeedHttpResponse> => ({
      status: 200,
      headers: new Headers({ "content-type": "text/calendar" }),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
        },
        cancel,
      }),
      dispose: vi.fn(async () => undefined),
    }));

    await expectCode(
      fetchIcsResult(
        "https://calendar.example.test/feed.ics",
        {},
        { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request }
      ),
      "too_large"
    );

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-calendar payload with a stable redacted error", async () => {
    await expectCode(
      fetchIcsResult(
        "https://calendar.example.test/feed.ics",
        {},
        {
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
          request: async () =>
            response(200, "<html>not a calendar</html>", { "content-type": "text/html" }),
        }
      ),
      "invalid_calendar"
    );
  });

  it("rejects non-success responses without exposing upstream response text", async () => {
    await expectCode(
      fetchIcsResult(
        "https://calendar.example.test/feed.ics",
        {},
        {
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
          request: async () => response(503, "upstream secret diagnostic"),
        }
      ),
      "unavailable"
    );
  });

  it("logs only a stable code when a dependency error contains URL and body secrets", async () => {
    const logs: unknown[] = [];
    const secretUrl = "https://calendar.example.test/feed.ics?token=do-not-log";
    const secretBody = "PRIVATE EVENT BODY";

    await expectCode(
      fetchIcsResult(
        secretUrl,
        {},
        {
          lookup: async () => [{ address: "8.8.8.8", family: 4 }],
          request: async () => {
            throw new Error(`${secretUrl} ${secretBody}`);
          },
          log: (message, details) => logs.push({ message, details }),
        }
      ),
      "unavailable"
    );

    expect(logs).toEqual([
      { message: "calendar_feed_fetch_failed", details: { code: "unavailable" } },
    ]);
    expect(JSON.stringify(logs)).not.toContain("do-not-log");
    expect(JSON.stringify(logs)).not.toContain(secretBody);
  });
});
