// ─────────────────────────────────────────────────────────────────────
// Envelope -> pressedslip Slot adapter.
// PORTED from v1 `apps/api/src/lib/daily-briefing/minimum-adapter.ts`
// (v1-study, unwrap-or-throw discipline) — verbatim per block-type case;
// only the envelope's own field names changed (v1's `BriefingEnvelope`
// carries `.version`/`.blocks[].id`, dropped here — see RenderEnvelope,
//./types.ts). Every case below is ported now even though the render
// REGISTRY (./registry.ts) registers only "message" this module (adds
// the remaining render-defs) — the adapter's job is pure data-shape
// dispatch/validation, independent of which render-defs are wired.
//
// BOUNDARY (v1 spec §2 unwrap-or-throw, preserved verbatim):
// - Reads ONLY block.type/title/data — no defaults, no coalescing, no
// fallback. Throws AdapterError on any missing/null/wrong-shaped field.
// - pressedslip's dispatch key is `blockType` (NOT `type`); `block.id` is
// NOT carried into the Slot — pressedslip derives its own synthetic id
// from `${blockType}-${index}` internally.
// ─────────────────────────────────────────────────────────────────────
export class AdapterError extends Error {
  constructor(blockType: string, field: string, reason: string) {
    super(`daily-briefing-adapter: block "${blockType}" field "${field}": ${reason}`);
    this.name = "AdapterError";
  }
}

function need<T>(blockType: string, field: string, v: T | undefined | null, kind: string): T {
  if (v === undefined || v === null) {
    throw new AdapterError(blockType, field, `missing (expected ${kind})`);
  }
  return v;
}

function needString(t: string, f: string, v: unknown): string {
  const got = need(t, f, v, "string");
  if (typeof got !== "string") throw new AdapterError(t, f, `expected string, got ${typeof got}`);
  return got;
}

function needNumber(t: string, f: string, v: unknown): number {
  const got = need(t, f, v, "number");
  if (typeof got !== "number") throw new AdapterError(t, f, `expected number, got ${typeof got}`);
  return got;
}

function needArray<T>(t: string, f: string, v: unknown, of: string): T[] {
  const got = need(t, f, v, `array<${of}>`);
  if (!Array.isArray(got)) throw new AdapterError(t, f, `expected array, got ${typeof got}`);
  return got as T[];
}

/** Dispatch by block.type. Returns the data shape the corresponding pressedslip
 * block schema expects. Throws AdapterError on any envelope-shape violation.
 */
