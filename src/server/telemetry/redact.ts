/** Pure redaction/bounding module (Constitution II, NON-NEGOTIABLE) — no fs/db/network I/O.
 * Per: bound `data` structurally FIRST (size/depth/key-count), THEN redact
 * (key-name deny-list + value-pattern) over `data`, `message`, and `component`. The pipeline
 * caller (`src/server/telemetry/index.ts`'s `writeClientLog`) invokes `boundData` and
 * `redactEntry` as two SEPARATE steps with the flood check in between (
 * validate -> bound -> flood -> redact -> insert); `boundAndRedact` below is a convenience
 * wrapper (no flood step) for direct corpus testing.
 * Never-partial-secrets rule: the size bound NEVER slices a string value — an over-budget
 * value is either kept whole or replaced WHOLESALE with the `"[truncated]"` marker. A secret
 * straddling the size boundary can therefore never appear as a partial byte sequence: it is
 * either entirely present (under budget) or entirely replaced (over budget).
 * Traversal (both bound and redact) is ITERATIVE with a visited-set: JSON.parse'd HTTP bodies
 * cannot cycle, but server-side producers (FR-010) may pass a live JS object that does — the
 * visited-set guard is cheap insurance against a self-referential payload hanging or crashing
 * the choke point.
 */

export interface BoundLimits {
  /** Max serialized size of `data`, measured in UTF-8 bytes post-JSON.stringify. */
  maxBytes: number;
  /** Max nesting depth (0 = the top-level value itself). */
  maxDepth: number;
  /** Max total object-key / array-element count across the whole `data` tree. */
  maxKeys: number;
}

/** Impl-tuned per contract (frozen at plan, not in the contract itself). */
export const DEFAULT_LIMITS: BoundLimits = {
  maxBytes: 8192,
  maxDepth: 6,
  maxKeys: 64,
};

export const TRUNCATED_MARKER = "[truncated]";
export const REDACTED_MARKER = "[redacted]";

/** Deny-list on OBJECT KEY NAMES inside `data` — a match redacts the WHOLE property value. */
const KEY_DENY_PATTERN =
  /token|key|pin|secret|cookie|authorization|password|url|config|credential/i;

/** Keys that must NEVER be assigned via bracket notation onto a plain-object accumulator:
 * `obj["__proto__"] = x` invokes Object.prototype's accessor SETTER (mutating the object's own
 * prototype) rather than creating an own data property — `constructor`/`prototype` carry the
 * same class of risk. `JSON.parse('{"__proto__":...}')` DOES create a real own property with
 * that name (unlike an object literal), so a hostile HTTP body can genuinely produce this key.
 * Explicitly skipping it (rather than relying on the accidental "assignment silently does
 * nothing useful" behavior) makes the traversal robust regardless of how the output object is
 * built.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** IPv6 literal matcher — covers the fully-expanded form, `::`-compressed forms (anywhere in the
 * address, including bare `::1`), and IPv4-mapped/embedded forms (`::ffff:192.168.1.1`). Built
 * from the standard "8 alternatives" construction; wrapped in hex/colon lookaround boundaries so
 * the engine backtracks across alternatives until it finds the MAXIMAL contiguous match (a naive
 * first-alternative-wins scan would stop early, e.g. matching only `2001:db8::` out of
 * `2001:db8::1`) — `(?!\.\d)` additionally blocks stopping mid dotted-quad. Deliberately requires
 * a literal `::` (or exactly 8 groups) so a bare `HH:MM` clock value or an already-MAC-shaped
 * token (6 groups, single colons, redacted by the MAC pattern already) can never match.
 */
const IPV6_SEGMENT = "[0-9a-fA-F]{1,4}";
const IPV4_IN_V6 = "(?:\\d{1,3}\\.){3}\\d{1,3}";
const IPV6_CORE = [
  `(?:${IPV6_SEGMENT}:){7}${IPV6_SEGMENT}`, // fully expanded, 8 groups
  `(?:${IPV6_SEGMENT}:){1,7}:`, // trailing::
  `(?:${IPV6_SEGMENT}:){1,6}:${IPV6_SEGMENT}`,
  `(?:${IPV6_SEGMENT}:){1,5}(?::${IPV6_SEGMENT}){1,2}`,
  `(?:${IPV6_SEGMENT}:){1,4}(?::${IPV6_SEGMENT}){1,3}`,
  `(?:${IPV6_SEGMENT}:){1,3}(?::${IPV6_SEGMENT}){1,4}`,
  `(?:${IPV6_SEGMENT}:){1,2}(?::${IPV6_SEGMENT}){1,5}`,
  `${IPV6_SEGMENT}:(?::${IPV6_SEGMENT}){1,6}`,
  `:(?:(?::${IPV6_SEGMENT}){1,7}|:)`, // leading::, incl. bare::1 /::
  `::(?:ffff(?::0{1,4})?:)?${IPV4_IN_V6}`, // IPv4-mapped
  `(?:${IPV6_SEGMENT}:){1,4}:${IPV4_IN_V6}`, // IPv4-embedded
].join("|");
const IPV6_PATTERN = new RegExp(`(?<![0-9a-fA-F:])(?:${IPV6_CORE})(?![0-9a-fA-F:]|\\.\\d)`, "gi");

