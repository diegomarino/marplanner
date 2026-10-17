# Home widget headers (v1 look) — design

Date: 2026-10-17. Owner request: copy the original Marplanner v1 home headers.

## Decisions (autonomous brainstorming)
- Size: small change; written spec + plan kept for the record.
- Agenda (`TodayAgenda.tsx`): drop the uppercase "Agenda" heading and the separate "Calendar" link.
  The household date becomes the `h2` (`font-display text-xl font-bold`, month `short`, e.g.
  "Saturday, Oct 17"). The same row holds one right-aligned "View all ›" link to `appUrl("/calendar")`
  with a `ChevronRight` icon (decorative). The section keeps its accessible name through
  `aria-label={t("agenda.title")}` (region "Today's agenda"), because the heading is now only a date
  and is absent while loading/failed.
- Meals (`TodayMeals.tsx`): title and "View all meals" link removed. The widget root is one
  `<a href=appUrl("/meals")>` with `aria-label` "Today's meals — open Meals" / "Comidas de hoy —
  abrir Comidas", a visible `focus-visible` ring, and no nested interactive elements. Strip content
  is unchanged. `HomeSurface` error-boundary title keeps `todayMeals.title`.
- i18n (en+es together): add `agenda.viewAll`, `todayMeals.open`; remove `todayMeals.viewAll`.
- Docs: `docs/ui/household-contract.md` updated. Tests: unit + e2e updated; density tests not blocking.

## Non-goals
No change to agenda rows, groups, data loading, or chores widget.
