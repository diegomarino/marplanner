import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { todayInHouseholdTimezone } from "@/lib/household-date";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import { CANONICAL_WEEKDAY_ORDER, type WeekdayCode } from "@/components/WeekdayPicker";
import { BlockMatrix } from "@/daily-briefing/admin/BlockMatrix";
import { BriefingMemberBar } from "@/daily-briefing/admin/BriefingMemberBar";
import { BriefingWorkspace } from "@/daily-briefing/admin/BriefingWorkspace";
import {
  BriefingScheduleTab,
  type BriefingTab,
  type ScheduleResults,
} from "@/daily-briefing/admin/BriefingScheduleTab";
import type { AutomationSettings } from "@/daily-briefing/admin/BriefingAutomationCard";
import {
  cellToggleInput,
  rowToggleInput,
  reorderBlockOrderByType,
  resolveMemberBlockSettings,
  weekdayOfDate,
  type BlockOrderInstance,
  type BlockParams,
  type BlockRegistryType,
  type DailyBriefingSettingsView,
  type MemberBlockSettings,
  type MemberResult,
} from "@/daily-briefing/admin/briefingBlocks";
import type {
  BriefingReadResult,
  BriefingSchedule,
  GenerateAllResponse,
  MemberDTO,
  OptInState,
} from "../../shared";

/* DailyBriefingManagement — the Briefing admin page (spec 2026-10-15-admin-briefing-polish).
 * Three scoped tabs: Schedule (household: automatic generation, generate for a date, who gets
 * it), Blocks (member: blocks × weekdays and the pause row) and Briefings (member + date:
 * history, regenerate, view, print). The member and the date are page state shared by the tabs.
 * Opt-in lives only in the Schedule members table; an opted-out member is gated on the member
 * tabs. Settings writes never regenerate (FR-025); none of the handlers below call /generate
 * except the explicit Generate actions. No destructive action exists, so no ConfirmDialog. */

type SettingsData = {
  automation: AutomationSettings;
  blockOrder: BlockOrderInstance[];
  blockSettings: MemberBlockSettings[];
  schedules: Record<string, WeekdayCode[]>;
};

const TAB_LABEL_KEYS = {
  schedule: "dailyBriefing.admin.tabSchedule",
  blocks: "dailyBriefing.admin.tabBlocks",
  preview: "dailyBriefing.admin.tabBriefings",
} as const;

