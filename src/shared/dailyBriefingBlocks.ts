// ─────────────────────────────────────────────────────────────────────
// Daily Briefing block catalogue — pure data, no I/O, no deps.
// The single declaration of every briefing block type. Server (settings validation,
// generation order and scope, OpenAPI) and client (admin matrix) derive their block lists
// from here instead of keeping hand-synced copies (issue #129).
// ─────────────────────────────────────────────────────────────────────

/** BlockScope — `shared` blocks hold the same data for every member of the household on a
 * date; `member` blocks are generated per member. */
export type BlockScope = "shared" | "member";

/** How a block gets its data: `local` reads domain seams inside the generation transaction,
 * `corpus` picks from a bundled JSON corpus (and offers a `params.language` override),
 * `external` calls a cached provider after the transaction. */
export type BlockKind = "local" | "corpus" | "external";

export type CorpusLanguage = "en" | "es";

export const BLOCK_LEVELS = ["L1", "L2", "L3", "L4"] as const;
export type BlockLevel = (typeof BLOCK_LEVELS)[number];

export const BLOCK_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type BlockDifficulty = (typeof BLOCK_DIFFICULTIES)[number];

export interface BlockCountParamSpec {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** The per-instance params a block reads. `language` is implied by `languages` on a corpus
 * block and is not listed here. */
export interface BlockParamSpec {
  readonly level?: true;
  readonly difficulty?: true;
  readonly count?: BlockCountParamSpec;
}

interface BlockDescriptorBase {
  readonly type: string;
  readonly scope: BlockScope;
  /** Default when the member has no settings row for the block (FR-013). */
  readonly defaultEnabled: boolean;
  readonly params?: BlockParamSpec;
}

export interface CorpusBlockDescriptor extends BlockDescriptorBase {
  readonly kind: "corpus";
  /** Languages with an on-disk corpus (INV-06); the first entry is not a default. */
  readonly languages: readonly CorpusLanguage[];
}

export interface NonCorpusBlockDescriptor extends BlockDescriptorBase {
  readonly kind: "local" | "external";
}

export type BriefingBlockDescriptor = CorpusBlockDescriptor | NonCorpusBlockDescriptor;

/** Every block type, in default registry order (the order missing types are appended in at
 * generation, and the admin matrix's fallback row order).
 *
 * Language notes: `wordOfDay` and `trivia` ship EN-only (no `.es.json` sibling); `riddle` is
 * EN-only by policy; `wordSearch` selects from an English word list. */
export const BRIEFING_BLOCKS = [
  { type: "shotgun", scope: "shared", kind: "local", defaultEnabled: true },
  { type: "message", scope: "member", kind: "local", defaultEnabled: true },
  { type: "streak", scope: "member", kind: "local", defaultEnabled: true },
  { type: "today", scope: "member", kind: "local", defaultEnabled: true },
  { type: "weather", scope: "shared", kind: "external", defaultEnabled: true },
  { type: "meals", scope: "shared", kind: "local", defaultEnabled: true },
  { type: "birthday", scope: "member", kind: "local", defaultEnabled: true },
  { type: "reminders", scope: "member", kind: "local", defaultEnabled: true },
  { type: "dadJoke", scope: "shared", kind: "corpus", defaultEnabled: true, languages: ["en"] },
  {
    type: "wordOfDay",
    scope: "shared",
    kind: "corpus",
    defaultEnabled: true,
    languages: ["en"],
    params: { level: true },
  },
  {
    type: "animalFact",
    scope: "shared",
    kind: "corpus",
    defaultEnabled: true,
    languages: ["en", "es"],
  },
  {
    type: "numberFact",
    scope: "shared",
    kind: "corpus",
    defaultEnabled: true,
    languages: ["en", "es"],
  },
  { type: "onThisDay", scope: "shared", kind: "external", defaultEnabled: false },
  { type: "quoteOfDay", scope: "shared", kind: "external", defaultEnabled: true },
  {
    type: "trivia",
    scope: "member",
    kind: "corpus",
    defaultEnabled: true,
    languages: ["en"],
    params: { difficulty: true },
  },
  { type: "riddle", scope: "shared", kind: "corpus", defaultEnabled: true, languages: ["en"] },
  {
    type: "wouldYouRather",
    scope: "member",
    kind: "corpus",
    defaultEnabled: true,
    languages: ["en", "es"],
  },
  {
    type: "wordSearch",
    scope: "member",
    kind: "corpus",
    defaultEnabled: true,
    languages: ["en"],
    params: { difficulty: true },
  },
  {
    type: "drawingPrompt",
    scope: "shared",
    kind: "corpus",
    defaultEnabled: true,
    languages: ["en", "es"],
  },
  { type: "streakText", scope: "member", kind: "local", defaultEnabled: true },
  { type: "weatherText", scope: "shared", kind: "external", defaultEnabled: true },
  {
    // Early-reader content only suits households with a beginning reader: opt-in.
    type: "phonics",
    scope: "shared",
    kind: "corpus",
    defaultEnabled: false,
    languages: ["en"],
    params: { level: true, count: { min: 1, max: 6, default: 3 } },
  },
] as const satisfies readonly BriefingBlockDescriptor[];

type CatalogEntry = (typeof BRIEFING_BLOCKS)[number];

export type BlockRegistryType = CatalogEntry["type"];
export type CorpusBlockType = Extract<CatalogEntry, { kind: "corpus" }>["type"];
/** Blocks generated after the read transaction, from a cached provider. */
export type ExternalBlockType = Extract<CatalogEntry, { kind: "external" }>["type"];
/** Blocks generated inside the read transaction (domain seams and corpora). */
export type InTransactionBlockType = Exclude<BlockRegistryType, ExternalBlockType>;

export const ALL_BLOCK_TYPES: readonly BlockRegistryType[] = BRIEFING_BLOCKS.map(
  (block) => block.type
);

const BY_TYPE: ReadonlyMap<string, BriefingBlockDescriptor> = new Map(
  BRIEFING_BLOCKS.map((block) => [block.type, block])
);

/** True for exactly the catalogue types — the write-boundary "known type" gate. */
export function isKnownBlockType(type: unknown): type is BlockRegistryType {
  return typeof type === "string" && BY_TYPE.has(type);
}

export function blockDescriptor(type: BlockRegistryType): BriefingBlockDescriptor {
  return BY_TYPE.get(type) as BriefingBlockDescriptor;
}

export function blockScope(type: BlockRegistryType): BlockScope {
  return blockDescriptor(type).scope;
}

export function isExternalBlockType(type: unknown): type is ExternalBlockType {
  return typeof type === "string" && BY_TYPE.get(type)?.kind === "external";
}

export function blockParamSpec(type: BlockRegistryType): BlockParamSpec {
  return blockDescriptor(type).params ?? {};
}

/** Block types default-disabled when no member settings row exists (FR-013). */
export const DEFAULT_DISABLED_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set(
  BRIEFING_BLOCKS.filter((block) => !block.defaultEnabled).map((block) => block.type)
);

function isCorpusEntry(block: CatalogEntry): block is Extract<CatalogEntry, { kind: "corpus" }> {
  return block.kind === "corpus";
}

/** Corpus-backed block types — the subset offering a `params.language` override (FR-008/FR-009). */
export const CORPUS_BLOCK_TYPES: readonly CorpusBlockType[] = BRIEFING_BLOCKS.filter(
  isCorpusEntry
).map((block) => block.type);

export function isCorpusBackedBlockType(type: unknown): type is CorpusBlockType {
  return typeof type === "string" && BY_TYPE.get(type)?.kind === "corpus";
}

/** Which languages have an on-disk corpus for each corpus-backed type (INV-06). */
export const CORPUS_LANGUAGE_AVAILABILITY: Readonly<
  Record<CorpusBlockType, readonly CorpusLanguage[]>
> = Object.fromEntries(
  BRIEFING_BLOCKS.filter(isCorpusEntry).map((block) => [block.type, block.languages])
) as unknown as Record<CorpusBlockType, readonly CorpusLanguage[]>;

export function corpusLanguagesFor(type: CorpusBlockType): readonly CorpusLanguage[] {
  return CORPUS_LANGUAGE_AVAILABILITY[type];
}

/** FR-009: true only when `type` is corpus-backed AND `language` has an on-disk corpus for it.
 * A non-corpus type or an unsupported language both resolve to `false`. */
export function isCorpusLanguageAvailable(type: string, language: string): boolean {
  if (!isCorpusBackedBlockType(type)) return false;
  return (CORPUS_LANGUAGE_AVAILABILITY[type] as readonly string[]).includes(language);
}
