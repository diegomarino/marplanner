/** acceptance-only outbound observer.
 * Load only in an explicitly authorized isolated process with:
 * --import./tools/validation/provider-egress-observer.mjs
 * The output destination is supplied through MP_ACCEPTANCE_EGRESS_LOG and must point to an
 * ephemeral file outside the repository. This module forwards fetch calls unchanged, performs no
 * request of its own, and deliberately emits no request input, URL, host, query value, header,
 * body, response payload, response identifier, coordinate, timestamp, PID, or machine identity.
 */

import { appendFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const outputPath = process.env.MP_ACCEPTANCE_EGRESS_LOG;
if (!outputPath) {
  throw new Error("MP_ACCEPTANCE_EGRESS_LOG is required for the Slice 025 egress observer");
}

const originalFetch = globalThis.fetch.bind(globalThis);
let ordinal = 0;

function append(record) {
  appendFileSync(outputPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

function requestUrl(input) {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return null;
}

function isWeatherProviderRequest(input) {
  try {
    const url = requestUrl(input);
    if (!url || !url.pathname.endsWith("/v1/forecast")) return false;
    return ["latitude", "longitude", "timezone", "current", "hourly", "daily"].every((key) =>
      url.searchParams.has(key)
    );
  } catch {
    return false;
  }
}

function statusClass(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return "none";
  return `${Math.trunc(status / 100)}xx`;
}

function failureClass(error) {
  const name = error && typeof error === "object" ? error.name : undefined;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network-error";
}

append({ kind: "weather-provider-observer-ready" });

globalThis.fetch = async function observedFetch(input, init) {
  if (!isWeatherProviderRequest(input)) return originalFetch(input, init);

  ordinal += 1;
  const currentOrdinal = ordinal;
  const started = performance.now();

  try {
    const response = await originalFetch(input, init);
    append({
      kind: "weather-provider-egress",
      ordinal: currentOrdinal,
      outcome: response.ok ? "success" : "failure",
      statusClass: statusClass(response.status),
      failureClass: "none",
      elapsedMs: Math.round(performance.now() - started),
    });
    return response;
  } catch (error) {
    append({
      kind: "weather-provider-egress",
      ordinal: currentOrdinal,
      outcome: "failure",
      statusClass: "none",
      failureClass: failureClass(error),
      elapsedMs: Math.round(performance.now() - started),
    });
    throw error;
  }
};
