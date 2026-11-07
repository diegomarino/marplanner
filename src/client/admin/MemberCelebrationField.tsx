import { useState, type CSSProperties, type KeyboardEvent } from "react";
import { PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { CELEBRATION_CHEER_KEYS, CompletionCelebration } from "@/chores/CompletionCelebration";
import { EmojiPicker, type EmojiPickerLabels } from "@/chores/EmojiPicker";
import { NotoEmoji } from "@/chores/noto-emoji";
import { useTranslation } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { useHouseholdSettings } from "@/lib/householdSettings";
import { cn } from "@/lib/utils";
import {
  CELEBRATION_CUSTOM_MAX,
  CELEBRATION_PRESETS,
  CELEBRATION_PRESET_IDS,
  MEMBER_COLOR_KEYS,
  celebrationEmojis,
  type CelebrationPreset,
  type MemberCelebration,
  type MemberColorKey,
} from "../../shared";

const PRESET_LABEL_KEYS: Record<CelebrationPreset, MessageKey> = {
  confetti: "members.celebration.preset.confetti",
  stars: "members.celebration.preset.stars",
  videogames: "members.celebration.preset.videogames",
  soccer: "members.celebration.preset.soccer",
  fairytale: "members.celebration.preset.fairytale",
  custom: "members.celebration.preset.custom",
};

const PICKER_LABELS: EmojiPickerLabels = {
  select: "members.celebration.addEmoji",
  change: "members.celebration.changeEmoji",
  title: "members.celebration.pickerTitle",
  clear: "members.celebration.removeEmoji",
};

const NAVIGATION_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];

/** A custom set needs at least one emoji before it can be saved. */
export function celebrationProblem(value: MemberCelebration): boolean {
  return value.preset === "custom" && value.emojis.length === 0;
}

/** Paper swatches for the emoji-less `confetti` preset, in the member's palette. */
function PaperSwatch({ colorKey }: { colorKey: MemberColorKey }) {
  const others = MEMBER_COLOR_KEYS.filter((key) => key !== colorKey);
  const colors = [colorKey, others[2], colorKey, others[6]];
  return (
    <span aria-hidden="true" className="flex items-end gap-1">
      {colors.map((key, index) => (
        <span
          key={index}
          className={cn(
            "block h-5 w-2.5 rounded-sm bg-[var(--paper-color)]",
            index % 2 === 0 ? "rotate-12" : "-rotate-12"
          )}
          // eslint-disable-next-line ui-policy/debt -- Closed member keys select generated semantic token custom properties only.
          style={{ "--paper-color": `var(--color-member-${key}-500)` } as CSSProperties}
        />
      ))}
    </span>
  );
}

interface MemberCelebrationFieldProps {
  value: MemberCelebration;
  onChange: (value: MemberCelebration) => void;
  /** The member's colour (or the one being chosen), for the swatch and the preview. */
  colorKey: MemberColorKey;
  disabled?: boolean;
}

/** The member dialog's "Celebration" field: one preset, or a custom set of up to six emojis
 * from the chore emoji picker, with an in-place preview of the board celebration.
 */
