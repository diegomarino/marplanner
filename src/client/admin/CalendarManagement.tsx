import { cn } from "@/lib/utils";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ExternalSourceProvider, ExternalSourcePublic, HighlightRule } from "../../shared";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useT } from "@/i18n";
import { authFetch } from "@/lib/credential";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorNotice } from "@/components/ErrorNotice";
import { ExternalSourceCard } from "@/calendar/admin/ExternalSourceCard";
import { HighlightRuleCard } from "@/calendar/admin/HighlightRuleCard";
import { reorderRules } from "@/calendar/admin/reorder";

const SOURCES_URL = "/api/calendar/external-sources";
const RULES_URL = "/api/calendar/highlight-rules";
const ACTIVE_PHASES = new Set(["requesting", "downloading", "parsing", "reconciling"]);
const POLL_MS = 1000;

export function CalendarManagement() {
  const t = useT();
  const [sources, setSources] = useState<ExternalSourcePublic[]>([]);
  const sourcesRef = useRef<ExternalSourcePublic[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [provider, setProvider] = useState<ExternalSourceProvider>("ics_generic");
  const [rules, setRules] = useState<HighlightRule[]>([]);
  const rulesRef = useRef<HighlightRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rulesError, setRulesError] = useState(false);
  const [ruleActionError, setRuleActionError] = useState<"action" | "reorder" | null>(null);
  const [ruleStatus, setRuleStatus] = useState("");
  const [ruleBusy, setRuleBusy] = useState(false);
  const [ruleEmoji, setRuleEmoji] = useState("⚽");
  const [ruleKeywords, setRuleKeywords] = useState("");
  const ruleEmojiRef = useRef<HTMLInputElement>(null);
  const ruleSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function publishRules(next: HighlightRule[]) {
    const ordered = [...next].sort((a, b) => a.priority - b.priority);
    rulesRef.current = ordered;
    setRules(ordered);
  }

  async function loadRules() {
    try {
      const response = await authFetch(RULES_URL, { credentials: "include" });
      if (!response.ok) throw new Error("rule list failed");
      publishRules((await response.json()) as HighlightRule[]);
      setRulesError(false);
    } catch {
      setRulesError(true);
    } finally {
      setRulesLoading(false);
    }
  }

  useEffect(() => {
    void loadRules();
  }, []);

  const keywords = [
    ...new Set(
      ruleKeywords
        .split(",")
        .map((keyword) => keyword.trim())
        .filter(Boolean)
    ),
  ];

  async function createRule(event: FormEvent) {
    event.preventDefault();
    if (!ruleEmoji.trim() || keywords.length === 0 || ruleBusy) return;
    setRuleBusy(true);
    setRuleActionError(null);
    try {
      const response = await authFetch(RULES_URL, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji: ruleEmoji.trim(), keywords }),
      });
      if (!response.ok) throw new Error("rule create failed");
      publishRules([...rulesRef.current, (await response.json()) as HighlightRule]);
      setRuleKeywords("");
    } catch {
      setRuleActionError("action");
    } finally {
      setRuleBusy(false);
    }
  }

  async function changeRule(id: string, method: "PATCH" | "DELETE", enabled?: boolean) {
    if (ruleBusy) return;
    setRuleBusy(true);
    setRuleActionError(null);
    try {
      const response = await authFetch(`${RULES_URL}/${encodeURIComponent(id)}`, {
        method,
        credentials: "include",
        ...(method === "PATCH"
          ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }
          : {}),
      });
      if (!response.ok) throw new Error("rule action failed");
      if (method === "PATCH") {
        const changed = (await response.json()) as HighlightRule;
        publishRules(rulesRef.current.map((rule) => (rule.id === id ? changed : rule)));
      } else {
        publishRules(rulesRef.current.filter((rule) => rule.id !== id));
        ruleEmojiRef.current?.focus();
      }
    } catch {
      setRuleActionError("action");
    } finally {
      setRuleBusy(false);
    }
  }

  async function onRuleDragEnd(event: DragEndEvent) {
    if (!event.over || ruleBusy) return;
    const next = reorderRules(rulesRef.current, String(event.active.id), String(event.over.id));
    if (!next) return;
    const previous = rulesRef.current;
    const moved = next.find((rule) => rule.id === String(event.active.id))!;
    publishRules(next);
    setRuleStatus(
      t("calendar.admin.movedRule")
        .replace("{emoji}", moved.emoji)
        .replace("{position}", String(next.findIndex((rule) => rule.id === moved.id) + 1))
    );
    setRuleActionError(null);
    setRuleBusy(true);
    try {
      const response = await authFetch(`${RULES_URL}/reorder`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderedIds: next.map((rule) => rule.id) }),
      });
      if (!response.ok) throw new Error("rule reorder failed");
      publishRules((await response.json()) as HighlightRule[]);
    } catch {
      publishRules(previous);
      await loadRules();
      setRuleActionError("reorder");
      setRuleStatus(t("calendar.admin.reorderError"));
    } finally {
      setRuleBusy(false);
    }
  }

  function publish(next: ExternalSourcePublic[]) {
    const previous = sourcesRef.current;
    sourcesRef.current = next;
    setSources(next);
    if (
      next.some(
        (source) =>
          source.phase === "succeeded" &&
          previous.some((old) => old.id === source.id && ACTIVE_PHASES.has(old.phase ?? ""))
      )
    ) {
      // CalendarView loads its own event window on route entry. Refresh the authoritative
      // event query now as well, so completion observes the new Calendar read boundary.
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const from = new Date(now - 29 * day).toISOString();
      const to = new Date(now + 364 * day).toISOString();
      void authFetch(
        `/api/calendar/events?source=all&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { credentials: "include" }
      ).catch(() => undefined);
    }
  }

  async function loadSources() {
    try {
      const response = await authFetch(SOURCES_URL, { credentials: "include" });
      if (!response.ok) throw new Error("source list failed");
      publish((await response.json()) as ExternalSourcePublic[]);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSources();
  }, []);
  const hasActive = sources.some((source) => ACTIVE_PHASES.has(source.phase ?? ""));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => {
      void loadSources();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasActive]);

  async function createSource(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !feedUrl.trim() || busyId) return;
    setBusyId("create");
    setActionError(false);
    try {
      const id = crypto.randomUUID();
      const response = await authFetch(`${SOURCES_URL}/${encodeURIComponent(id)}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          feedUrl: feedUrl.trim(),
          provider,
          pollIntervalMin: 15,
        }),
      });
      if (!response.ok) throw new Error("source create failed");
      const source = (await response.json()) as ExternalSourcePublic;
      publish([...sourcesRef.current.filter((item) => item.id !== source.id), source]);
      setName("");
      setFeedUrl("");
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  }

  async function changeSource(id: string, method: "PATCH" | "POST" | "DELETE", enabled?: boolean) {
    if (busyId) return;
    setBusyId(id);
    setActionError(false);
    try {
      const url = `${SOURCES_URL}/${encodeURIComponent(id)}${method === "POST" ? "/sync" : ""}`;
      const response = await authFetch(url, {
        method,
        credentials: "include",
        ...(method === "PATCH"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ enabled }),
            }
          : {}),
      });
      if (!response.ok) throw new Error("source action failed");
      if (method === "POST") {
        const source = (await response.json()) as ExternalSourcePublic;
        publish(sourcesRef.current.map((item) => (item.id === id ? source : item)));
      } else {
        await loadSources();
      }
    } catch {
      setActionError(true);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-full space-y-6 p-4" data-testid="calendar-management">
      <h1 className="text-2xl font-semibold">{t("calendar.admin.title")}</h1>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2" data-testid="calendar-admin-grid">
        <section aria-labelledby="external-calendars-heading" className="min-w-0 space-y-4">
          <h2 id="external-calendars-heading" className="text-lg font-semibold">
            {t("calendar.admin.externalCalendars")}
          </h2>
          <form
            onSubmit={(event) => void createSource(event)}
            className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm"
          >
            <div className="space-y-1">
              <Label htmlFor="calendar-source-name">{t("calendar.admin.sourceName")}</Label>
              <Input
                id="calendar-source-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="calendar-source-url">{t("calendar.admin.feedUrl")}</Label>
              <Input
                id="calendar-source-url"
                type="url"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="calendar-source-provider">{t("calendar.admin.provider")}</Label>
              <select
                id="calendar-source-provider"
                className={cn(NATIVE_SELECT_CLASSES, "w-full bg-background")}
                value={provider}
                onChange={(event) => setProvider(event.target.value as ExternalSourceProvider)}
              >
                <option value="ics_generic">{t("calendar.admin.providerGeneric")}</option>
                <option value="google">{t("calendar.admin.providerGoogle")}</option>
                <option value="microsoft">{t("calendar.admin.providerMicrosoft")}</option>
                <option value="apple">{t("calendar.admin.providerApple")}</option>
              </select>
            </div>
            <Button type="submit" disabled={!!busyId || !name.trim() || !feedUrl.trim()}>
              {t("calendar.admin.addSource")}
            </Button>
          </form>
          {loading && <p role="status">{t("calendar.admin.loading")}</p>}
          {loadError && <ErrorNotice message={t("calendar.admin.loadError")} />}
          {actionError && <ErrorNotice message={t("calendar.admin.actionError")} />}
          {!loading && !loadError && sources.length === 0 && <p>{t("calendar.admin.empty")}</p>}
          <div className="space-y-2">
            {sources.map((source) => (
              <ExternalSourceCard
                key={source.id}
                source={source}
                busy={busyId === source.id}
                onToggle={(id, enabled) => void changeSource(id, "PATCH", enabled)}
                onSync={(id) => void changeSource(id, "POST")}
                onDelete={(id) => void changeSource(id, "DELETE")}
              />
            ))}
          </div>
        </section>
        <section aria-labelledby="emoji-highlights-heading" className="min-w-0 space-y-4">
          <h2 id="emoji-highlights-heading" className="text-lg font-semibold">
            {t("calendar.admin.emojiHighlights")}
          </h2>
          <form
            onSubmit={(event) => void createRule(event)}
            className="space-y-3 rounded-2xl border bg-card p-4 shadow-sm"
          >
            <div className="space-y-1">
              <Label htmlFor="calendar-rule-emoji">{t("calendar.admin.emoji")}</Label>
              <Input
                ref={ruleEmojiRef}
                id="calendar-rule-emoji"
                value={ruleEmoji}
                onChange={(event) => setRuleEmoji(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="calendar-rule-keywords">{t("calendar.admin.keywords")}</Label>
              <Input
                id="calendar-rule-keywords"
                value={ruleKeywords}
                onChange={(event) => setRuleKeywords(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={ruleBusy || !ruleEmoji.trim() || keywords.length === 0}>
              {t("calendar.admin.addRule")}
            </Button>
          </form>
          {rulesLoading && <p role="status">{t("calendar.admin.loadingRules")}</p>}
          {rulesError && <ErrorNotice message={t("calendar.admin.loadRulesError")} />}
          {ruleActionError && (
            <ErrorNotice
              message={t(
                ruleActionError === "reorder"
                  ? "calendar.admin.reorderError"
                  : "calendar.admin.ruleActionError"
              )}
            />
          )}
          <p role="status" aria-live="polite" className="sr-only">
            {ruleStatus}
          </p>
          <DndContext
            sensors={ruleSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event) => void onRuleDragEnd(event)}
            accessibility={{
              screenReaderInstructions: { draggable: t("calendar.admin.dragInstructions") },
              announcements: {
                onDragStart: ({ active }) =>
                  t("calendar.admin.dragStarted").replace(
                    "{emoji}",
                    rulesRef.current.find((rule) => rule.id === active.id)?.emoji ?? ""
                  ),
                onDragOver: ({ active, over }) =>
                  over
                    ? t("calendar.admin.dragOver")
                        .replace(
                          "{emoji}",
                          rulesRef.current.find((rule) => rule.id === active.id)?.emoji ?? ""
                        )
                        .replace(
                          "{position}",
                          String(rulesRef.current.findIndex((rule) => rule.id === over.id) + 1)
                        )
                    : "",
                onDragEnd: ({ active }) =>
                  t("calendar.admin.dragEnded").replace(
                    "{emoji}",
                    rulesRef.current.find((rule) => rule.id === active.id)?.emoji ?? ""
                  ),
                onDragCancel: () => t("calendar.admin.dragCancelled"),
              },
            }}
          >
            <SortableContext
              items={rules.map((rule) => rule.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-2">
                {rules.map((rule) => (
                  <HighlightRuleCard
                    key={rule.id}
                    rule={rule}
                    busy={ruleBusy}
                    onToggle={(id, enabled) => void changeRule(id, "PATCH", enabled)}
                    onDelete={(id) => void changeRule(id, "DELETE")}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        </section>
      </div>
    </div>
  );
}
