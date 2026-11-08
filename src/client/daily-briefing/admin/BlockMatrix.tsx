import type { CSSProperties } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { NATIVE_SELECT_CLASSES } from "@/lib/recipes";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CheckboxField } from "@/components/CheckboxField";
import { weekdayDisplayOrder, type WeekdayCode } from "@/components/WeekdayPicker";
import {
  BLOCK_LABEL_KEYS,
  CORPUS_LANGUAGE_AVAILABILITY,
  DEFAULT_DISABLED_BLOCK_TYPES,
  DIFFICULTIES,
  DIFFICULTY_BLOCK_TYPES,
  DIFFICULTY_LABEL_KEYS,
  COUNT_BLOCK_TYPES,
  countOptions,
  LEVEL_BLOCK_TYPES,
  LEVELS,
  WEEKDAY_LABEL_KEYS,
  effectiveBlockDays,
  effectiveMatrixBlockTypes,
  type BlockOrderInstance,
  type BlockParams,
  type BlockRegistryType,
  type MemberBlockSettings,
} from "./briefingBlocks";
import { isCorpusBackedBlockType } from "../../../shared/dailyBriefingBlocks";

export interface BlockMatrixProps {
  memberName: string;
  blockOrder: BlockOrderInstance[];
  resolve: (blockType: BlockRegistryType) => MemberBlockSettings;
  /** The member's briefing days (pause schedule); all seven when none is stored. */
  schedule: readonly WeekdayCode[];
  /** Rows with a write in flight. */
  savingTypes: ReadonlySet<BlockRegistryType>;
  scheduleSaving: boolean;
  orderSaving: boolean;
  /** Overrides the household week start (tests). */
  weekStartDay?: 0 | 1;
  onToggleCell: (blockType: BlockRegistryType, day: WeekdayCode) => void;
  /** The row's "every day" control: off on every day, or on every day when none is on. */
  onToggleRow: (blockType: BlockRegistryType) => void;
  onParamChange: (blockType: BlockRegistryType, patch: Partial<BlockParams>) => void;
  onToggleDay: (day: WeekdayCode) => void;
  onReorder: (activeType: BlockRegistryType, overType: BlockRegistryType) => void;
}

/** Blocks × weekdays for one member (spec D3/D4; reference BlockMatrix.tsx). Row order is the
 * household block order; cells are the member's per-block days; the "Briefing runs" row is the
 * member's pause schedule. Presentational: the page owns every write. */
