import type { ExternalSourceProvider } from "./index.js";

const PROVIDER_HOSTS: readonly [ExternalSourceProvider, readonly string[]][] = [
  ["google", ["google.com", "googleusercontent.com"]],
  ["microsoft", ["outlook.com", "office365.com", "office.com", "live.com", "hotmail.com"]],
  ["apple", ["icloud.com", "me.com", "apple.com"]],
];

/** Which calendar service a feed address belongs to, read from its host. It is a display label
 * only, so an unrecognised or unparseable address is simply a generic ICS feed.
 */
export function detectCalendarProvider(feedUrl: string): ExternalSourceProvider {
  let host: string;
  try {
    host = new URL(feedUrl.trim().replace(/^webcal:/i, "https:")).hostname.toLowerCase();
  } catch {
    return "ics_generic";
  }
  for (const [provider, domains] of PROVIDER_HOSTS) {
    if (domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return provider;
  }
  return "ics_generic";
}