export function adaptBlockData(blockType: string, raw: unknown): unknown {
  const data = raw as Record<string, unknown>;
  if (typeof data !== "object" || data === null) {
    throw new AdapterError(blockType, "<root>", "expected object");
  }

  switch (blockType) {
    case "quoteOfDay":
      return {
        text: needString(blockType, "text", data.text),
        author: needString(blockType, "author", data.author),
      };
    case "dadJoke":
      return { text: needString(blockType, "text", data.text) };
    case "wordOfDay": {
      const out: Record<string, unknown> = {
        word: needString(blockType, "word", data.word),
        type: needString(blockType, "type", data.type),
        definition: needString(blockType, "definition", data.definition),
      };
      if (data.example !== undefined && data.example !== null) {
        out.example = needString(blockType, "example", data.example);
      }
      if (data.pronunciation !== undefined) {
        out.pronunciation = needString(blockType, "pronunciation", data.pronunciation);
      }
      return out;
    }
    case "wouldYouRather":
      return {
        optionA: needString(blockType, "optionA", data.optionA),
        optionB: needString(blockType, "optionB", data.optionB),
      };
    case "riddle":
      return {
        question: needString(blockType, "question", data.question),
        answer: needString(blockType, "answer", data.answer),
      };
    case "animalFact":
      return {
        text: needString(blockType, "text", data.text),
        animal: needString(blockType, "animal", data.animal),
      };
    case "numberFact": {
      const kind = needString(blockType, "kind", data.kind);
      if (kind !== "math" && kind !== "trivia") {
        throw new AdapterError(blockType, "kind", `expected "math"|"trivia", got "${kind}"`);
      }
      return {
        number: needNumber(blockType, "number", data.number),
        fact: needString(blockType, "fact", data.fact),
        kind,
      };
    }
    case "trivia": {
      const diff = needString(blockType, "difficulty", data.difficulty);
      if (diff !== "easy" && diff !== "medium" && diff !== "hard") {
        throw new AdapterError(blockType, "difficulty", `expected easy|medium|hard, got "${diff}"`);
      }
      return {
        question: needString(blockType, "question", data.question),
        options: needArray<string>(blockType, "options", data.options, "string").map((o, i) => {
          if (typeof o !== "string")
            throw new AdapterError(blockType, `options[${i}]`, "expected string");
          return o;
        }),
        category: needString(blockType, "category", data.category),
        difficulty: diff,
      };
    }
    case "onThisDay": {
      const out: Record<string, unknown> = {};
      if (data.events !== undefined) {
        out.events = needArray<string>(blockType, "events", data.events, "string");
      }
      if (data.births !== undefined) {
        out.births = needArray<string>(blockType, "births", data.births, "string");
      }
      if (data.deaths !== undefined) {
        out.deaths = needArray<string>(blockType, "deaths", data.deaths, "string");
      }
      return out;
    }
    case "drawingPrompt": {
      const req = data.requiresDrawingSpace;
      if (req !== true)
        throw new AdapterError(blockType, "requiresDrawingSpace", `expected literal true`);
      return {
        prompt: needString(blockType, "prompt", data.prompt),
        requiresDrawingSpace: true as const,
      };
    }
    case "birthday": {
      const family = needArray<{ name: unknown; daysUntil: unknown }>(
        blockType,
        "family",
        data.family,
        "object"
      ).map((m, i) => ({
        name: needString(blockType, `family[${i}].name`, m.name),
        daysUntil: needNumber(blockType, `family[${i}].daysUntil`, m.daysUntil),
      }));
      const out: Record<string, unknown> = { family };
      if (data.daysUntilOwn !== undefined) {
        out.daysUntilOwn = needNumber(blockType, "daysUntilOwn", data.daysUntilOwn);
      }
      if (data.ownLabel !== undefined) {
        out.ownLabel = needString(blockType, "ownLabel", data.ownLabel);
      }
      return out;
    }
    case "today":
      return {
        bullets: needArray<string>(blockType, "bullets", data.bullets, "string").map((b, i) => {
          if (typeof b !== "string")
            throw new AdapterError(blockType, `bullets[${i}]`, "expected string");
          return b;
        }),
      };
    case "message":
      return { text: needString(blockType, "text", data.text) };
    case "reminders": {
      const groups = needArray<Record<string, unknown>>(blockType, "groups", data.groups, "object");
      return {
        groups: groups.map((g, gi) => {
          const items = needArray<Record<string, unknown>>(
            blockType,
            `groups[${gi}].items`,
            g.items,
            "object"
          );
          const out: {
            separator?: string;
            title?: string;
            items: { id?: string; value: string }[];
          } = {
            items: items.map((it, ii) => {
              const item: { id?: string; value: string } = {
                value: needString(blockType, `groups[${gi}].items[${ii}].value`, it.value),
              };
              if (it.id !== undefined) {
                item.id = needString(blockType, `groups[${gi}].items[${ii}].id`, it.id);
              }
              return item;
            }),
          };
          if (g.separator !== undefined) {
            out.separator = needString(blockType, `groups[${gi}].separator`, g.separator);
          }
          if (g.title !== undefined) {
            out.title = needString(blockType, `groups[${gi}].title`, g.title);
          }
          return out;
        }),
      };
    }
    case "meals": {
      const out: Record<string, unknown> = {};
      if (data.lunch !== undefined) out.lunch = needString(blockType, "lunch", data.lunch);
      if (data.snack !== undefined) out.snack = needString(blockType, "snack", data.snack);
      if (data.dinner !== undefined) out.dinner = needString(blockType, "dinner", data.dinner);
      return out;
    }
    case "streak":
    case "streakText": {
      const last7 = needArray<boolean>(blockType, "last7", data.last7, "boolean").map((b, i) => {
        if (typeof b !== "boolean")
          throw new AdapterError(blockType, `last7[${i}]`, "expected boolean");
        return b;
      });
      return {
        days: needNumber(blockType, "days", data.days),
        label: needString(blockType, "label", data.label),
        last7,
      };
    }
    case "weather":
    case "weatherText": {
      // Aligned to the REAL generator shape (`../blocks/weather.ts#WeatherBlockData`, i.e.
      // `ForecastDay` from `src/shared/weather.ts`) — the generator is canon, this adapter
      // adapts (the previous v1-shaped case here never matched what
      // `generateWeatherBlock`/`generateWeatherTextBlock` actually emit, so every real weather
      // payload threw `AdapterError` and both blocks landed in `failedRenderBlocks` on every
      // print for weather-configured households). `date` IS validated and returned below (it's
      // part of `ForecastDay`) — the render-defs' own zod schemas just don't declare a `date`
      // field, so pressedslip's schema parse silently strips it before `render` ever sees it;
      // this adapter has no reason to omit a field its downstream consumer doesn't need.
      const conditionKey = needString(blockType, "conditionKey", data.conditionKey);
      const allowed = [
        "clear",
        "mostlyClear",
        "partlyCloudy",
        "overcast",
        "fog",
        "drizzle",
        "freezingDrizzle",
        "rain",
        "freezingRain",
        "snow",
        "snowGrains",
        "rainShowers",
        "snowShowers",
        "thunderstorm",
        "thunderstormHail",
        "unknown",
      ] as const;
      if (!(allowed as readonly string[]).includes(conditionKey)) {
        throw new AdapterError(blockType, "conditionKey", `unknown conditionKey "${conditionKey}"`);
      }
      return {
        date: needString(blockType, "date", data.date),
        conditionKey,
        tempMinC: needNumber(blockType, "tempMinC", data.tempMinC),
        tempMaxC: needNumber(blockType, "tempMaxC", data.tempMaxC),
        rainPct: needNumber(blockType, "rainPct", data.rainPct),
      };
    }
    case "shotgun":
      return {
        ranking: needArray<string>(blockType, "ranking", data.ranking, "string").map((n, i) => {
          if (typeof n !== "string")
            throw new AdapterError(blockType, `ranking[${i}]`, "expected string");
          return n;
        }),
      };
    case "wordSearch": {
      const difficulty = needString(blockType, "difficulty", data.difficulty);
      if (difficulty !== "easy" && difficulty !== "medium" && difficulty !== "hard") {
        throw new AdapterError(
          blockType,
          "difficulty",
          `expected easy|medium|hard, got "${difficulty}"`
        );
      }
      const cols = needNumber(blockType, "cols", data.cols);
      if (!Number.isInteger(cols) || cols <= 0) {
        throw new AdapterError(blockType, "cols", `expected positive integer, got ${cols}`);
      }
      const rows = needNumber(blockType, "rows", data.rows);
      if (!Number.isInteger(rows) || rows <= 0) {
        throw new AdapterError(blockType, "rows", `expected positive integer, got ${rows}`);
      }
      const grid = needArray<unknown[]>(blockType, "grid", data.grid, "array<string>");
      if (grid.length !== rows) {
        throw new AdapterError(blockType, "grid", `expected ${rows} rows, got ${grid.length}`);
      }
      return {
        grid: grid.map((row, i) => {
          const cells = needArray<string>(blockType, `grid[${i}]`, row, "string");
          if (cells.length !== cols) {
            throw new AdapterError(
              blockType,
              `grid[${i}]`,
              `expected ${cols} cells, got ${cells.length}`
            );
          }
          return cells.map((letter, j) => {
            if (typeof letter !== "string")
              throw new AdapterError(blockType, `grid[${i}][${j}]`, "expected string");
            if (letter.length !== 1) {
              throw new AdapterError(
                blockType,
                `grid[${i}][${j}]`,
                `expected length 1, got ${letter.length}`
              );
            }
            return letter;
          });
        }),
        words: needArray<string>(blockType, "words", data.words, "string").map((word, i) => {
          if (typeof word !== "string")
            throw new AdapterError(blockType, `words[${i}]`, "expected string");
          if (word.length === 0)
            throw new AdapterError(blockType, `words[${i}]`, "expected non-empty string");
          return word;
        }),
      };
    }
    default:
      throw new AdapterError(blockType, "<type>", "unknown block type");
  }
}
