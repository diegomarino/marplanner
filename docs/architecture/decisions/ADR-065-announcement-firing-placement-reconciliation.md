# ADR-065 Browser-Local Announcement Placement

Status: accepted
Owner: architecture
Decision date: 2026-09-03

## Context

Announcements need browser audio. Their duplicate cost is small enough that a
durable server queue, capability registration and device-wide coordination are
disproportionate. Printing has a different failure cost and keeps those mechanisms.

## Decision

- Time Announcements evaluates and fires locally in each connected browser
  (ADR-051). The server stores rules and provides CRUD; it never fires speech.
- Tabs elect one speaker within their browser. Multiple devices may speak the
  same minute. A missed slot is skipped, with no server backlog or replay.
- Announcement timing uses household timezone/language settings and the kiosk
  shell. It depends on neither Day Periods nor the background-jobs scheduler.
- Speech capability is implicit; an unavailable speech API fails silently under
  the announcement contract. No server capability registration or staleness sweep
  exists for announcements.
- Printing alone uses ADR-035's capability registration, atomic claims and queues:
  one claimant per active lease, with possible resend after a lost acknowledgement.
- The kiosk contract and feature FR-014 state both models directly under the
  existing KIOSK-SHELL-NAVIGATION-AC-07 ID. Announcements continue on admin routes.

## Acceptance Criteria

- No server job, queue row, claim or staleness sweep exists for announcements.
- Two devices may speak the same slot; two tabs in a browser elect one speaker.
- A browser reconnecting after a missed slot does not replay old announcements.
- Announcement services remain mounted on connected admin routes.
- The manifest declares household settings and kiosk-shell dependencies, without
  Day Periods or the background-jobs scheduler.

## Related Decisions

ADR-035 (persistent Printing placement), ADR-051 (announcement firing and surface),
ADR-029/039 (plugin lifecycle), ADR-005/015/020/028 (household settings).