/** Value-pattern deny-list, applied to every string leaf (recursively in `data`, and directly
 * to `message`/`component`) — replaces only the MATCHED SUBSTRING, not the whole string. The
 * mpk-/mpg- prefixes deliberately carry NO leading `\b` (B2): a word-boundary requirement lets a
 * credential escape detection entirely whenever it's glued onto adjacent word characters (e.g.
 * `prefixmpk-token123` — no boundary exists right before `mpk-` there).
 */
const VALUE_PATTERNS: RegExp[] = [
  /\b(?:authorization\s*:\s*)?(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:DATABASE_URL|PLUGIN_CONFIG|OPERATOR_CONFIG|CONFIG_PATH)\s*=\s*[^\s]+/gi,
  /mpk-[\w-]+/gi,
  /mpg-[\w-]+/gi,
  /\b(?:https?|sqlite):\/\/[^\s]+/gi,
  /\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+/g,
  /\/(?:Users|home|etc|var|private|opt|srv|tmp)\/(?:[^\s/]+\/)*[^\s,;]+/g,
  // MAC address, `:` or `-` separated, case-insensitive.
  /\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\b/gi,
  // IPv6 BEFORE IPv4 — lets an IPv4-mapped form (`::ffff:1.2.3.4`) redact as one unit; a plain
  // dotted-quad never matches the IPv6 pattern (it requires a colon), so order is safe.
  IPV6_PATTERN,
  // IPv4 dotted-quad.
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
];

/** Apply every value pattern to a string leaf, redacting only matched substrings. */
export function redactString(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED_MARKER);
  }
  return out;
}

type ContainerParent =
  { kind: "array"; target: unknown[] } | { kind: "object"; target: Record<string, unknown> };

interface BoundFrame {
  input: unknown;
  depth: number;
  /** null = write directly to the (boxed) root holder. */
  parent: ContainerParent | null;
  key: string | number | null;
}

/** Structural bound of `data` ONLY (message/component are length-capped at the per-entry
 * validation layer, not here — over-length there is a per-entry DROP, never a truncation).
 * `undefined` in, `undefined` out (no `data` supplied). Depth-over-budget subtrees and
 * key/element-count-over-budget siblings are replaced with `TRUNCATED_MARKER`; if the
 * resulting structure still serializes over `maxBytes`, the WHOLE bounded value is replaced
 * with `TRUNCATED_MARKER` (wholesale — never a string slice; see module doc).
 */
export function boundData(data: unknown, limits: BoundLimits = DEFAULT_LIMITS): unknown {
  if (data === undefined) return undefined;

  const visited = new Set<unknown>();
  const keyBudget = { remaining: limits.maxKeys };
  const root: { value: unknown } = { value: undefined };

  const setResult = (frame: BoundFrame, value: unknown): void => {
    if (frame.parent === null) {
      root.value = value;
    } else if (frame.parent.kind === "array") {
      frame.parent.target[frame.key as number] = value;
    } else {
      frame.parent.target[frame.key as string] = value;
    }
  };

  const stack: BoundFrame[] = [{ input: data, depth: 0, parent: null, key: null }];

  while (stack.length > 0) {
    const frame = stack.pop() as BoundFrame;
    const { input, depth } = frame;

    if (depth > limits.maxDepth) {
      setResult(frame, TRUNCATED_MARKER);
      continue;
    }
    if (input === null || typeof input !== "object") {
      setResult(frame, input);
      continue;
    }
    if (visited.has(input)) {
      // Self-referential structure — never traversed twice.
      setResult(frame, TRUNCATED_MARKER);
      continue;
    }
    visited.add(input);

    if (Array.isArray(input)) {
      const outArr: unknown[] = [];
      setResult(frame, outArr);
      let truncatedHere = false;
      for (const item of input) {
        if (keyBudget.remaining <= 0) {
          truncatedHere = true;
          break;
        }
        keyBudget.remaining -= 1;
        const idx = outArr.length;
        outArr.push(undefined);
        stack.push({
          input: item,
          depth: depth + 1,
          parent: { kind: "array", target: outArr },
          key: idx,
        });
      }
      if (truncatedHere) outArr.push(TRUNCATED_MARKER);
    } else {
      const outObj: Record<string, unknown> = {};
      setResult(frame, outObj);
      let truncatedHere = false;
      for (const key of Object.keys(input as Record<string, unknown>)) {
        if (DANGEROUS_KEYS.has(key)) continue; // never touched, never counted
        if (keyBudget.remaining <= 0) {
          truncatedHere = true;
          continue; // drop remaining keys entirely
        }
        keyBudget.remaining -= 1;
        stack.push({
          input: (input as Record<string, unknown>)[key],
          depth: depth + 1,
          parent: { kind: "object", target: outObj },
          key,
        });
      }
      if (truncatedHere) outObj.__truncated__ = TRUNCATED_MARKER;
    }
  }

  const size = Buffer.byteLength(JSON.stringify(root.value) ?? "null", "utf8");
  if (size > limits.maxBytes) {
    // Wholesale replacement — never a partial-byte slice of the serialized structure (which
    // could otherwise cut a secret value in half).
    return TRUNCATED_MARKER;
  }
  return root.value;
}

