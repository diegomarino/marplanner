# ADR-066 — ESC/POS conversion placement: server-side (candidate B full)

- **Status**: accepted (2026-09-05)
- **Context**: implementation-time ADR, authored at work item 18 planning. ADR-041
  (render ownership and device context) deliberately left one decision open: where the
  raster→ESC/POS conversion runs. The v1 predecessor performs BOTH the raster decode
  (canvas, browser-bound) and the ESC/POS wrap in the kiosk browser; the server only
  serves a PNG. `docs/architecture/contracts/printing.md`'s own open-decision note mirrors
  ADR-041's.

## Decision

The **server owns the entire printable artifact**: content render, raster handling,
and the ESC/POS wrap all execute server-side; the kiosk browser executor receives
final printer-ready bytes and is a pure transport (fetch → chunked Web Bluetooth GATT
write → acknowledge). Chosen by the maintainer in the recorded architecture grill of
2026-09-05 ("candidate B FULL"), from the study of the v1 implementation
(`STUDY-018-v1.override.md`, peer-reviewed) and its candidate comparison (A /
B-lite / B / C / D — C and D eliminated by Bluetooth-only hardware).

## Rationale

1. **Testability**: the only genuinely browser-bound step in v1 was the canvas-based
   PNG decode; moving the whole artifact server-side makes the complete printable —
   including the exact ESC/POS byte stream — golden-file testable in CI with no
   browser and no hardware (Constitution IX).
2. **Honesty**: fetch-time conversion failures are recorded on the durable job
   server-side (v1 had no durable record at all — its split-brain localStorage queue
   is the defect this architecture removes, per PRINTING-INV-02/ADR-019).
3. **Thin client**: the executor reduces to v1's proven, transport-agnostic chunk
   writer (`BluetoothStrategy.printJob(bytes)`), the piece of v1 with the least churn.
4. The wrap itself (`escpos.ts`) is pure and portable — the cost of centralizing it is
   one ported file; the benefit is a single conversion point with one failure surface.

## Consequences

- The job payload transported over HTTP is the final ESC/POS byte stream (~360 KB
  worst case at 3-5 jobs/day — negligible).
- The final artifact never exists client-side before transmission; client-side
  golden-file assertions are not possible (accepted — the server-side ones replace
  them).
- **Artifact ownership is NOT moved**: per ADR-041/PRINTING-INV-03 the producer
  keeps the raster; Printing fetches the CURRENT artifact via the producer's
  registered server-side interface at execute time (fetch-at-execute preserved).
  This ADR relocates only the CONVERSION (decode + ESC/POS wrap) — both now run in
  Printing, server-side, on the freshly fetched raster. Any producer-side format
  (PNG from pressedslip) is decoded by that producer's own registered provider.
- ADR-041's open decision is closed WITHOUT superseding its ownership split;
  ADR-035's placement model is unchanged (the executor remains the UI-bound
  capability holder; only the artifact's byte-form conversion moved server-side).
