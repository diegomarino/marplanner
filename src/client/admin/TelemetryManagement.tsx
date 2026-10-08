import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import type { ClientLogLevel, ClientLogPage, ClientLogRow } from "../../shared";

/* ------------------------------------------------------------------ */
/* TelemetryManagement — read-only admin diagnostics view. */
/* */
/* Filters + a hard-capped, cursor-paged table over the redacted */
/* client_log store (GET /api/telemetry/client-log). Every row field */
/* is rendered as a plain React text node — `data` is already a JSON */
/* string as stored (server-side JSON.stringify at ingest), so */
/* it is shown VERBATIM as that JSON literal text, never parsed back */
/* into markup or routed through React's raw-HTML render escape hatch. */
/* A hostile row (an active HTML/script payload in `message` or `data`)*/
/* therefore always inert — React escapes every text node it renders. */
/* Row content (level/component/message/data) stays English by design */
/* ("Out of Scope") — only the panel chrome below is localized.*/
/* */
/* (token dialect, FR-009): migrated to the shared L2 */
/* components — AdminPanel for the panel frame, ErrorNotice for */
/* the load-error live region (SC-011), Field for the four filter */
/* controls. The level filter keeps a plain native `<select>` (the */
/* `NATIVE_SELECT_CLASSES` recipe, `src/client/lib/recipes.ts` — see */
/* `docs/development/style-guide.md`): this file's own spec */
/* (`tests/client/telemetry-panel.test.tsx`) drives it with */
/* `fireEvent.change` on the native element directly, which the Radix */
/* `ui/select.tsx` primitive (a button-based trigger, not a real */
/* `<select>`) cannot satisfy — the same external-dependency */
/* constraint the recipe's own doc names for `tests/e2e/meals.spec.ts`,*/
/* reproduced here by a different test. No `ConfirmDialog`/ */
/* `WeekdayPicker`/`StatusToggle`/`CheckboxField`/`RadioField` adoption */
/* applies — this surface has no destructive action, weekday list, */
/* toggle, checkbox or radio control. */
/* ------------------------------------------------------------------ */

interface Filters {
  level: ClientLogLevel | "";
  component: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { level: "", component: "", from: "", to: "" };

export function TelemetryManagement() {
  const t = useT();

  // Draft filter inputs — live as the admin types/selects, NOT yet applied to any fetch.
  const [level, setLevel] = useState<ClientLogLevel | "">("");
  const [component, setComponent] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // fix: the filter snapshot that actually drives fetches. `buildParams` (via
  // `loadMore`) reads ONLY this snapshot, never the live draft state above — so editing a filter
  // WITHOUT clicking "Apply filters" can never change what a subsequent "Load more" continues
  // paginating; the two queries can no longer blend into one table.
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);

  const [rows, setRows] = useState<ClientLogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // fix: a monotonic request-generation counter. Every `load` call captures
  // its own sequence number BEFORE issuing the fetch; a response is only allowed to write state
  // (rows/nextCursor/error/loading flags) if its sequence is STILL the latest one issued when the
  // response arrives. An overlapping, now-superseded response — in EITHER direction: an in-flight
  // Apply superseded by a newer Apply, or a Load-more racing a fresh Apply — is silently
  // discarded instead of clobbering fresher state.
  const requestSeqRef = useRef(0);

  // Initial load only — filter changes are applied explicitly via the "Apply filters" button (a
  // fetch per keystroke would be both noisy and hard to reason about for callers).
  useEffect(() => {
    void load(EMPTY_FILTERS, undefined);
  }, []);

  function buildParams(filters: Filters, cursor?: string): URLSearchParams {
    const params = new URLSearchParams();
    if (filters.level) params.set("level", filters.level);
    if (filters.component.trim()) params.set("component", filters.component.trim());
    if (filters.from.trim()) params.set("from", filters.from.trim());
    if (filters.to.trim()) params.set("to", filters.to.trim());
    if (cursor) params.set("cursor", cursor);
    return params;
  }

