/** Shared error class (fold): extracted out of `index.ts` into its own file to
 * break a circular import — `settings.ts` needs `DailyBriefingValidationError` (to subclass
 * `CorpusLanguageUnavailableError`), and `index.ts` now needs `settings.ts`'s * `readBlockOrder`/`resolveMemberBlockSettings` for the full-registry generation loop. With both
 * previously importing from EACH OTHER, `settings.ts extends DailyBriefingValidationError`
 * (imported from "./index") ran before `index.ts`'s own class declaration had evaluated in at
 * least one module-load order, throwing "Class extends value undefined is not a constructor".
 * `index.ts` re-exports this class so every existing external import (`routes/daily-briefing.ts`,
 * tests) keeps working unchanged.
 */
export class DailyBriefingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyBriefingValidationError";
  }
}
/** The member's briefing is paused on this weekday (spec D4). Deliberately NOT a validation
 * error: the generate route answers 200 `{skipped: true}`, and batch callers skip it. */
export class DailyBriefingPausedError extends Error {
  constructor(
    readonly memberId: string,
    readonly date: string
  ) {
    super(`Daily briefing for member "${memberId}" is paused on ${date}`);
    this.name = "DailyBriefingPausedError";
  }
}

/** No briefing row exists for the requested member/date (404). */
export class DailyBriefingNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyBriefingNotFoundError";
  }
}

/** Printing plugin inactive — nothing can be queued (409 `plugin_inactive`). */
export class DailyBriefingPrintUnavailableError extends Error {
  constructor() {
    super("The Printing plugin is inactive");
    this.name = "DailyBriefingPrintUnavailableError";
  }
}

/** The briefing exists but has no stored printable raster (409 `printable_raster_missing`). */
export class DailyBriefingRasterMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DailyBriefingRasterMissingError";
  }
}