/** Iteratively redact a (already-bounded) `data` tree: key-name deny-list + value patterns. */
function redactData(data: unknown): unknown {
  if (data === undefined) return undefined;
  if (typeof data === "string") return redactString(data);
  if (data === null || typeof data !== "object") return data;

  const visited = new Set<unknown>();
  const root: { value: unknown } = { value: undefined };

  const setResult = (frame: BoundFrame, value: unknown): void => {
    if (frame.parent === null) {
      root.value = value;
    } else if (frame.parent.kind === "array") {
      frame.parent.target[frame.key as number] = value;
    } else {
      frame.parent.target[frame.key as string] = value;
    }
  };

  const stack: BoundFrame[] = [{ input: data, depth: 0, parent: null, key: null }];

  while (stack.length > 0) {
    const frame = stack.pop() as BoundFrame;
    const { input } = frame;

    if (typeof input === "string") {
      setResult(frame, redactString(input));
      continue;
    }
    if (input === null || typeof input !== "object") {
      setResult(frame, input);
      continue;
    }
    if (visited.has(input)) {
      setResult(frame, TRUNCATED_MARKER);
      continue;
    }
    visited.add(input);

    if (Array.isArray(input)) {
      const outArr: unknown[] = new Array(input.length);
      setResult(frame, outArr);
      input.forEach((item, idx) => {
        stack.push({ input: item, depth: 0, parent: { kind: "array", target: outArr }, key: idx });
      });
    } else {
      const outObj: Record<string, unknown> = {};
      setResult(frame, outObj);
      for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (DANGEROUS_KEYS.has(key)) continue; // never touched
        if (KEY_DENY_PATTERN.test(key)) {
          // Whole value redacted — never traversed, regardless of its shape.
          outObj[key] = REDACTED_MARKER;
          continue;
        }
        stack.push({ input: value, depth: 0, parent: { kind: "object", target: outObj }, key });
      }
    }
  }

  return root.value;
}

export interface RedactableEnvelope {
  message: string;
  component: string;
  data: unknown;
}

/** Redact an already-bounded envelope: value-pattern redaction over `message` AND `component`
 * (`component` is attacker-controlled and forwarded by the 5-field sink projection),
 * plus key-name + value-pattern redaction recursively over `data`.
 * Value-pattern redaction can EXPAND `data`'s serialized size (a short matched value replaced by
 * the 10-char `"[redacted]"` marker) past `maxBytes` even though the pre-redaction structure was
 * within budget. Re-check the byte cap post-redaction; an over-budget result is replaced
 * WHOLESALE with `TRUNCATED_MARKER` — same never-partial-secrets rule as `boundData` (every
 * value that ends up in the output has already been through value-pattern redaction by this
 * point, so a wholesale cap here can only ever drop already-sanitized text, never a raw secret).
 */
export function redactEntry(
  entry: RedactableEnvelope,
  limits: BoundLimits = DEFAULT_LIMITS
): RedactableEnvelope {
  const redactedData = redactData(entry.data);
  const boundedData = enforceByteCapPostRedaction(redactedData, limits);
  return {
    message: redactString(entry.message),
    component: redactString(entry.component),
    data: boundedData,
  };
}

function enforceByteCapPostRedaction(data: unknown, limits: BoundLimits): unknown {
  if (data === undefined) return undefined;
  const size = Buffer.byteLength(JSON.stringify(data) ?? "null", "utf8");
  return size > limits.maxBytes ? TRUNCATED_MARKER : data;
}

/** Convenience wrapper — bound THEN redact in one call, for corpus tests and any caller that
 * doesn't need a step (e.g. flood-check) between the two. The real ingest pipeline
 * (`writeClientLog`) calls `boundData` and `redactEntry` separately.
 */
export function boundAndRedact(
  entry: { message: string; component: string; data?: unknown },
  limits: BoundLimits = DEFAULT_LIMITS
): RedactableEnvelope {
  const bounded = boundData(entry.data, limits);
  return redactEntry({ message: entry.message, component: entry.component, data: bounded }, limits);
}
