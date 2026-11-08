import { MAX_LABEL_LENGTH } from "./devices";

/** Default label for a provisioned device key, derived from its User-Agent so the Admin → Access
 * keys list stays readable. The User-Agent is a client-controlled HINT for people reading that
 * list: it MUST NEVER feed an authorization decision. The output is built only from the fixed
 * names below plus the date, so no header text is ever stored verbatim. */

export interface UserAgentSummary {
  browser: string;
  os: string;
}

const UNKNOWN = "Unknown";

// Order matters: Edge and Chrome-on-iOS also say "Safari", Edge also says "Chrome".
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:Edg|EdgA|EdgiOS)\//, "Edge"],
  [/\b(?:Firefox|FxiOS)\//, "Firefox"],
  [/\b(?:Chrome|CriOS|Chromium)\//, "Chrome"],
  [/\bSafari\//, "Safari"],
  [/^curl\//i, "curl"],
  [/^(?:node|undici|Node\.js)\b/i, "Node.js"],
];

// Order matters: iPadOS/iOS say "like Mac OS X", Android says "Linux".
const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPad\b/, "iPadOS"],
  [/\b(?:iPhone|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\b(?:Macintosh|Mac OS X)\b/, "macOS"],
  [/\b(?:Linux|X11)\b/i, "Linux"],
];

function firstMatch(userAgent: string, table: ReadonlyArray<readonly [RegExp, string]>): string {
  return table.find(([pattern]) => pattern.test(userAgent))?.[1] ?? UNKNOWN;
}

/** Best-effort browser and OS names; anything unrecognised is "Unknown". */
export function describeUserAgent(userAgent: string): UserAgentSummary {
  return { browser: firstMatch(userAgent, BROWSERS), os: firstMatch(userAgent, SYSTEMS) };
}

/** `"<Browser> · <OS> · <date>"`, or `"Device · <date>"` without a User-Agent, capped at the
 * label limit. `date` is the household-local `YYYY-MM-DD` of the provisioning. */
export function defaultCredentialLabel(userAgent: string | undefined, date: string): string {
  const hint = userAgent?.trim();
  let label: string;
  if (hint) {
    const { browser, os } = describeUserAgent(hint);
    label = `${browser} · ${os} · ${date}`;
  } else {
    label = `Device · ${date}`;
  }
  return label.slice(0, MAX_LABEL_LENGTH);
}
