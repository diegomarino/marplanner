import { LocalizedApiError, responseMessage } from "@/lib/api-error";
import { useEffect, useRef, useState } from "react";
import { authFetch } from "@/lib/credential";
import { useT } from "@/i18n";
import { AdminPanel } from "@/components/AdminPanel";
import { ErrorNotice } from "@/components/ErrorNotice";
import { CheckboxField } from "@/components/CheckboxField";
import {
  WeekdayPicker,
  CANONICAL_WEEKDAY_ORDER,
  weekdayDisplayOrder,
  type WeekdayCode,
  type WeekdayLabels,
} from "@/components/WeekdayPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { BriefingWorkspace } from "@/daily-briefing/admin/BriefingWorkspace";
import { BriefingMemberPills, pillMembers } from "@/daily-briefing/admin/BriefingMemberPills";
import type {
  BriefingSchedule,
  BriefingStatus,
  GenerateAllResponse,
  MemberDTO,
  OptInState,
} from "../../shared";
import type { MessageKey } from "@/i18n/messages";

/* ------------------------------------------------------------------ */
/* DailyBriefingManagement — manual generation and per-member opt-in. */
/* */
/* The plugin owns opt-in state. The mounted admin surface combines */
/* that persisted list with active Members, while generate-all reports */
/* only the statuses returned by its contract. */
/* */
/* US2: generate-all now shares the scheduler's in-flight */
/* guard with the scheduled/catch-up fire. `already_running` is a */
/* non-error informational outcome — never routed through `error`. */
/* */
/*: settings-layer extensions (FR-022) below the */
/* original opt-in/generate panel. Schedule, block order, and */
/* per-member per-block settings are pure WRITE surfaces — they */
/* never regenerate or invalidate an existing briefing (FR-022's own */
/* guarantee), so none of the new handlers below ever call /generate */
/* or /generate-all. */
/* */
/* (token dialect, FR-005/FR-009): the ORIGINAL */
/* opt-in/generate panel (no longer "kept as-is") and the settings- */
/* layer extensions both migrate to the shared L2 components. */
/* SC-009: the local `CANONICAL_WEEKDAYS` constant this file declared */
/* is GONE — the file imports the shared `CANONICAL_WEEKDAY_ORDER` */
/* and renders through the shared `WeekdayPicker` for the per-member, */
/* per-block weekday overrides — the ONE weekday-rendering site here. */
/* */
/* The Preview / Generate tab delegates to */
/* `daily-briefing/admin/BriefingWorkspace` (admin parity 2026-10-15). */
/* */
/* No destructive confirmation exists anywhere in this surface (no */
/* delete action) — `ConfirmDialog` does not apply. `StatusToggle` */
/* does not apply either — no pressed-state toggle is rendered here. */
/* ------------------------------------------------------------------ */

// ── Settings-layer types (contracts/openapi.yaml `DailyBriefingSettingsView` et al.) ──────────
// Hand-mirrored here (not imported from src/shared) because the settings-layer DTOs are new
// with this module and src/shared/index.ts and src/shared/dailyBriefing.ts are outside this
// task's scope — see docs/api/briefing-render/openapi.yaml for the source of
// truth these types must stay in lockstep with.

// SC-009: ONE canonical weekday definition — the shared picker's own. An earlier revision of
// this migration kept a file-local `CANONICAL_WEEKDAYS` twin: two
// independent definitions means a divergence renders a persisted `weekdays: null` ("all days")
// differently here than in the shared picker.
type Weekday = WeekdayCode;

export const WEEKDAY_LABEL_KEYS: Record<Weekday, MessageKey> = {
  mon: "dailyBriefing.admin.weekday.mon",
  tue: "dailyBriefing.admin.weekday.tue",
  wed: "dailyBriefing.admin.weekday.wed",
  thu: "dailyBriefing.admin.weekday.thu",
  fri: "dailyBriefing.admin.weekday.fri",
  sat: "dailyBriefing.admin.weekday.sat",
  sun: "dailyBriefing.admin.weekday.sun",
};

/** Builds `WeekdayPicker`'s localized label map from this surface's own translation namespace
 * (`dailyBriefing.admin.weekday.*`) — call-site-owned, per the component's own doc comment. */
function weekdayLabels(t: (key: MessageKey) => string): WeekdayLabels {
  return {
    mon: t(WEEKDAY_LABEL_KEYS.mon),
    tue: t(WEEKDAY_LABEL_KEYS.tue),
    wed: t(WEEKDAY_LABEL_KEYS.wed),
    thu: t(WEEKDAY_LABEL_KEYS.thu),
    fri: t(WEEKDAY_LABEL_KEYS.fri),
    sat: t(WEEKDAY_LABEL_KEYS.sat),
    sun: t(WEEKDAY_LABEL_KEYS.sun),
  };
}

type AutoPrintTrigger = "morning_complete" | null;

interface BlockParams {
  level?: "L1" | "L2" | "L3" | "L4";
  difficulty?: string;
  language?: string;
}

interface BlockOrderInstance {
  type: string;
  params?: BlockParams;
}

interface MemberBlockSettings {
  memberId: string;
  blockType: string;
  enabled: boolean;
  weekdays: Weekday[] | null;
  params: BlockParams | null;
  updatedAt: number | null;
}

interface DailyBriefingSettingsView {
  generationTime: string;
  autoPrintTrigger: AutoPrintTrigger;
  blockOrder: BlockOrderInstance[];
  memberBlockSettings: MemberBlockSettings[];
  memberSchedules?: BriefingSchedule[];
}

interface DailyBriefingSettingsSnapshot {
  generationTime: string;
  autoPrintTrigger: AutoPrintTrigger;
  updatedAt: number | null;
}

/** The 21-block registry universe, hand-mirrored from the server's single source of truth
 * (src/server/modules/daily-briefing/corpora/block-types.ts `ALL_BLOCK_TYPES`) — the client
 * cannot import server modules, so this list (and the two below) must be kept in sync by hand
 * if the registry ever changes.
 */
