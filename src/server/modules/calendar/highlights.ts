import { randomUUID } from "node:crypto";
import { getDb } from "../../db/client";
import type { HighlightRule, HighlightRuleCreate } from "../../../shared";

export class HighlightValidationError extends Error {
  constructor(message = "invalid_highlight_rule") {
    super(message);
    this.name = "HighlightValidationError";
  }
}

type RuleRow = {
  id: string;
  emoji: string;
  keywords_json: string;
  enabled: number;
  priority: number;
};

function publicRule(row: RuleRow): HighlightRule {
  return {
    id: row.id,
    emoji: row.emoji,
    keywords: JSON.parse(row.keywords_json) as string[],
    enabled: row.enabled === 1,
    priority: row.priority,
  };
}

export function listHighlightRules(): HighlightRule[] {
  return (
    getDb()
      .prepare(
        "SELECT id, emoji, keywords_json, enabled, priority FROM calendar_highlight_rules ORDER BY priority, id"
      )
      .all() as RuleRow[]
  ).map(publicRule);
}

export function normalizeHighlightText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

function validateCreate(input: unknown): HighlightRuleCreate {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "emoji" && key !== "keywords")
  )
    throw new HighlightValidationError();
  const { emoji, keywords } = input as Partial<HighlightRuleCreate>;
  if (typeof emoji !== "string") throw new HighlightValidationError();
  const trimmedEmoji = emoji.trim();
  const graphemes = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmedEmoji),
  ];
  if (
    trimmedEmoji.length > 32 ||
    graphemes.length !== 1 ||
    !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(trimmedEmoji)
  )
    throw new HighlightValidationError();
  if (!Array.isArray(keywords) || keywords.length < 1 || keywords.length > 50)
    throw new HighlightValidationError();
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    if (typeof keyword !== "string") throw new HighlightValidationError();
    const cleaned = keyword.replace(/\s+/gu, " ").trim();
    if (cleaned.length < 1 || cleaned.length > 120) throw new HighlightValidationError();
    const key = normalizeHighlightText(cleaned);
    if (!key) throw new HighlightValidationError();
    if (!seen.has(key)) {
      normalized.push(cleaned);
      seen.add(key);
    }
  }
  return { emoji: trimmedEmoji, keywords: normalized };
}

export function createHighlightRule(input: unknown): HighlightRule {
  const { emoji, keywords } = validateCreate(input);
  const db = getDb();
  return db.transaction(() => {
    const priority = (
      db
        .prepare("SELECT COALESCE(MAX(priority), -1) + 1 AS next FROM calendar_highlight_rules")
        .get() as { next: number }
    ).next;
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      "INSERT INTO calendar_highlight_rules (id, emoji, keywords_json, enabled, priority, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)"
    ).run(id, emoji, JSON.stringify(keywords), priority, now, now);
    return { id, emoji, keywords, enabled: true, priority };
  })();
}

export function setHighlightRuleEnabled(id: string, enabled: boolean): HighlightRule | null {
  if (typeof enabled !== "boolean") throw new HighlightValidationError();
  const db = getDb();
  const result = db
    .prepare("UPDATE calendar_highlight_rules SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, Date.now(), id);
  if (!result.changes) return null;
  return publicRule(
    db
      .prepare(
        "SELECT id, emoji, keywords_json, enabled, priority FROM calendar_highlight_rules WHERE id = ?"
      )
      .get(id) as RuleRow
  );
}

function assignDenseOrder(ids: string[]): void {
  const db = getDb();
  const max = (
    db
      .prepare("SELECT COALESCE(MAX(priority), -1) AS value FROM calendar_highlight_rules")
      .get() as { value: number }
  ).value;
  const update = db.prepare(
    "UPDATE calendar_highlight_rules SET priority = ?, updated_at = ? WHERE id = ?"
  );
  const now = Date.now();
  for (const [index, id] of ids.entries()) update.run(max + index + 1, now, id);
  for (const [index, id] of ids.entries()) update.run(index, now, id);
}

export function reorderHighlightRules(orderedIds: unknown): HighlightRule[] {
  const db = getDb();
  return db.transaction(() => {
    const stored = listHighlightRules();
    if (
      !Array.isArray(orderedIds) ||
      orderedIds.length !== stored.length ||
      orderedIds.some((id) => typeof id !== "string") ||
      new Set(orderedIds).size !== stored.length ||
      orderedIds.some((id) => !stored.some((rule) => rule.id === id))
    )
      throw new HighlightValidationError("invalid_highlight_order");
    assignDenseOrder(orderedIds);
    return listHighlightRules();
  })();
}

export function deleteHighlightRule(id: string): boolean {
  const db = getDb();
  return db.transaction(() => {
    const deleted = db.prepare("DELETE FROM calendar_highlight_rules WHERE id = ?").run(id);
    if (!deleted.changes) return false;
    assignDenseOrder(listHighlightRules().map((rule) => rule.id));
    return true;
  })();
}

export function decorateHighlightTitle(
  title: string,
  description: string,
  rules: HighlightRule[]
): string {
  const haystack = normalizeHighlightText(`${title} ${description}`);
  for (const rule of rules) {
    if (
      rule.enabled &&
      rule.keywords.some((keyword) => haystack.includes(normalizeHighlightText(keyword)))
    ) {
      const trimmedTitle = title.trimStart();
      return trimmedTitle.startsWith(rule.emoji) ? trimmedTitle : `${rule.emoji} ${trimmedTitle}`;
    }
  }
  return title;
}
