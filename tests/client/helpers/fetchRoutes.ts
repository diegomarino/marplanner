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