export function BlockMatrix(props: BlockMatrixProps) {
  const t = useT();
  const household = useHouseholdSettings();
  const days = weekdayDisplayOrder(props.weekStartDay ?? household.weekStartDay);
  const types = effectiveMatrixBlockTypes(props.blockOrder);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(TouchSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const blockName = (id: UniqueIdentifier) => {
    const key = BLOCK_LABEL_KEYS[String(id) as BlockRegistryType];
    return key ? t(key) : String(id);
  };
  const dayName = (day: WeekdayCode) => t(WEEKDAY_LABEL_KEYS[day]);

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || props.orderSaving || event.active.id === event.over.id) return;
    props.onReorder(
      String(event.active.id) as BlockRegistryType,
      String(event.over.id) as BlockRegistryType
    );
  }

  return (
    // `relative` makes this box the containing block of the sr-only cell labels (absolutely
    // positioned), so they stay inside its horizontal scroll instead of widening the page.
    <div className="relative overflow-x-auto rounded-lg border">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
        accessibility={{
          screenReaderInstructions: { draggable: t("dailyBriefing.admin.dragInstructions") },
          announcements: {
            onDragStart: ({ active }) =>
              t("dailyBriefing.admin.dragStarted").replace("{block}", blockName(active.id)),
            onDragOver: ({ active, over }) =>
              over
                ? t("dailyBriefing.admin.dragOver")
                    .replace("{block}", blockName(active.id))
                    .replace(
                      "{position}",
                      String(types.indexOf(String(over.id) as BlockRegistryType) + 1)
                    )
                : "",
            onDragEnd: ({ active }) =>
              t("dailyBriefing.admin.dragEnded").replace("{block}", blockName(active.id)),
            onDragCancel: () => t("dailyBriefing.admin.dragCancelled"),
          },
        }}
      >
        <table className="w-full border-collapse text-sm" data-testid="daily-briefing-block-matrix">
          <thead>
            <tr className="bg-muted">
              <th scope="col" className="border-b px-3 py-2 text-left">
                {t("dailyBriefing.admin.blockColumn")}
              </th>
              {days.map((day) => (
                <th
                  key={day}
                  scope="col"
                  className="border-b px-1 py-2 text-center font-medium"
                  data-testid={`daily-briefing-block-weekday-heading-${day}`}
                >
                  {dayName(day)}
                </th>
              ))}
              <th scope="col" className="border-b px-2 py-2 text-center font-medium">
                {t("dailyBriefing.admin.everyDayColumn")}
              </th>
            </tr>
            <tr className="bg-muted/60">
              <th scope="row" className="border-b px-3 py-1 text-left font-medium">
                {t("dailyBriefing.admin.scheduleRowLabel")}
              </th>
              {days.map((day) => (
                <td key={day} className="border-b px-1 py-1 text-center">
                  <CheckboxField
                    data-testid={`daily-briefing-schedule-day-${day}`}
                    checked={props.schedule.includes(day)}
                    disabled={props.scheduleSaving}
                    onChange={() => props.onToggleDay(day)}
                    label={t("dailyBriefing.admin.dayRunsLabel").replace("{day}", dayName(day))}
                    labelHidden
                    className="justify-center"
                  />
                </td>
              ))}
              <td className="border-b" />
            </tr>
          </thead>
          <SortableContext items={types} strategy={verticalListSortingStrategy}>
            <tbody data-testid="daily-briefing-admin-block-settings-list">
              {types.map((type, index) => (
                <BlockRow
                  key={type}
                  type={type}
                  index={index}
                  days={days}
                  settings={props.resolve(type)}
                  schedule={props.schedule}
                  saving={props.savingTypes.has(type)}
                  orderSaving={props.orderSaving}
                  dayName={dayName}
                  onToggleCell={props.onToggleCell}
                  onToggleRow={props.onToggleRow}
                  onParamChange={props.onParamChange}
                />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </DndContext>
    </div>
  );
}

interface BlockRowProps {
  type: BlockRegistryType;
  index: number;
  days: readonly WeekdayCode[];
  settings: MemberBlockSettings;
  schedule: readonly WeekdayCode[];
  saving: boolean;
  orderSaving: boolean;
  dayName: (day: WeekdayCode) => string;
  onToggleCell: BlockMatrixProps["onToggleCell"];
  onToggleRow: BlockMatrixProps["onToggleRow"];
  onParamChange: BlockMatrixProps["onParamChange"];
}

function BlockRow({
  type,
  index,
  days,
  settings,
  schedule,
  saving,
  orderSaving,
  dayName,
  onToggleCell,
  onToggleRow,
  onParamChange,
}: BlockRowProps) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: type,
    disabled: orderSaving,
  });
  const label = t(BLOCK_LABEL_KEYS[type]);
  const on = new Set(effectiveBlockDays(settings));
  const languages = isCorpusBackedBlockType(type) ? CORPUS_LANGUAGE_AVAILABILITY[type] : undefined;

  return (
    <tr
      ref={setNodeRef}
      data-testid={`daily-briefing-admin-block-settings-row-${type}`}
      // eslint-disable-next-line ui-policy/debt -- DnD frame values only forward CSS custom properties; token classes own presentation.
      style={
        {
          "--drag-transform": CSS.Transform.toString(transform) ?? "none",
          "--drag-transition": transition ?? "none",
        } as CSSProperties
      }
      className={cn(
        "[transform:var(--drag-transform)] [transition:var(--drag-transition)]",
        index % 2 === 0 ? "bg-card" : "bg-muted/30",
        isDragging && "opacity-70"
      )}
    >
      <th scope="row" className="border-b px-2 py-1 text-left align-middle font-normal">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
            aria-label={t("dailyBriefing.admin.reorderLabel").replace("{block}", label)}
            disabled={orderSaving}
            data-testid={`daily-briefing-admin-block-drag-${type}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical aria-hidden="true" className="size-4" />
          </Button>
          <span className="font-medium">{label}</span>
          {DEFAULT_DISABLED_BLOCK_TYPES.has(type) && settings.updatedAt === null && (
            <span
              className="text-xs text-muted-foreground"
              data-testid={`daily-briefing-admin-block-default-disabled-${type}`}
            >
              {t("dailyBriefing.admin.defaultDisabledNote")}
            </span>
          )}
          {LEVEL_BLOCK_TYPES.has(type) && (
            <ParamSelect
              label={t("dailyBriefing.admin.blockLevelLabel")}
              testId={`daily-briefing-admin-block-level-${type}`}
              value={settings.params?.level ?? ""}
              disabled={saving}
              options={LEVELS.map((level) => ({ value: level, label: level }))}
              onChange={(value) =>
                onParamChange(type, {
                  level: value === "" ? undefined : (value as BlockParams["level"]),
                })
              }
            />
          )}
          {COUNT_BLOCK_TYPES.has(type) && (
            <ParamSelect
              label={t("dailyBriefing.admin.blockCountLabel")}
              testId={`daily-briefing-admin-block-count-${type}`}
              value={settings.params?.count === undefined ? "" : String(settings.params.count)}
              disabled={saving}
              options={countOptions(type).map((count) => ({
                value: String(count),
                label: String(count),
              }))}
              onChange={(value) =>
                onParamChange(type, { count: value === "" ? undefined : Number(value) })
              }
            />
          )}
          {DIFFICULTY_BLOCK_TYPES.has(type) && (
            <ParamSelect
              label={t("dailyBriefing.admin.blockDifficultyLabel")}
              testId={`daily-briefing-admin-block-difficulty-${type}`}
              value={settings.params?.difficulty ?? ""}
              disabled={saving}
              options={DIFFICULTIES.map((d) => ({ value: d, label: t(DIFFICULTY_LABEL_KEYS[d]) }))}
              onChange={(value) =>
                onParamChange(type, { difficulty: value === "" ? undefined : value })
              }
            />
          )}
          {languages && (
            <ParamSelect
              label={t("dailyBriefing.admin.blockLanguageLabel")}
              testId={`daily-briefing-admin-block-language-${type}`}
              value={settings.params?.language ?? ""}
              disabled={saving}
              options={languages.map((language) => ({
                value: language,
                label: t(
                  language === "es"
                    ? "dailyBriefing.admin.language.es"
                    : "dailyBriefing.admin.language.en"
                ),
              }))}
              onChange={(value) =>
                onParamChange(type, { language: value === "" ? undefined : value })
              }
            />
          )}
        </div>
      </th>
      {days.map((day) => {
        const paused = !schedule.includes(day);
        return (
          <td key={day} className={cn("border-b px-1 py-1 text-center", paused && "bg-muted")}>
            <CheckboxField
              data-testid={`daily-briefing-block-cell-${type}-${day}`}
              checked={on.has(day)}
              disabled={saving || paused}
              onChange={() => onToggleCell(type, day)}
              label={t("dailyBriefing.admin.cellLabel")
                .replace("{block}", label)
                .replace("{day}", dayName(day))}
              labelHidden
              className="justify-center"
            />
          </td>
        );
      })}
      <td className="border-b px-2 py-1 text-center">
        <Button
          type="button"
          variant="outline"
          data-testid={`daily-briefing-block-row-toggle-${type}`}
          disabled={saving}
          aria-label={t(
            on.size > 0 ? "dailyBriefing.admin.rowOffEveryDay" : "dailyBriefing.admin.rowOnEveryDay"
          ).replace("{block}", label)}
          onClick={() => onToggleRow(type)}
        >
          {t(on.size > 0 ? "dailyBriefing.admin.rowOff" : "dailyBriefing.admin.rowOn")}
        </Button>
      </td>
    </tr>
  );
}

function ParamSelect({
  label,
  testId,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  testId: string;
  value: string;
  disabled: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <Label className="flex items-center gap-1 text-xs">
      {label}
      <select
        data-testid={testId}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={NATIVE_SELECT_CLASSES}
      >
        <option value="">{t("dailyBriefing.admin.paramDefault")}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Label>
  );
}
