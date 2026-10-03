# ADR-041 Render Artefact Ownership & Device Render Context

Status: accepted
Owner: architecture
Decision date: 2026-06-28

## Decision

Rendering is split **at the device boundary**, and the printable hand-off carries
a producer-agnostic **device render context**.

### Ownership split

- **Producer owns content → printable raster.** A producer (e.g. Daily Briefing)
  renders its payload to a **device-independent printable raster** (1-bit PNG at
  the target width) and **stores that artefact in its own namespace** (ADR-039),
  not as a field the pipeline reaches into. Per-block render-failure isolation
  stays with the producer (status `partial`/`render-failed`).
- **Printing owns raster → device bytes + delivery.** The pipeline performs the
  printer-specific step — ESC/POS wrapping for the paired printer's paper
  width/transport — then the Bluetooth send (ADR-035 UI-bound execution). Printing
  owns printer config (ADR-021).
- **Hand-off = fetch-at-execute.** At send time, Printing fetches the producer's
  current artefact through the producer's host-mediated interface (ADR-022,
  ADR-039 absence-tolerant). Printing never reads a foreign table and holds no
  producer-specific knowledge.

### Device render context

The printable contract includes a **device render context**: a producer-agnostic
descriptor of the target device's capabilities/constraints, **owned by Printing**
(which owns device config) and **passed to the producer at render time**. v2
populates only `paperWidthDots` (canonical 576 / 80 mm). It is **extensible**:
future fields describe other device formats/capabilities.

Consequence (forward-looking): an output that cannot be expressed on the
available device is an **absence-tolerant skip** — no compatible device → don't
print, surface unavailable — the same pattern as an inactive plugin / unheard
event. This extends ADR-035 capability registration one level: the _device_
declares render constraints; producers adapt or bow out.

### Mapping to ADR-035 decision/execution split

- Content → raster is **server-side generation** (Daily Briefing is a server-side
  global service).
- Raster → device bytes → Bluetooth send is the **UI-bound executor**.

## Rationale

Cutting at the device boundary is what makes the pipeline genuinely
producer-agnostic: everything content-shaped (blocks → pixels) stays with the
producer; everything device-shaped (pixels → this printer's ESC/POS) stays with
Printing. "Print today's calendar" then works unchanged — Calendar renders its
own raster to the same contract. Relocating the bitmap off the shared briefing
row into the producer's namespace is consistent with the `printedAt` relocation
(ADR-019).

## Affected Specs

- `docs/rewrite-spec/11-daily-briefing.md` — render ownership, artefact in
  producer namespace
- `docs/rewrite-spec/13-printing-pipeline.md` — raster→ESC/POS, device render
  context, fetch-at-execute

## Data / Setup Implications

Fresh deployment: the render artefact (`bitmap`, height) lives in the producer's
namespaced tables, not on a shared row. Printing stores no producer artefacts;
it converts and delivers. No legacy import (ADR-026).

## Acceptance Criteria

- Given a briefing, then Daily Briefing renders and stores its raster in its own
  namespace; Printing does not read the briefing's tables.
- Given a print, then Printing fetches the current raster at execute, wraps it
  for the configured paper width/transport, and sends it.
- Given a future producer (e.g. Calendar), then it renders to the same printable
  contract and Printing's device stage is unchanged.
- Given an output incompatible with the available device, then it is skipped
  (unavailable), not force-printed.

## Open Questions

- Exact location of ESC/POS conversion (server vs browser within the UI-bound
  executor) — implementation detail; ownership (Printing) is fixed here.
- Full device-context schema beyond `paperWidthDots` — added when a second
  device/format exists.

## Traceability

- Related prior: relates to `ADR-019`, `ADR-021` (printer config), `ADR-015` (render/i18n)
- Related: `ADR-035` (decision/execution split, capability registration),
  `ADR-039` (namespace ownership, absence-tolerance), `ADR-022` (fetch-at-execute)
- Domain grill: `../domain-grills/daily-briefing-printing.md` (Q4)