const ALL_BLOCK_TYPES = [
  "shotgun",
  "message",
  "streak",
  "today",
  "weather",
  "meals",
  "birthday",
  "reminders",
  "dadJoke",
  "wordOfDay",
  "animalFact",
  "numberFact",
  "onThisDay",
  "quoteOfDay",
  "trivia",
  "riddle",
  "wouldYouRather",
  "wordSearch",
  "drawingPrompt",
  "streakText",
  "weatherText",
] as const;

type BlockRegistryType = (typeof ALL_BLOCK_TYPES)[number];

export const BLOCK_LABEL_KEYS: Record<BlockRegistryType, MessageKey> = {
  shotgun: "dailyBriefing.admin.blockType.shotgun",
  message: "dailyBriefing.admin.blockType.message",
  streak: "dailyBriefing.admin.blockType.streak",
  today: "dailyBriefing.admin.blockType.today",
  weather: "dailyBriefing.admin.blockType.weather",
  meals: "dailyBriefing.admin.blockType.meals",
  birthday: "dailyBriefing.admin.blockType.birthday",
  reminders: "dailyBriefing.admin.blockType.reminders",
  dadJoke: "dailyBriefing.admin.blockType.dadJoke",
  wordOfDay: "dailyBriefing.admin.blockType.wordOfDay",
  animalFact: "dailyBriefing.admin.blockType.animalFact",
  numberFact: "dailyBriefing.admin.blockType.numberFact",
  onThisDay: "dailyBriefing.admin.blockType.onThisDay",
  quoteOfDay: "dailyBriefing.admin.blockType.quoteOfDay",
  trivia: "dailyBriefing.admin.blockType.trivia",
  riddle: "dailyBriefing.admin.blockType.riddle",
  wouldYouRather: "dailyBriefing.admin.blockType.wouldYouRather",
  wordSearch: "dailyBriefing.admin.blockType.wordSearch",
  drawingPrompt: "dailyBriefing.admin.blockType.drawingPrompt",
  streakText: "dailyBriefing.admin.blockType.streakText",
  weatherText: "dailyBriefing.admin.blockType.weatherText",
};

function effectiveMatrixBlockTypes(blockOrder: BlockOrderInstance[]): BlockRegistryType[] {
  const configured = blockOrder
    .map((entry) => entry.type)
    .filter((type): type is BlockRegistryType =>
      ALL_BLOCK_TYPES.includes(type as BlockRegistryType)
    );
  const configuredTypes = new Set(configured);
  return [
    ...configured.filter((type, index) => configured.indexOf(type) === index),
    ...ALL_BLOCK_TYPES.filter((type) => !configuredTypes.has(type)),
  ];
}

export function reorderBlockOrderByType(
  blockOrder: BlockOrderInstance[],
  activeType: BlockRegistryType,
  overType: BlockRegistryType
): BlockOrderInstance[] {
  const orderedTypes = effectiveMatrixBlockTypes(blockOrder);
  const fromIndex = orderedTypes.indexOf(activeType);
  const toIndex = orderedTypes.indexOf(overType);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return blockOrder;

  const nextTypes = [...orderedTypes];
  const [movedType] = nextTypes.splice(fromIndex, 1);
  nextTypes.splice(toIndex, 0, movedType as BlockRegistryType);

  const instancesByType = new Map<BlockRegistryType, BlockOrderInstance[]>();
  for (const type of ALL_BLOCK_TYPES) {
    const instances = blockOrder.filter((entry) => entry.type === type);
    instancesByType.set(type, instances.length > 0 ? instances : [{ type }]);
  }
  return nextTypes.flatMap((type) => instancesByType.get(type) ?? []);
}

/** Mirrors `DEFAULT_DISABLED_BLOCK_TYPES` in block-types.ts (FR-013). */
const DEFAULT_DISABLED_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set(["onThisDay"]);

/** Mirrors `LEVEL`-taking block types — today, only `wordOfDay` (FR-022). */
const LEVEL_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set(["wordOfDay"]);
const LEVELS = ["L1", "L2", "L3", "L4"] as const;

/** Mirrors `DIFFICULTY`-taking block types — `trivia` and `wordSearch` (FR-022). */
const DIFFICULTY_BLOCK_TYPES: ReadonlySet<BlockRegistryType> = new Set(["trivia", "wordSearch"]);
const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const DIFFICULTY_LABEL_KEYS: Record<(typeof DIFFICULTIES)[number], MessageKey> = {
  easy: "dailyBriefing.admin.difficulty.easy",
  medium: "dailyBriefing.admin.difficulty.medium",
  hard: "dailyBriefing.admin.difficulty.hard",
};

/** Mirrors `CORPUS_LANGUAGE_AVAILABILITY` in block-types.ts (FR-008/FR-009) — the ONLY types
 * offering a `params.language` override, each restricted to the languages with an on-disk
 * corpus. A type absent from this map renders no language control at all (FR-008).
 */
const CORPUS_LANGUAGE_AVAILABILITY: Partial<Record<BlockRegistryType, readonly string[]>> = {
  dadJoke: ["en"],
  wordOfDay: ["en"],
  animalFact: ["en", "es"],
  numberFact: ["en", "es"],
  trivia: ["en"],
  riddle: ["en"],
  wouldYouRather: ["en", "es"],
  wordSearch: ["en"],
  drawingPrompt: ["en", "es"],
};

function defaultMemberBlockSettings(
  memberId: string,
  blockType: BlockRegistryType
): MemberBlockSettings {
  return {
    memberId,
    blockType,
    enabled: !DEFAULT_DISABLED_BLOCK_TYPES.has(blockType),
    weekdays: null,
    params: null,
    updatedAt: null,
  };
}