export function MemberCelebrationField({
  value,
  onChange,
  colorKey,
  disabled,
}: MemberCelebrationFieldProps) {
  const { t } = useTranslation();
  const { celebrationSound } = useHouseholdSettings();
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [cheerKey, setCheerKey] = useState<MessageKey>(CELEBRATION_CHEER_KEYS[0]);
  const customEmojis = value.preset === "custom" ? value.emojis : [];

  const choose = (preset: CelebrationPreset) => {
    if (preset === value.preset) return;
    // Custom starts from the set on screen, so a preset is easy to tweak.
    onChange(
      preset === "custom"
        ? { preset, emojis: [...celebrationEmojis(value)].slice(0, CELEBRATION_CUSTOM_MAX) }
        : { preset }
    );
  };

  const setCustom = (emojis: string[]) => onChange({ preset: "custom", emojis });

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, preset: CelebrationPreset) => {
    if (!NAVIGATION_KEYS.includes(event.key)) return;
    event.preventDefault();
    const ids = CELEBRATION_PRESET_IDS;
    const index = ids.indexOf(preset);
    const step = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
    const next =
      event.key === "Home"
        ? ids[0]
        : event.key === "End"
          ? ids[ids.length - 1]
          : ids[(index + step + ids.length) % ids.length];
    choose(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-celebration-preset="${next}"]`)
      ?.focus();
  };

  const preview = () => {
    setCheerKey(CELEBRATION_CHEER_KEYS[Math.floor(Math.random() * CELEBRATION_CHEER_KEYS.length)]);
    setPreviewId((current) => (current ?? 0) + 1);
  };

  return (
    <div className="flex flex-col gap-2" data-testid="member-celebration-field">
      <Label id="member-edit-celebration-label">{t("members.celebration.label")}</Label>
      <p className="text-muted-foreground text-sm">{t("members.celebration.description")}</p>
      <div
        role="radiogroup"
        aria-labelledby="member-edit-celebration-label"
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {CELEBRATION_PRESET_IDS.map((preset) => {
          const selected = value.preset === preset;
          const glyphs = preset === "custom" ? customEmojis : CELEBRATION_PRESETS[preset];
          return (
            <Button
              key={preset}
              type="button"
              variant="outline"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              data-celebration-preset={preset}
              data-testid={`member-celebration-preset-${preset}`}
              data-state={selected ? "checked" : "unchecked"}
              onClick={() => choose(preset)}
              onKeyDown={(event) => onKeyDown(event, preset)}
              wrap
              className="w-full flex-col gap-1.5 rounded-2xl px-3 py-2 data-[state=checked]:border-[var(--member-color)] data-[state=checked]:bg-[color-mix(in_oklch,var(--member-color)_14%,var(--card))] data-[state=checked]:ring-2 data-[state=checked]:ring-[var(--member-color)]"
              // eslint-disable-next-line ui-policy/debt -- Closed member keys select generated semantic token custom properties only.
              style={{ "--member-color": `var(--color-member-${colorKey}-500)` } as CSSProperties}
            >
              <span className="font-semibold">{t(PRESET_LABEL_KEYS[preset])}</span>
              <span className="flex min-h-6 items-center gap-1">
                {preset === "confetti" ? (
                  <PaperSwatch colorKey={colorKey} />
                ) : glyphs.length > 0 ? (
                  glyphs
                    .slice(0, 4)
                    .map((emoji) => <NotoEmoji key={emoji} emoji={emoji} size={22} />)
                ) : (
                  <span aria-hidden="true" className="text-muted-foreground">
                    ＋
                  </span>
                )}
              </span>
            </Button>
          );
        })}
      </div>

      {value.preset === "custom" && (
        <div className="flex flex-col gap-1.5" data-testid="member-celebration-custom">
          <div
            role="group"
            aria-label={t("members.celebration.customLabel")}
            className="flex flex-wrap items-center gap-2"
          >
            {customEmojis.map((emoji, index) => (
              <EmojiPicker
                key={emoji}
                labels={PICKER_LABELS}
                value={emoji}
                onChange={(next) => {
                  if (next === null) {
                    setCustom(customEmojis.filter((_, i) => i !== index));
                  } else if (!customEmojis.includes(next)) {
                    setCustom(customEmojis.map((current, i) => (i === index ? next : current)));
                  }
                }}
              />
            ))}
            {customEmojis.length < CELEBRATION_CUSTOM_MAX && !disabled && (
              <EmojiPicker
                labels={PICKER_LABELS}
                value={null}
                onChange={(next) => {
                  if (next !== null && !customEmojis.includes(next))
                    setCustom([...customEmojis, next]);
                }}
              />
            )}
          </div>
          <p
            className={cn(
              "text-sm",
              celebrationProblem(value) ? "text-foreground font-medium" : "text-muted-foreground"
            )}
            data-testid="member-celebration-custom-hint"
          >
            {celebrationProblem(value)
              ? t("members.celebration.customEmpty")
              : t("members.celebration.customHint")
                  .replace("{count}", String(customEmojis.length))
                  .replace("{max}", String(CELEBRATION_CUSTOM_MAX))}
          </p>
        </div>
      )}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="member-celebration-preview"
          disabled={celebrationProblem(value)}
          onClick={preview}
        >
          <PartyPopper aria-hidden="true" />
          {t("members.celebration.preview")}
        </Button>
      </div>

      {previewId !== null && (
        <CompletionCelebration
          key={previewId}
          colorKey={colorKey}
          emojis={celebrationEmojis(value)}
          title={t("celebration.title.morning")}
          message={t(cheerKey)}
          sound={celebrationSound !== false}
          onDismiss={() => setPreviewId(null)}
        />
      )}
    </div>
  );
}