  async function load(filters: Filters, cursor: string | undefined) {
    const mySeq = ++requestSeqRef.current;
    const isFirstPage = cursor === undefined;
    if (isFirstPage) {
      setLoading(true);
      // Invalidate pagination up front, not just on success: without this, a FAILED first-page
      // request (e.g. Apply hitting a 500) leaves the OLD cursor alive, so a subsequent Load more
      // would send the NEW (just-applied) filters together with the OLD (pre-Apply) cursor — a
      // cross-generation filter+cursor blend from the error path.
      setNextCursor(null);
    } else {
      setLoadingMore(true);
    }
    setError(null);

    try {
      const qs = buildParams(filters, cursor).toString();
      const response = await authFetch(`/api/telemetry/client-log${qs ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("telemetry.management.loadError"))
        );
      }

      const page = (await response.json()) as ClientLogPage;
      if (mySeq !== requestSeqRef.current) return; // superseded by a newer request — discard

      setRows((previous) => (isFirstPage ? page.rows : [...previous, ...page.rows]));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (mySeq !== requestSeqRef.current) return; // superseded by a newer request — discard
      setError(
        cause instanceof LocalizedApiError ? cause.message : t("telemetry.management.loadError")
      );
    } finally {
      // Only the still-current (latest) request gets to clear the in-flight flags — a stale
      // request settling after a newer one started must not touch them (the newer request's own
      // completion is what clears them).
      if (mySeq === requestSeqRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }

  function applyFilters() {
    const snapshot: Filters = { level, component, from, to };
    setAppliedFilters(snapshot);
    void load(snapshot, undefined);
  }

  function showSubscriberFailures() {
    const filters: Filters = { ...EMPTY_FILTERS, level: "error", component: "event-bus" };
    setLevel(filters.level);
    setComponent(filters.component);
    setFrom("");
    setTo("");
    setAppliedFilters(filters);
    void load(filters, undefined);
  }

  function loadMore() {
    if (!nextCursor) return;
    void load(appliedFilters, nextCursor);
  }

  // Disable BOTH actions while EITHER a first-page or a load-more request is in flight —
  // an independent per-button flag let an Apply and a Load-more overlap.
  const busy = loading || loadingMore;

  return (
    <AdminPanel
      title={t("telemetry.management.title")}
      description={t("telemetry.management.description")}
      data-testid="telemetry-management"
    >
      <ErrorNotice message={error} />

      <div className="bg-card flex flex-wrap items-end gap-3 rounded-lg p-4 shadow">
        <Field label={t("telemetry.management.levelLabel")}>
          <select
            value={level}
            data-testid="telemetry-filter-level"
            onChange={(event) => setLevel(event.target.value as ClientLogLevel | "")}
            className={NATIVE_SELECT_CLASSES}
          >
            <option value="">{t("telemetry.management.levelAll")}</option>
            <option value="debug">{t("telemetry.management.levelDebug")}</option>
            <option value="info">{t("telemetry.management.levelInfo")}</option>
            <option value="warn">{t("telemetry.management.levelWarn")}</option>
            <option value="error">{t("telemetry.management.levelError")}</option>
          </select>
        </Field>
        <Field label={t("telemetry.management.componentLabel")}>
          <Input
            type="text"
            value={component}
            data-testid="telemetry-filter-component"
            placeholder={t("telemetry.management.componentPlaceholder")}
            onChange={(event) => setComponent(event.target.value)}
          />
        </Field>
        <Field label={t("telemetry.management.fromLabel")}>
          <Input
            type="number"
            value={from}
            data-testid="telemetry-filter-from"
            onChange={(event) => setFrom(event.target.value)}
          />
        </Field>
        <Field label={t("telemetry.management.toLabel")}>
          <Input
            type="number"
            value={to}
            data-testid="telemetry-filter-to"
            onChange={(event) => setTo(event.target.value)}
          />
        </Field>
        <Button
          type="button"
          data-testid="telemetry-apply-filters"
          disabled={busy}
          onClick={applyFilters}
        >
          {t("telemetry.management.applyFilters")}
        </Button>
      </div>

      <Button type="button" disabled={busy} onClick={showSubscriberFailures}>
        {t("telemetry.management.subscriberFailures")}
      </Button>

      {loading ? (
        <p className="text-muted-foreground">{t("telemetry.management.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground" data-testid="telemetry-empty">
          {t("telemetry.management.noRows")}
        </p>
      ) : (
        <div className="bg-card overflow-x-auto rounded-lg shadow">
          <table className="w-full text-control" data-testid="telemetry-table">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">{t("telemetry.management.columnReceivedAt")}</th>
                <th className="p-2">{t("telemetry.management.columnLevel")}</th>
                <th className="p-2">{t("telemetry.management.columnComponent")}</th>
                <th className="p-2">{t("telemetry.management.columnMessage")}</th>
                <th className="p-2">{t("telemetry.management.columnData")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b" data-testid={`telemetry-row-${row.id}`}>
                  <td className="p-2 align-top">{row.receivedAt}</td>
                  <td className="p-2 align-top">{row.level}</td>
                  <td className="p-2 align-top">{row.component}</td>
                  <td className="p-2 align-top" data-testid={`telemetry-row-message-${row.id}`}>
                    {row.message}
                  </td>
                  <td className="p-2 align-top" data-testid={`telemetry-row-data-${row.id}`}>
                    {row.data ?? t("telemetry.management.noData")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {nextCursor && (
        <Button
          type="button"
          className="mt-4"
          data-testid="telemetry-load-more"
          disabled={busy}
          onClick={loadMore}
        >
          {loadingMore ? t("telemetry.management.loadingMore") : t("telemetry.management.loadMore")}
        </Button>
      )}
    </AdminPanel>
  );
}