export function DailyBriefingManagement() {
  const t = useT();
  const { timezone } = useHouseholdSettings();
  const today = timezone ? todayInHouseholdTimezone(timezone) : null;

  const [tab, setTab] = useState<BriefingTab>("schedule");
  const [members, setMembers] = useState<MemberDTO[]>([]);
  const [optIns, setOptIns] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [membersLoadFailed, setMembersLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingOptIns, setPendingOptIns] = useState<Set<string>>(() => new Set());

  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsLoadError, setSettingsLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState("");
  const [date, setDate] = useState<string | null>(null);

  const [generatingAll, setGeneratingAll] = useState(false);
  const [generateAllInfo, setGenerateAllInfo] = useState<string | null>(null);
  const [results, setResults] = useState<ScheduleResults | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const generationRequestId = useRef(0);
  const resultsVersion = useRef(0);

  const [blocksError, setBlocksError] = useState<string | null>(null);
  // Every row with a write in flight stays locked: a second click on it would build its body from
  // the stored row before the first write lands, and undo that write.
  const [savingTypes, setSavingTypes] = useState<ReadonlySet<BlockRegistryType>>(() => new Set());
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [orderSaving, setOrderSaving] = useState(false);
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);

  useEffect(() => {
    void loadMembers();
    void loadSettings();
  }, []);

  async function loadMembers() {
    setLoading(true);
    setError(null);
    setMembersLoadFailed(false);
    try {
      const [membersResponse, optInsResponse] = await Promise.all([
        authFetch("/api/members", { credentials: "include" }),
        authFetch("/api/daily-briefing/opt-in", { credentials: "include" }),
      ]);
      if (!membersResponse.ok || !optInsResponse.ok) throw new Error("load members failed");
      const all = (await membersResponse.json()) as MemberDTO[];
      const states = (await optInsResponse.json()) as OptInState[];
      const active = all.filter((member) => member.lifecycle === "active");
      const nextOptIns = Object.fromEntries(states.map((s) => [s.memberId, s.enabled]));
      setMembers(active);
      setOptIns(nextOptIns);
      setSelectedId((current) => current || active.find((m) => nextOptIns[m.id])?.id || "");
    } catch {
      setError(t("dailyBriefing.management.loadError"));
      setMembersLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  async function loadSettings() {
    setSettingsLoading(true);
    setSettingsLoadError(null);
    try {
      const response = await authFetch("/api/daily-briefing/settings", { credentials: "include" });
      if (!response.ok) throw new Error("load settings failed");
      // Defensive on shape (admin-gate-panel-reset.test.tsx feeds every panel a generic 200).
      const data = (await response.json()) as Partial<DailyBriefingSettingsView>;
      setSettings({
        automation: {
          generationTime: typeof data.generationTime === "string" ? data.generationTime : "06:00",
          autoPrintBound: data.autoPrintTrigger === "morning_complete",
        },
        blockOrder: Array.isArray(data.blockOrder) ? data.blockOrder : [],
        blockSettings: Array.isArray(data.memberBlockSettings) ? data.memberBlockSettings : [],
        schedules: Object.fromEntries(
          (Array.isArray(data.memberSchedules) ? data.memberSchedules : []).map(
            (s: BriefingSchedule) => [s.memberId, s.weekdays]
          )
        ),
      });
    } catch {
      setSettings(null);
      setSettingsLoadError(t("dailyBriefing.admin.settingsLoadError"));
    } finally {
      setSettingsLoading(false);
    }
  }

  async function setOptIn(memberId: string, enabled: boolean) {
    setPendingOptIns((previous) => new Set(previous).add(memberId));
    setError(null);
    setGenerateAllInfo(null);
    try {
      const response = await authFetch(`/api/daily-briefing/opt-in/${memberId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.optInError"))
        );
      }
      const state = (await response.json()) as OptInState;
      generationRequestId.current += 1;
      setOptIns((previous) => ({ ...previous, [state.memberId]: state.enabled }));
      if (!state.enabled) {
        setResults((previous) => {
          if (!previous || previous.statuses[state.memberId] === undefined) return previous;
          const statuses = { ...previous.statuses };
          delete statuses[state.memberId];
          return { ...previous, statuses };
        });
      }
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.management.optInError")
      );
    } finally {
      setPendingOptIns((previous) => {
        const next = new Set(previous);
        next.delete(memberId);
        return next;
      });
    }
  }

  const optedIn = members.filter((member) => optIns[member.id]);
  const hasPendingOptIns = pendingOptIns.size > 0;
  const shownDate = date ?? today;
  const shownDateRef = useRef(shownDate);
  shownDateRef.current = shownDate;
  const optedInKey = optedIn.map((member) => member.id).join(",");

  // Schedule's Result column starts from what is stored for the shown date, so a briefing made
  // earlier (or by the scheduler) is not reported as missing. Reloaded whenever Schedule is
  // shown; a generate that lands meanwhile wins (resultsVersion).
  useEffect(() => {
    if (tab !== "schedule" || !shownDate) return;
    // Bump first so a read still in flight from before can never land afterwards.
    const version = ++resultsVersion.current;
    if (optedIn.length === 0) {
      setResults({ date: shownDate, statuses: {} });
      return;
    }
    // Without the briefing days (settings not loaded) "Paused" vs "Not generated" is unknown.
    const schedules = settings?.schedules ?? null;
    const weekday = weekdayOfDate(shownDate);
    void Promise.all(
      optedIn.map(async (member): Promise<[string, MemberResult] | null> => {
        try {
          const response = await authFetch(`/api/daily-briefing/${member.id}/${shownDate}`, {
            credentials: "include",
          });
          if (!response.ok) return null;
          const read = (await response.json()) as BriefingReadResult;
          if (read.generated) return [member.id, read.briefing.status];
          if (!schedules) return null;
          const days = schedules[member.id] ?? CANONICAL_WEEKDAY_ORDER;
          return [member.id, weekday && !days.includes(weekday) ? "paused" : "notGenerated"];
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (resultsVersion.current !== version) return;
      setResults({
        date: shownDate,
        statuses: Object.fromEntries(entries.filter((entry) => entry !== null)),
      });
    });
  }, [tab, shownDate, optedInKey, settings?.schedules]);
  const selected = members.find((member) => member.id === selectedId);
  const selectedOn = Boolean(selected && optIns[selected.id]);

  async function generateAll() {
    if (hasPendingOptIns || optedIn.length === 0) return;
    const requestId = ++generationRequestId.current;
    const target = date ?? today;
    setGeneratingAll(true);
    setError(null);
    setGenerateAllInfo(null);
    try {
      const response = await authFetch("/api/daily-briefing/generate-all", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        // Midnight-safe (spec D7): today is resolved by the server.
        body: JSON.stringify(date && date !== today ? { date } : {}),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.generateAllError"))
        );
      }
      const result = (await response.json()) as GenerateAllResponse;
      if (generationRequestId.current !== requestId) return;
      if (result.status === "already_running") {
        setGenerateAllInfo(t("dailyBriefing.management.generateAllAlreadyRunning"));
        return;
      }
      const statuses: Record<string, MemberResult> = Object.fromEntries(
        result.generated.map(({ memberId, status }) => [memberId, status])
      );
      const weekday = target ? weekdayOfDate(target) : null;
      for (const member of optedIn) {
        if (statuses[member.id] !== undefined || !settings) continue;
        const days = settings.schedules[member.id] ?? CANONICAL_WEEKDAY_ORDER;
        statuses[member.id] = weekday && !days.includes(weekday) ? "paused" : "notGenerated";
      }
      // If the parent moved to another date meanwhile, that date's stored results stand.
      if (target === shownDateRef.current) {
        resultsVersion.current += 1;
        setResults({ date: target, statuses });
      }
      setRefreshKey((value) => value + 1);
    } catch (cause) {
      if (generationRequestId.current === requestId) {
        setError(
          cause instanceof LocalizedApiError
            ? cause.message
            : t("dailyBriefing.management.generateAllError")
        );
      }
    } finally {
      setGeneratingAll(false);
    }
  }

  async function putJson(url: string, body: unknown, fallback: string): Promise<unknown> {
    const response = await authFetch(url, {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new LocalizedApiError(await responseMessage(response, fallback));
    return response.json();
  }

  function blockWriteFailed(cause: unknown, fallback: string) {
    setBlocksError(cause instanceof LocalizedApiError ? cause.message : fallback);
  }

  async function saveBlock(
    type: BlockRegistryType,
    input: { enabled?: boolean; weekdays?: WeekdayCode[] | null; params?: BlockParams }
  ) {
    if (!settings || !selected) return;
    setSavingTypes((previous) => new Set(previous).add(type));
    setBlocksError(null);
    const fallback = t("dailyBriefing.admin.blockSettingsSaveError");
    try {
      const updated = (await putJson(
        `/api/daily-briefing/block-settings/${selected.id}/${type}`,
        input,
        fallback
      )) as MemberBlockSettings;
      setSettings(
        (previous) =>
          previous && {
            ...previous,
            blockSettings: [
              ...previous.blockSettings.filter(
                (row) => !(row.memberId === updated.memberId && row.blockType === updated.blockType)
              ),
              updated,
            ],
          }
      );
      setSettingsChanged(true);
    } catch (cause) {
      blockWriteFailed(cause, fallback);
    } finally {
      setSavingTypes((previous) => {
        const next = new Set(previous);
        next.delete(type);
        return next;
      });
    }
  }

  async function toggleDay(day: WeekdayCode) {
    if (!settings || !selected) return;
    const current = new Set(settings.schedules[selected.id] ?? CANONICAL_WEEKDAY_ORDER);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    const weekdays = CANONICAL_WEEKDAY_ORDER.filter((d) => current.has(d));
    setScheduleSaving(true);
    setBlocksError(null);
    const fallback = t("dailyBriefing.admin.scheduleSaveError");
    try {
      const saved = (await putJson(
        `/api/daily-briefing/schedule/${selected.id}`,
        { weekdays },
        fallback
      )) as BriefingSchedule;
      setSettings(
        (previous) =>
          previous && {
            ...previous,
            schedules: { ...previous.schedules, [saved.memberId]: saved.weekdays },
          }
      );
      // A pause only stops future briefings; nothing already generated needs a regenerate.
    } catch (cause) {
      blockWriteFailed(cause, fallback);
    } finally {
      setScheduleSaving(false);
    }
  }

  async function reorder(activeType: BlockRegistryType, overType: BlockRegistryType) {
    if (!settings) return;
    const previous = settings.blockOrder;
    const next = reorderBlockOrderByType(previous, activeType, overType);
    if (next === previous) return;
    setSettings((s) => s && { ...s, blockOrder: next });
    setOrderSaving(true);
    setBlocksError(null);
    const fallback = t("dailyBriefing.admin.blockOrderSaveError");
    try {
      // Body is the ordered array itself; a type may repeat (INV-05).
      const data = (await putJson("/api/daily-briefing/block-order", next, fallback)) as {
        blockOrder: BlockOrderInstance[];
      };
      setSettings((s) => s && { ...s, blockOrder: data.blockOrder });
      setSettingsChanged(true);
    } catch (cause) {
      setSettings((s) => s && { ...s, blockOrder: previous });
      blockWriteFailed(cause, fallback);
    } finally {
      setOrderSaving(false);
    }
  }

  function selectMember(memberId: string) {
    setSelectedId(memberId);
    setSettingsChanged(false);
    setBlocksError(null);
  }

  // Only an opted-in member can be selected: if the selected one disappears (archived elsewhere +
  // Retry) or is opted out, fall back to the first opted-in member, or to none.
  useEffect(() => {
    if (loading) return;
    if (selectedId && optIns[selectedId] && members.some((m) => m.id === selectedId)) return;
    const next = members.find((m) => optIns[m.id])?.id ?? "";
    if (next !== selectedId) selectMember(next);
  }, [loading, members, optIns, selectedId]);

  if (loading && members.length === 0 && !membersLoadFailed) {
    return (
      <AdminPanel title={t("admin.sidebar.briefing")} data-testid="daily-briefing-management">
        <p className="text-control text-muted-foreground">
          {t("dailyBriefing.management.loading")}
        </p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("admin.sidebar.briefing")}
      description={t("dailyBriefing.admin.pageDescription")}
      data-testid="daily-briefing-management"
    >
      <div
        role="tablist"
        aria-label={t("admin.sidebar.briefing")}
        className="flex w-fit max-w-full flex-wrap gap-1 rounded-lg border bg-muted p-1"
      >
        {(["schedule", "blocks", "preview"] as const).map((id) => (
          <Button
            key={id}
            type="button"
            role="tab"
            variant={tab === id ? "default" : "ghost"}
            aria-selected={tab === id}
            data-testid={`daily-briefing-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {t(TAB_LABEL_KEYS[id])}
          </Button>
        ))}
      </div>

      <ErrorNotice message={error} />
      {membersLoadFailed && (
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          data-testid="daily-briefing-retry"
          onClick={() => void loadMembers()}
        >
          {t("dailyBriefing.admin.retry")}
        </Button>
      )}
      {!settingsLoading && settingsLoadError && (
        <div className="flex flex-col items-start gap-2">
          <ErrorNotice
            message={settingsLoadError}
            data-testid="daily-briefing-settings-load-error"
          />
          <Button
            type="button"
            variant="outline"
            data-testid="daily-briefing-settings-retry"
            onClick={() => void loadSettings()}
          >
            {t("dailyBriefing.admin.retry")}
          </Button>
        </div>
      )}

      <div hidden={tab !== "schedule"} data-testid="daily-briefing-schedule-workspace">
        <BriefingScheduleTab
          membersLoadFailed={membersLoadFailed}
          members={members}
          optIns={optIns}
          pendingOptInIds={pendingOptIns}
          optInLocked={generatingAll || workspaceBusy}
          onOptInChange={(id, enabled) => void setOptIn(id, enabled)}
          schedules={settings?.schedules ?? null}
          automation={settings?.automation ?? null}
          onAutomationSaved={(automation) => setSettings((s) => s && { ...s, automation })}
          date={date}
          today={today}
          onDateChange={setDate}
          generatingAll={generatingAll}
          canGenerateAll={optedIn.length > 0 && !hasPendingOptIns && !workspaceBusy}
          generateAllInfo={generateAllInfo}
          onGenerateAll={() => void generateAll()}
          results={results}
          onOpen={(memberId, target) => {
            selectMember(memberId);
            setTab(target);
          }}
        />
      </div>

      <div hidden={tab === "schedule"} className="flex flex-col gap-6">
        {members.length === 0 ? (
          !membersLoadFailed && (
            <p className="text-control text-muted-foreground">
              {t("dailyBriefing.management.noActiveMembers")}
            </p>
          )
        ) : (
          <BriefingMemberBar
            members={members}
            optIns={optIns}
            selectedId={selectedId}
            onSelect={selectMember}
            onOpenSchedule={() => setTab("schedule")}
          />
        )}

        {selected && selectedOn && (
          <>
            <div
              hidden={tab !== "blocks"}
              data-testid="daily-briefing-blocks-workspace"
              className="flex flex-col gap-4"
            >
              {settings && (
                <p className="text-sm text-muted-foreground">
                  {t("dailyBriefing.admin.blocksCaption").replaceAll(
                    "{name}",
                    selected.displayName
                  )}
                </p>
              )}
              {settingsChanged && (
                <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-accent px-4 py-3 text-control text-accent-foreground">
                  <p role="status" aria-live="polite" data-testid="daily-briefing-settings-changed">
                    {t("dailyBriefing.admin.settingsChanged")}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="daily-briefing-settings-changed-open"
                    onClick={() => setTab("preview")}
                  >
                    {t("dailyBriefing.admin.openBriefings")}
                  </Button>
                </div>
              )}
              <ErrorNotice message={blocksError} data-testid="daily-briefing-blocks-error" />
              {!settings && settingsLoading && (
                <p className="text-control text-muted-foreground">
                  {t("dailyBriefing.admin.settingsLoading")}
                </p>
              )}
              {settings && (
                <BlockMatrix
                  memberName={selected.displayName}
                  blockOrder={settings.blockOrder}
                  resolve={(type) =>
                    resolveMemberBlockSettings(settings.blockSettings, selected.id, type)
                  }
                  schedule={settings.schedules[selected.id] ?? CANONICAL_WEEKDAY_ORDER}
                  savingTypes={savingTypes}
                  scheduleSaving={scheduleSaving}
                  orderSaving={orderSaving}
                  onToggleCell={(type, day) =>
                    void saveBlock(
                      type,
                      cellToggleInput(
                        resolveMemberBlockSettings(settings.blockSettings, selected.id, type),
                        day
                      )
                    )
                  }
                  onToggleRow={(type) =>
                    void saveBlock(
                      type,
                      rowToggleInput(
                        resolveMemberBlockSettings(settings.blockSettings, selected.id, type)
                      )
                    )
                  }
                  onParamChange={(type, patch) => {
                    const current = resolveMemberBlockSettings(
                      settings.blockSettings,
                      selected.id,
                      type
                    );
                    void saveBlock(type, { params: { ...current.params, ...patch } });
                  }}
                  onToggleDay={(day) => void toggleDay(day)}
                  onReorder={(a, o) => void reorder(a, o)}
                />
              )}
            </div>
            <div hidden={tab !== "preview"} data-testid="daily-briefing-preview-workspace">
              <BriefingWorkspace
                key={selected.id}
                member={selected}
                briefingDays={settings?.schedules[selected.id]}
                date={date}
                today={today}
                onDateChange={setDate}
                active={tab === "preview"}
                blocked={generatingAll || hasPendingOptIns || workspaceBusy}
                refreshKey={refreshKey}
                onBusyChange={setWorkspaceBusy}
                onOpenBlocks={() => setTab("blocks")}
                onGenerated={(briefing) => {
                  // On "today" with no known household today (spec A2), the result belongs to
                  // the shown date, which the Schedule tab keys as null.
                  const resultDate = date === null && today === null ? null : briefing.date;
                  resultsVersion.current += 1;
                  setResults((previous) =>
                    previous && previous.date === resultDate
                      ? {
                          ...previous,
                          statuses: { ...previous.statuses, [briefing.memberId]: briefing.status },
                        }
                      : { date: resultDate, statuses: { [briefing.memberId]: briefing.status } }
                  );
                  setSettingsChanged(false);
                  setGenerateAllInfo(null);
                }}
              />
            </div>
          </>
        )}
      </div>
    </AdminPanel>
  );
}
