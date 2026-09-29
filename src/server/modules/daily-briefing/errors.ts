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