export function DailyBriefingManagement() {
  const t = useT();
  const { weekStartDay } = useHouseholdSettings();
  const [workspace, setWorkspace] = useState<"blocks" | "preview">("blocks");
  const [activeMembers, setActiveMembers] = useState<MemberDTO[]>([]);
  const [optIns, setOptIns] = useState<Record<string, boolean>>({});
  const [memberStatuses, setMemberStatuses] = useState<Record<string, BriefingStatus>>({});
  const [loading, setLoading] = useState(true);
  const [pendingOptInMemberIds, setPendingOptInMemberIds] = useState<Set<string>>(() => new Set());
  const [generatingAll, setGeneratingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generateAllInfo, setGenerateAllInfo] = useState<string | null>(null);
  const generationRequestId = useRef(0);
  const [membersLoadFailed, setMembersLoadFailed] = useState(false);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [settingsChanged, setSettingsChanged] = useState(false);
  const [memberSchedules, setMemberSchedules] = useState<Record<string, WeekdayCode[]>>({});
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // ── settings-layer state (FR-022) ────────────────────────────────────────────
  const [settingsLoading, setSettingsLoading] = useState(true);
  // P2 (FOLD-B): true ONLY after a successful GET — distinct from
  // `!settingsLoading`, which also goes true on a FAILED load. Every control whose payload
  // derives from the loaded snapshot (schedule/binding, block order, per-member block settings)
  // gates on THIS flag, never on `settingsLoading` alone — otherwise a Save fired while the GET
  // is still pending or failed sends a PUT built from empty/default local state and can erase an
  // already-configured snapshot server-side.
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [generationTime, setGenerationTime] = useState("06:00");
  const [autoPrintBound, setAutoPrintBound] = useState(false);

  const [blockOrder, setBlockOrder] = useState<BlockOrderInstance[]>([]);
  const [blockOrderAddType, setBlockOrderAddType] = useState("");
  const [blockOrderSaving, setBlockOrderSaving] = useState(false);
  const [blockOrderError, setBlockOrderError] = useState<string | null>(null);
  const [draggedBlockType, setDraggedBlockType] = useState<BlockRegistryType | null>(null);

  const [memberBlockSettingsList, setMemberBlockSettingsList] = useState<MemberBlockSettings[]>([]);
  const [blockSettingsMemberId, setBlockSettingsMemberId] = useState("");
  const [blockSettingsSavingKey, setBlockSettingsSavingKey] = useState<string | null>(null);
  const [blockSettingsError, setBlockSettingsError] = useState<string | null>(null);

  useEffect(() => {
    void loadMembers();
  }, []);

  useEffect(() => {
    void loadAdminSettings();
  }, []);

  async function loadAdminSettings() {
    setSettingsLoading(true);
    setSettingsLoaded(false);
    setSettingsError(null);

    try {
      const response = await authFetch("/api/daily-briefing/settings", {
        credentials: "include",
      });
      if (!response.ok) throw new Error("load daily briefing settings failed");

      // Defensive on shape, not just on HTTP status — the house pattern (see
      // admin-gate-panel-reset.test.tsx) exercises every admin panel against a generic,
      // differently-shaped 200 response; a field that isn't the expected type falls back to a
      // safe default instead of crashing the render (`Array.isArray`/`typeof` guards below),
      // matching how every other panel tolerates an unexpected payload shape.
      const data = (await response.json()) as Partial<DailyBriefingSettingsView>;
      setGenerationTime(typeof data.generationTime === "string" ? data.generationTime : "06:00");
      setAutoPrintBound(data.autoPrintTrigger === "morning_complete");
      setBlockOrder(Array.isArray(data.blockOrder) ? data.blockOrder : []);
      setMemberBlockSettingsList(
        Array.isArray(data.memberBlockSettings) ? data.memberBlockSettings : []
      );
      setMemberSchedules(
        Object.fromEntries(
          (Array.isArray(data.memberSchedules) ? data.memberSchedules : []).map(
            (schedule: BriefingSchedule) => [schedule.memberId, schedule.weekdays]
          )
        )
      );
      setSettingsLoaded(true);
    } catch {
      setSettingsError(t("dailyBriefing.admin.settingsLoadError"));
      setSettingsLoaded(false);
    } finally {
      setSettingsLoading(false);
    }
  }

  async function saveSettings() {
    setSettingsSaving(true);
    setSettingsError(null);

    try {
      const input: { generationTime: string; autoPrintTrigger: AutoPrintTrigger } = {
        generationTime,
        // Contract's trigger-binding model (fold): the toggle is worded and sent as
        // a BINDING, never a boolean `autoPrint` flag — bound sends "morning_complete", unbound
        // sends null.
        autoPrintTrigger: autoPrintBound ? "morning_complete" : null,
      };
      const response = await authFetch("/api/daily-briefing/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.settingsSaveError"))
        );
      }

      const snapshot = (await response.json()) as DailyBriefingSettingsSnapshot;
      setGenerationTime(snapshot.generationTime);
      setAutoPrintBound(snapshot.autoPrintTrigger === "morning_complete");
    } catch (cause) {
      setSettingsError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.admin.settingsSaveError")
      );
    } finally {
      setSettingsSaving(false);
    }
  }

  function moveBlockOrder(index: number, direction: -1 | 1) {
    setBlockOrder((previous) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= previous.length) return previous;

      const next = [...previous];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved as BlockOrderInstance);
      return next;
    });
  }

  function removeBlockOrder(index: number) {
    setBlockOrder((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
  }

  function addBlockOrder() {
    if (!blockOrderAddType) return;
    setBlockOrder((previous) => [...previous, { type: blockOrderAddType }]);
    setBlockOrderAddType("");
  }

  async function saveBlockOrder(nextBlockOrder = blockOrder) {
    setBlockOrderSaving(true);
    setBlockOrderError(null);

    try {
      // Body is the ordered array itself (not wrapped) — contracts/openapi.yaml
      // `PUT /api/daily-briefing/block-order`. A type MAY repeat with distinct params
      // (INV-05/ADR-044) — the array is sent verbatim, no dedup.
      const response = await authFetch("/api/daily-briefing/block-order", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nextBlockOrder),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.blockOrderSaveError"))
        );
      }

      const data = (await response.json()) as { blockOrder: BlockOrderInstance[] };
      setBlockOrder(data.blockOrder);
      setSettingsChanged(true);
    } catch (cause) {
      setBlockOrderError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.admin.blockOrderSaveError")
      );
    } finally {
      setBlockOrderSaving(false);
    }
  }

  function resolveMemberBlockSettings(
    memberId: string,
    blockType: BlockRegistryType
  ): MemberBlockSettings {
    return (
      memberBlockSettingsList.find(
        (row) => row.memberId === memberId && row.blockType === blockType
      ) ?? defaultMemberBlockSettings(memberId, blockType)
    );
  }

  async function saveMemberBlockSettings(
    memberId: string,
    blockType: BlockRegistryType,
    input: { enabled?: boolean; weekdays?: Weekday[] | null; params?: BlockParams }
  ) {
    const key = `${memberId}:${blockType}`;
    setBlockSettingsSavingKey(key);
    setBlockSettingsError(null);

    try {
      const response = await authFetch(
        `/api/daily-briefing/block-settings/${memberId}/${blockType}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      );
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.blockSettingsSaveError"))
        );
      }

      const updated = (await response.json()) as MemberBlockSettings;
      setMemberBlockSettingsList((previous) => [
        ...previous.filter(
          (row) => !(row.memberId === updated.memberId && row.blockType === updated.blockType)
        ),
        updated,
      ]);
      setSettingsChanged(true);
    } catch (cause) {
      setBlockSettingsError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.admin.blockSettingsSaveError")
      );
    } finally {
      setBlockSettingsSavingKey((previous) => (previous === key ? null : previous));
    }
  }

  function toggleBlockEnabled(
    memberId: string,
    blockType: BlockRegistryType,
    current: MemberBlockSettings
  ) {
    void saveMemberBlockSettings(memberId, blockType, { enabled: !current.enabled });
  }

  /** Forward the canonical weekday array from WeekdayPicker. A complete array and null both
   * mean every day, but are distinct persisted representations; this control sends arrays.
   */
  function setBlockWeekdays(
    memberId: string,
    blockType: BlockRegistryType,
    next: readonly Weekday[]
  ) {
    void saveMemberBlockSettings(memberId, blockType, { weekdays: [...next] });
  }

  /** An empty-string `patch` value clears that param key (never sends an invalid empty string
   * to the write boundary — `JSON.stringify` drops `undefined`-valued keys entirely). */
  function setBlockParam(
    memberId: string,
    blockType: BlockRegistryType,
    current: MemberBlockSettings,
    patch: Partial<BlockParams>
  ) {
    const nextParams: BlockParams = { ...current.params, ...patch };
    void saveMemberBlockSettings(memberId, blockType, { params: nextParams });
  }

  function commitBlockTypeMove(activeType: BlockRegistryType, overType: BlockRegistryType) {
    const nextBlockOrder = reorderBlockOrderByType(blockOrder, activeType, overType);
    if (nextBlockOrder === blockOrder) return;
    setBlockOrder(nextBlockOrder);
    void saveBlockOrder(nextBlockOrder);
  }

  function moveBlockTypeWithKeyboard(blockType: BlockRegistryType, direction: -1 | 1) {
    const orderedTypes = effectiveMatrixBlockTypes(blockOrder);
    const currentIndex = orderedTypes.indexOf(blockType);
    const targetType = orderedTypes[currentIndex + direction];
    if (targetType) commitBlockTypeMove(blockType, targetType);
  }

  async function loadMembers() {
    setLoading(true);
    setError(null);
    setMembersLoadFailed(false);

    try {
      const [membersResponse, optInsResponse] = await Promise.all([
        authFetch("/api/members", { credentials: "include" }),
        authFetch("/api/daily-briefing/opt-in", { credentials: "include" }),
      ]);
      if (!membersResponse.ok || !optInsResponse.ok)
        throw new Error("load daily briefing members failed");

      const [members, persistedOptIns] = (await Promise.all([
        membersResponse.json() as Promise<MemberDTO[]>,
        optInsResponse.json() as Promise<OptInState[]>,
      ])) as [MemberDTO[], OptInState[]];
      const nextActiveMembers = members.filter((member) => member.lifecycle === "active");
      const nextOptIns = Object.fromEntries(
        persistedOptIns.map((state) => [state.memberId, state.enabled])
      );
      const firstPillMemberId = pillMembers(nextActiveMembers, nextOptIns)[0]?.id ?? "";

      setActiveMembers(nextActiveMembers);
      setOptIns(nextOptIns);
      setBlockSettingsMemberId((current) => current || firstPillMemberId);
    } catch {
      setError(t("dailyBriefing.management.loadError"));
      setMembersLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }

  async function setOptIn(memberId: string, enabled: boolean) {
    setPendingOptInMemberIds((previous) => new Set(previous).add(memberId));
    setError(null);
    // Nit 5: clears a stale already_running note so it
    // never sits next to opt-in state that has since moved on.
    setGenerateAllInfo(null);

    try {
      const input: Pick<OptInState, "enabled"> = { enabled };
      const response = await authFetch(`/api/daily-briefing/opt-in/${memberId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.optInError"))
        );
      }

      const state = (await response.json()) as OptInState;
      generationRequestId.current += 1;
      setOptIns((previous) => ({ ...previous, [state.memberId]: state.enabled }));
      setMemberStatuses((previous) => {
        if (state.enabled || previous[state.memberId] === undefined) return previous;

        const next = { ...previous };
        delete next[state.memberId];
        return next;
      });
    } catch (cause) {
      setError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.management.optInError")
      );
    } finally {
      setPendingOptInMemberIds((previous) => {
        const next = new Set(previous);
        next.delete(memberId);
        return next;
      });
    }
  }

  async function generateAll() {
    if (hasPendingOptInUpdates || optedInMembers.length === 0) return;

    const requestId = ++generationRequestId.current;
    setGeneratingAll(true);
    setError(null);
    setGenerateAllInfo(null);

    try {
      const response = await authFetch("/api/daily-briefing/generate-all", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.management.generateAllError"))
        );
      }

      const result = (await response.json()) as GenerateAllResponse;
      if (generationRequestId.current === requestId) {
        if (result.status === "already_running") {
          setGenerateAllInfo(t("dailyBriefing.management.generateAllAlreadyRunning"));
        } else {
          setMemberStatuses(
            Object.fromEntries(result.generated.map(({ memberId, status }) => [memberId, status]))
          );
        }
      }
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

  const blockMemberSchedule: readonly Weekday[] =
    memberSchedules[blockSettingsMemberId] ?? CANONICAL_WEEKDAY_ORDER;

  async function toggleScheduleDay(day: Weekday) {
    const memberId = blockSettingsMemberId;
    if (!memberId) return;
    const current = new Set(memberSchedules[memberId] ?? CANONICAL_WEEKDAY_ORDER);
    if (current.has(day)) current.delete(day);
    else current.add(day);
    const weekdays = CANONICAL_WEEKDAY_ORDER.filter((d) => current.has(d));
    setScheduleSaving(true);
    setScheduleError(null);
    try {
      const response = await authFetch(`/api/daily-briefing/schedule/${memberId}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weekdays }),
      });
      if (!response.ok) {
        throw new LocalizedApiError(
          await responseMessage(response, t("dailyBriefing.admin.scheduleSaveError"))
        );
      }
      const saved = (await response.json()) as BriefingSchedule;
      setMemberSchedules((previous) => ({ ...previous, [saved.memberId]: saved.weekdays }));
      setSettingsChanged(true);
    } catch (cause) {
      setScheduleError(
        cause instanceof LocalizedApiError
          ? cause.message
          : t("dailyBriefing.admin.scheduleSaveError")
      );
    } finally {
      setScheduleSaving(false);
    }
  }

  function selectBlockMember(memberId: string) {
    setBlockSettingsMemberId(memberId);
    setSettingsChanged(false);
  }

  const optedInMembers = activeMembers.filter((member) => optIns[member.id]);
  const hasPendingOptInUpdates = pendingOptInMemberIds.size > 0;
  const briefingMembers = pillMembers(activeMembers, optIns);
  const briefingMemberIds = briefingMembers.map((member) => member.id).join(",");

  // Keep the Blocks member valid when the pill set changes (opt-in toggled, member archived).
  useEffect(() => {
    if (loading) return;
    const ids = briefingMemberIds ? briefingMemberIds.split(",") : [];
    if (!ids.includes(blockSettingsMemberId)) setBlockSettingsMemberId(ids[0] ?? "");
  }, [loading, briefingMemberIds, blockSettingsMemberId]);

  if (loading) {
    return (
      <AdminPanel title={t("admin.sidebar.briefing")} data-testid="daily-briefing-management">
        <p className="text-muted-foreground text-control">
          {t("dailyBriefing.management.loading")}
        </p>
      </AdminPanel>
    );
  }

  return (
    <AdminPanel
      title={t("admin.sidebar.briefing")}
      description={t("dailyBriefing.management.description")}
      data-testid="daily-briefing-management"
    >
      <div
        role="tablist"
        aria-label={t("admin.sidebar.briefing")}
        className="flex w-fit gap-1 rounded-lg border bg-muted p-1"
      >
        <Button
          type="button"
          role="tab"
          variant={workspace === "blocks" ? "default" : "ghost"}
          aria-selected={workspace === "blocks"}
          data-testid="daily-briefing-tab-blocks"
          onClick={() => setWorkspace("blocks")}
        >
          {t("dailyBriefing.admin.memberBlockSettingsTitle")}
        </Button>
        <Button
          type="button"
          role="tab"
          variant={workspace === "preview" ? "default" : "ghost"}
          aria-selected={workspace === "preview"}
          data-testid="daily-briefing-tab-preview"
          onClick={() => setWorkspace("preview")}
        >
          {t("dailyBriefing.management.generateTitle")}
        </Button>
      </div>

      <ErrorNotice message={error} />
      {membersLoadFailed && (
        <Button
          type="button"
          variant="outline"
          data-testid="daily-briefing-retry"
          onClick={() => void loadMembers()}
        >
          {t("dailyBriefing.admin.retry")}
        </Button>
      )}

      <div
        hidden={workspace !== "preview"}
        data-testid="daily-briefing-preview-workspace"
        className="space-y-6"
      >
        {activeMembers.length === 0 ? (
          <p className="text-muted-foreground text-control">
            {t("dailyBriefing.management.noActiveMembers")}
          </p>
        ) : (
          <>
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h3 className="text-lg font-semibold mb-2">
                {t("dailyBriefing.management.optInTitle")}
              </h3>
              <div className="flex flex-wrap gap-2">
                {activeMembers.map((member) => {
                  const isOptedIn = Boolean(optIns[member.id]);
                  const isUpdating = pendingOptInMemberIds.has(member.id);

                  return (
                    <div
                      key={member.id}
                      className="flex items-center gap-2 rounded-full border bg-background p-1 pr-3 text-control"
                    >
                      <span className="pl-2 font-medium">{member.displayName}</span>
                      <CheckboxField
                        checked={isOptedIn}
                        disabled={isUpdating || generatingAll || workspaceBusy}
                        data-testid={`daily-briefing-opt-in-${member.id}`}
                        onChange={(checked) => void setOptIn(member.id, checked)}
                        label={
                          isUpdating
                            ? t("dailyBriefing.management.optInSaving")
                            : t("dailyBriefing.management.optIn")
                        }
                        // Compose the accessible name from the two VISIBLE texts: with several
                        // members listed, every checkbox otherwise announces the identical
                        // "Enabled" — pre-migration the wrapping <label>
                        // included the member name.
                        aria-label={`${member.displayName}: ${
                          isUpdating
                            ? t("dailyBriefing.management.optInSaving")
                            : t("dailyBriefing.management.optIn")
                        }`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h3 className="text-lg font-semibold mb-2">
                {t("dailyBriefing.management.generateTitle")}
              </h3>
              {optedInMembers.length === 0 ? (
                <p className="text-muted-foreground text-control">
                  {t("dailyBriefing.management.noOptedInMembers")}
                </p>
              ) : (
                <div className="flex gap-3 items-end flex-wrap">
                  <Button
                    type="button"
                    data-testid="daily-briefing-generate-all"
                    disabled={generatingAll || hasPendingOptInUpdates || workspaceBusy}
                    onClick={() => void generateAll()}
                  >
                    {generatingAll
                      ? t("dailyBriefing.management.generatingAll")
                      : t("dailyBriefing.management.generateAll")}
                  </Button>
                </div>
              )}

              {generateAllInfo && (
                <p
                  className="mt-4 text-muted-foreground text-control"
                  data-testid="daily-briefing-generate-all-info"
                  role="status"
                  aria-live="polite"
                >
                  {generateAllInfo}
                </p>
              )}

              {Object.keys(memberStatuses).length > 0 && (
                <div className="mt-4 text-sm" data-testid="daily-briefing-member-statuses">
                  <h4 className="font-semibold">{t("dailyBriefing.management.statusesTitle")}</h4>
                  <ul className="mt-2 space-y-1">
                    {activeMembers
                      .filter((member) => memberStatuses[member.id] !== undefined)
                      .map((member) => (
                        <li
                          key={member.id}
                          data-testid={`daily-briefing-member-status-${member.id}`}
                        >
                          {member.displayName}:{" "}
                          {t(`dailyBriefing.status.${memberStatuses[member.id]}`)}
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>

            <BriefingWorkspace
              members={briefingMembers}
              optIns={optIns}
              active={workspace === "preview"}
              blocked={generatingAll || hasPendingOptInUpdates}
              onBusyChange={setWorkspaceBusy}
              onGenerated={(briefing) => {
                setMemberStatuses((previous) => ({
                  ...previous,
                  [briefing.memberId]: briefing.status,
                }));
                setSettingsChanged(false);
                setGenerateAllInfo(null);
              }}
            />
          </>
        )}
      </div>

      {/* — settings-layer extensions (FR-022). Independent of the
 opt-in/generate panel above: these config surfaces are useful even with zero active
 members, so they render unconditionally rather than nested in the ternary above. */}
      <div
        hidden={workspace !== "blocks"}
        data-testid="daily-briefing-blocks-workspace"
        className="space-y-6"
      >
        {briefingMembers.length === 0 ? (
          <p className="text-muted-foreground text-control">
            {t("dailyBriefing.admin.noPillMembers")}
          </p>
        ) : (
          <BriefingMemberPills
            members={briefingMembers}
            selectedId={blockSettingsMemberId}
            onSelect={selectBlockMember}
            testIdPrefix="daily-briefing-block-member"
            label={t("dailyBriefing.admin.memberBlockSelectMember")}
          />
        )}

        {settingsChanged && (
          <p
            role="status"
            aria-live="polite"
            data-testid="daily-briefing-settings-changed"
            className="rounded-lg border bg-accent px-4 py-3 text-control text-accent-foreground"
          >
            {t("dailyBriefing.admin.settingsChanged")}
          </p>
        )}

        <Card data-testid="daily-briefing-admin-settings">
          <CardHeader>
            <CardTitle>{t("dailyBriefing.admin.settingsTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ErrorNotice
              message={settingsError}
              data-testid="daily-briefing-admin-settings-error"
            />
            {!settingsLoading && !settingsLoaded && (
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                data-testid="daily-briefing-settings-retry"
                onClick={() => void loadAdminSettings()}
              >
                {t("dailyBriefing.admin.retry")}
              </Button>
            )}
            {settingsLoading ? (
              <p className="text-sm text-muted-foreground">
                {t("dailyBriefing.management.loading")}
              </p>
            ) : (
              <div className="flex flex-wrap items-end gap-4">
                <Label className="flex flex-col items-start gap-1">
                  {t("dailyBriefing.admin.generationTimeLabel")}
                  <Input
                    type="time"
                    data-testid="daily-briefing-admin-generation-time"
                    value={generationTime}
                    disabled={settingsSaving}
                    onChange={(event) => setGenerationTime(event.target.value)}
                    className="w-32"
                  />
                </Label>
                <div className="flex items-center gap-2">
                  <CheckboxField
                    data-testid="daily-briefing-admin-trigger-binding"
                    checked={autoPrintBound}
                    disabled={settingsSaving}
                    onChange={(checked) => setAutoPrintBound(checked)}
                    label={t("dailyBriefing.admin.triggerBindingLabel")}
                  />
                  :{" "}
                  <span data-testid="daily-briefing-admin-trigger-binding-state">
                    {autoPrintBound
                      ? t("dailyBriefing.admin.triggerBindingBound")
                      : t("dailyBriefing.admin.triggerBindingUnbound")}
                  </span>
                </div>
                <Button
                  type="button"
                  data-testid="daily-briefing-admin-settings-save"
                  disabled={settingsSaving || !settingsLoaded}
                  onClick={() => void saveSettings()}
                >
                  {settingsSaving
                    ? t("dailyBriefing.admin.settingsSaving")
                    : t("dailyBriefing.admin.settingsSaveButton")}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="daily-briefing-admin-block-order">
          <CardHeader>
            <CardTitle>{t("dailyBriefing.admin.blockOrderTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ErrorNotice
              message={blockOrderError}
              data-testid="daily-briefing-admin-block-order-error"
            />
            {/* P2 (FOLD-B): the load failure — not just the save failure above — is
 surfaced HERE too, next to the controls it disables (Save is gated below). now routed through the shared ErrorNotice (SC-011) — the eslint-disable this
 line used to carry retires with this module's own migration, per the own comment. */}
            {!settingsLoading && !settingsLoaded && (
              <ErrorNotice
                message={settingsError}
                data-testid="daily-briefing-admin-block-order-load-error"
              />
            )}
            {settingsLoaded &&
              (blockOrder.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="daily-briefing-admin-block-order-empty"
                >
                  {t("dailyBriefing.admin.blockOrderEmpty")}
                </p>
              ) : (
                <ul
                  className="flex flex-col gap-2"
                  data-testid="daily-briefing-admin-block-order-list"
                >
                  {blockOrder.map((instance, index) => (
                    <li
                      key={`${instance.type}-${index}`}
                      data-testid={`daily-briefing-admin-block-order-item-${index}`}
                      className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
                    >
                      <span>
                        {t(
                          BLOCK_LABEL_KEYS[instance.type as BlockRegistryType] ??
                            "dailyBriefing.block.failed"
                        )}
                      </span>
                      <span className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid={`daily-briefing-admin-block-order-up-${index}`}
                          disabled={index === 0 || blockOrderSaving}
                          onClick={() => moveBlockOrder(index, -1)}
                        >
                          {t("dailyBriefing.admin.blockOrderMoveUp")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          data-testid={`daily-briefing-admin-block-order-down-${index}`}
                          disabled={index === blockOrder.length - 1 || blockOrderSaving}
                          onClick={() => moveBlockOrder(index, 1)}
                        >
                          {t("dailyBriefing.admin.blockOrderMoveDown")}
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          data-testid={`daily-briefing-admin-block-order-remove-${index}`}
                          disabled={blockOrderSaving}
                          onClick={() => removeBlockOrder(index)}
                        >
                          {t("dailyBriefing.admin.blockOrderRemove")}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              ))}

            <div className="flex flex-wrap items-end gap-3">
              <Label className="flex flex-col items-start gap-1">
                {t("dailyBriefing.admin.blockOrderAddLabel")}
                <select
                  data-testid="daily-briefing-admin-block-order-add-select"
                  value={blockOrderAddType}
                  disabled={blockOrderSaving || !settingsLoaded}
                  onChange={(event) => setBlockOrderAddType(event.target.value)}
                  className={NATIVE_SELECT_CLASSES}
                >
                  <option value="">{t("dailyBriefing.admin.blockOrderAddPlaceholder")}</option>
                  {ALL_BLOCK_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(BLOCK_LABEL_KEYS[type])}
                    </option>
                  ))}
                </select>
              </Label>
              <Button
                type="button"
                variant="outline"
                data-testid="daily-briefing-admin-block-order-add-button"
                disabled={!blockOrderAddType || blockOrderSaving || !settingsLoaded}
                onClick={addBlockOrder}
              >
                {t("dailyBriefing.admin.blockOrderAddButton")}
              </Button>
              <Button
                type="button"
                data-testid="daily-briefing-admin-block-order-save"
                disabled={blockOrderSaving || !settingsLoaded}
                onClick={() => void saveBlockOrder()}
              >
                {t("dailyBriefing.admin.blockOrderSaveButton")}
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="daily-briefing-admin-block-settings">
          <CardHeader>
            <CardTitle>{t("dailyBriefing.admin.memberBlockSettingsTitle")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ErrorNotice
              message={blockSettingsError}
              data-testid="daily-briefing-admin-block-settings-error"
            />
            {/* P2 (FOLD-B): same load-failure class as block order — a per-member row
 rendered from `resolveMemberBlockSettings`'s FR-013 DEFAULTS (never the real
 persisted values) would let a toggle click PUT a value computed from the wrong
 baseline, silently overwriting a real setting. Rows stay hidden below until loaded. now routed through the shared ErrorNotice (SC-011). */}
            {!settingsLoading && !settingsLoaded && (
              <ErrorNotice
                message={settingsError}
                data-testid="daily-briefing-admin-block-settings-load-error"
              />
            )}

            <Label className="sr-only">
              {t("dailyBriefing.admin.memberBlockSelectMember")}
              <select
                data-testid="daily-briefing-admin-block-settings-member-select"
                value={blockSettingsMemberId}
                onChange={(event) => selectBlockMember(event.target.value)}
                className={NATIVE_SELECT_CLASSES}
              >
                <option value="">
                  {t("dailyBriefing.admin.memberBlockSelectMemberPlaceholder")}
                </option>
                {briefingMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.displayName}
                  </option>
                ))}
              </select>
            </Label>

            {blockSettingsMemberId && settingsLoaded && (
              <p className="text-sm text-muted-foreground">
                {t("dailyBriefing.admin.scheduleCaption")}
              </p>
            )}
            <ErrorNotice message={scheduleError} data-testid="daily-briefing-schedule-error" />

            {blockSettingsMemberId && settingsLoaded && (
              <div className="overflow-x-auto rounded-lg border">
                <table
                  className="w-full min-w-[900px] border-collapse text-sm"
                  data-testid="daily-briefing-block-matrix"
                >
                  <thead>
                    <tr className="bg-muted">
                      <th className="w-64 border-b px-3 py-2 text-left">
                        {t("dailyBriefing.admin.memberBlockSettingsTitle")}
                      </th>
                      {weekdayDisplayOrder(weekStartDay).map((day) => (
                        <th
                          key={day}
                          className="border-b px-2 py-2 text-center font-medium"
                          data-testid={`daily-briefing-block-weekday-heading-${day}`}
                        >
                          <div className="flex flex-col items-center gap-1">
                            {weekdayLabels(t)[day]}
                            <CheckboxField
                              data-testid={`daily-briefing-schedule-day-${day}`}
                              checked={blockMemberSchedule.includes(day)}
                              disabled={scheduleSaving || !settingsLoaded}
                              onChange={() => void toggleScheduleDay(day)}
                              label={t("dailyBriefing.admin.scheduleDayLabel")}
                              aria-label={`${weekdayLabels(t)[day]}: ${t("dailyBriefing.admin.scheduleDayLabel")}`}
                              className="justify-center"
                            />
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody data-testid="daily-briefing-admin-block-settings-list">
                    {effectiveMatrixBlockTypes(blockOrder).map((blockType, index) => {
                      const current = resolveMemberBlockSettings(blockSettingsMemberId, blockType);
                      const activeDays = new Set<Weekday>(
                        current.weekdays ?? CANONICAL_WEEKDAY_ORDER
                      );
                      const saving =
                        blockSettingsSavingKey === `${blockSettingsMemberId}:${blockType}`;
                      const languages = CORPUS_LANGUAGE_AVAILABILITY[blockType];

                      return (
                        <tr
                          key={blockType}
                          data-testid={`daily-briefing-admin-block-settings-row-${blockType}`}
                          onDragOver={(event) => {
                            if (draggedBlockType && draggedBlockType !== blockType) {
                              event.preventDefault();
                            }
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            const activeType =
                              (event.dataTransfer.getData("text/plain") as BlockRegistryType) ||
                              draggedBlockType;
                            setDraggedBlockType(null);
                            if (activeType) commitBlockTypeMove(activeType, blockType);
                          }}
                          className={`${index % 2 === 0 ? "bg-card" : "bg-muted/30"} ${
                            draggedBlockType === blockType ? "opacity-50" : ""
                          }`}
                        >
                          <td className="border-b p-3 align-top">
                            <div className="flex flex-col gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  draggable={!blockOrderSaving}
                                  disabled={blockOrderSaving}
                                  aria-label={`${t("dailyBriefing.admin.blockOrderTitle")}: ${t(BLOCK_LABEL_KEYS[blockType])}`}
                                  data-testid={`daily-briefing-admin-block-drag-${blockType}`}
                                  onDragStart={(event) => {
                                    setDraggedBlockType(blockType);
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData("text/plain", blockType);
                                  }}
                                  onDragEnd={() => setDraggedBlockType(null)}
                                  onKeyDown={(event) => {
                                    if (event.key === "ArrowUp") {
                                      event.preventDefault();
                                      moveBlockTypeWithKeyboard(blockType, -1);
                                    } else if (event.key === "ArrowDown") {
                                      event.preventDefault();
                                      moveBlockTypeWithKeyboard(blockType, 1);
                                    }
                                  }}
                                  className="cursor-grab touch-none select-none active:cursor-grabbing"
                                >
                                  <span aria-hidden="true">⠿</span>
                                </Button>
                                <span className="font-medium">
                                  {t(BLOCK_LABEL_KEYS[blockType])}
                                </span>
                                <CheckboxField
                                  data-testid={`daily-briefing-admin-block-enabled-${blockType}`}
                                  checked={current.enabled}
                                  disabled={saving}
                                  onChange={() =>
                                    toggleBlockEnabled(blockSettingsMemberId, blockType, current)
                                  }
                                  label={t("dailyBriefing.admin.blockEnabledLabel")}
                                />
                              </div>
                              {DEFAULT_DISABLED_BLOCK_TYPES.has(blockType) && (
                                <span
                                  className="text-xs text-muted-foreground"
                                  data-testid={`daily-briefing-admin-block-default-disabled-${blockType}`}
                                >
                                  {t("dailyBriefing.admin.onThisDayDefaultDisabledNote")}
                                </span>
                              )}
                              {LEVEL_BLOCK_TYPES.has(blockType) && (
                                <Label className="flex items-center gap-2 text-xs">
                                  {t("dailyBriefing.admin.blockLevelLabel")}
                                  <select
                                    data-testid={`daily-briefing-admin-block-level-${blockType}`}
                                    value={current.params?.level ?? ""}
                                    disabled={saving}
                                    onChange={(event) => {
                                      const value = event.target.value;
                                      setBlockParam(blockSettingsMemberId, blockType, current, {
                                        level:
                                          value === ""
                                            ? undefined
                                            : (value as BlockParams["level"]),
                                      });
                                    }}
                                    className={NATIVE_SELECT_CLASSES}
                                  >
                                    <option value="">—</option>
                                    {LEVELS.map((level) => (
                                      <option key={level} value={level}>
                                        {level}
                                      </option>
                                    ))}
                                  </select>
                                </Label>
                              )}
                              {DIFFICULTY_BLOCK_TYPES.has(blockType) && (
                                <Label className="flex items-center gap-2 text-xs">
                                  {t("dailyBriefing.admin.blockDifficultyLabel")}
                                  <select
                                    data-testid={`daily-briefing-admin-block-difficulty-${blockType}`}
                                    value={current.params?.difficulty ?? ""}
                                    disabled={saving}
                                    onChange={(event) => {
                                      const value = event.target.value;
                                      setBlockParam(blockSettingsMemberId, blockType, current, {
                                        difficulty: value === "" ? undefined : value,
                                      });
                                    }}
                                    className={NATIVE_SELECT_CLASSES}
                                  >
                                    <option value="">—</option>
                                    {DIFFICULTIES.map((difficulty) => (
                                      <option key={difficulty} value={difficulty}>
                                        {t(DIFFICULTY_LABEL_KEYS[difficulty])}
                                      </option>
                                    ))}
                                  </select>
                                </Label>
                              )}
                              {languages && (
                                <Label className="flex items-center gap-2 text-xs">
                                  {t("dailyBriefing.admin.blockLanguageLabel")}
                                  <select
                                    data-testid={`daily-briefing-admin-block-language-${blockType}`}
                                    value={current.params?.language ?? ""}
                                    disabled={saving}
                                    onChange={(event) => {
                                      const value = event.target.value;
                                      setBlockParam(blockSettingsMemberId, blockType, current, {
                                        language: value === "" ? undefined : value,
                                      });
                                    }}
                                    className={NATIVE_SELECT_CLASSES}
                                  >
                                    <option value="">—</option>
                                    {languages.map((language) => (
                                      <option key={language} value={language}>
                                        {t(
                                          language === "es"
                                            ? "dailyBriefing.admin.language.es"
                                            : "dailyBriefing.admin.language.en"
                                        )}
                                      </option>
                                    ))}
                                  </select>
                                </Label>
                              )}
                            </div>
                          </td>
                          <td className="border-b p-2" colSpan={7}>
                            <WeekdayPicker
                              mode="multi"
                              value={CANONICAL_WEEKDAY_ORDER.filter((day) => activeDays.has(day))}
                              onChange={(next) =>
                                setBlockWeekdays(blockSettingsMemberId, blockType, next)
                              }
                              disabled={saving}
                              disabledDays={CANONICAL_WEEKDAY_ORDER.filter(
                                (d) => !blockMemberSchedule.includes(d)
                              )}
                              labels={weekdayLabels(t)}
                              groupLabel={t("dailyBriefing.admin.blockWeekdaysLabel")}
                              testIdPrefix={`daily-briefing-admin-block-weekday-${blockType}`}
                              className="grid grid-cols-7 gap-2"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AdminPanel>
  );
}
