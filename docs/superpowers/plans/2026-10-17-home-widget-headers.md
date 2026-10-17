# Home widget headers — plan

1. i18n: add `agenda.viewAll`, `todayMeals.open` (en+es block), remove `todayMeals.viewAll`.
2. `TodayAgenda.tsx`: new header, aria-label, short month, chevron link.
3. `TodayMeals.tsx`: root becomes the link; remove heading/link.
4. Update `tests/client/today-agenda.test.tsx`, `today-meals.test.tsx`, `tests/e2e/household-dashboard.spec.ts`.
5. Update `docs/ui/household-contract.md`.
6. Gate: `check:standard` in clean detached checkout, then `check:aggregate-only`; resync assembly-cohort.
