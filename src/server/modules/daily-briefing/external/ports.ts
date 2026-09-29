/** Injectable quote and on-this-day provider functions. Production adapters use a
 * five-second timeout and propagate provider failures to the shared daily cache.
 * Endpoint overrides come through the host API. Weather uses its own existing port.
 * Tests inject synthetic functions or point these adapters at loopback fixtures.
 */

import { getOperatorConfig } from "../../../host-api";

const FETCH_TIMEOUT_MS = 5000;

export interface QuoteOfDayData {
  text: string;
  author: string;
}

export interface OnThisDayData {
  events?: string[];
  births?: string[];
  deaths?: string[];
}

/** A resolved `null` is a legitimate "no data" answer; a throw is a failure (see module doc). */
export type QuoteSource = () => Promise<QuoteOfDayData | null>;

/** `languagePrefix` defaults `"en"` — the Wikipedia locale-prefixed-URL swap point
 * documents for a future per-block language (not wired to any settings surface yet — see
 * `../blocks/onThisDay.ts`'s doc comment).
 */
export type OnThisDaySource = (
  date: string,
  languagePrefix?: string
) => Promise<OnThisDayData | null>;

/** Strips one matched pair of outer quote characters (ASCII + Unicode curly), v1 exact port. */
function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  const openers = new Set(['"', "'", "“", "‘"]);
  const closers = new Set(['"', "'", "”", "’"]);
  if (trimmed.length >= 2 && openers.has(trimmed[0]) && closers.has(trimmed[trimmed.length - 1])) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

interface ZenQuotesEntry {
  q?: string;
  a?: string;
}

/** ZenQuotes `/api/today` adapter — v1's exact endpoint, `QUOTE_ENDPOINT`-
 * overridable (module doc). */
export const zenQuotesSource: QuoteSource = async () => {
  const overrideBase = getOperatorConfig("dailyBriefing.quoteEndpoint");
  const url = overrideBase
    ? new URL("/api/today", overrideBase).toString()
    : "https://zenquotes.io/api/today";
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`zenquotes ${res.status}`);
  const json = (await res.json()) as ZenQuotesEntry[];
  const first = json[0];
  if (!first?.q) return null;
  return { text: stripOuterQuotes(first.q), author: (first.a ?? "Unknown").trim() };
};

interface WikipediaOnThisDayItem {
  year: number;
  text: string;
}

interface WikipediaOnThisDayResponse {
  events?: WikipediaOnThisDayItem[];
  births?: WikipediaOnThisDayItem[];
  deaths?: WikipediaOnThisDayItem[];
}

/** Picks up to 3 items spread across the array's thirds (recent / middle / old) — v1's exact
 * `pickThirds` recipe: arrays under 6 entries are returned in full; `[]` returns `[]`.
 */
function pickThirds<T>(items: readonly T[]): T[] {
  if (items.length === 0) return [];
  if (items.length < 6) return [...items];
  return [
    items[Math.floor(items.length / 6)],
    items[Math.floor(items.length / 2)],
    items[Math.floor((items.length * 5) / 6)],
  ];
}

function formatItem(item: WikipediaOnThisDayItem): string {
  return `${item.year}: ${item.text}`;
}

/** Wikipedia `onthisday/all/{mm}/{dd}` adapter, language-prefixed URL — v1's exact endpoint
 * shape, extended with the `languagePrefix` swap point and `ONTHISDAY_ENDPOINT`-
 * overridable (module doc). An override replaces the whole `https://<lang>.wikipedia.org`
 * origin (a single fixture origin has no per-language subdomains to route to), keeping only the
 * real production path shape.
 */
export const wikipediaOnThisDaySource: OnThisDaySource = async (date, languagePrefix = "en") => {
  const [, mm, dd] = date.split("-");
  const path = `/api/rest_v1/feed/onthisday/all/${mm}/${dd}`;
  const overrideBase = getOperatorConfig("dailyBriefing.onThisDayEndpoint");
  const url = overrideBase
    ? new URL(path, overrideBase).toString()
    : `https://${languagePrefix}.wikipedia.org${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`onthisday ${res.status}`);
  const json = (await res.json()) as WikipediaOnThisDayResponse;

  const events = pickThirds(json.events ?? []).map(formatItem);
  const births = pickThirds(json.births ?? []).map(formatItem);
  const deaths = pickThirds(json.deaths ?? []).map(formatItem);
  if (events.length === 0 && births.length === 0 && deaths.length === 0) return null;

  const data: OnThisDayData = {};
  if (events.length > 0) data.events = events;
  if (births.length > 0) data.births = births;
  if (deaths.length > 0) data.deaths = deaths;
  return data;
};
