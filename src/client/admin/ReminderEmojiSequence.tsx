import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { MAX_REMINDER_EMOJIS } from "../../shared";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { EmojiPicker } from "@/chores/EmojiPicker";
import { emojiLabelKey } from "@/chores/emoji-catalog";
import { NotoEmoji } from "@/chores/noto-emoji";

interface ReminderEmojiSequenceProps {
  value: string[];
  onChange: (next: string[]) => void;
}

/** The ordered emoji list of an image reminder: one tile per emoji with move-earlier, move-later
 * and remove buttons (buttons rather than drag so it works by keyboard and touch alike), then the
 * shared `EmojiPicker` as the add button until the list holds `MAX_REMINDER_EMOJIS`. */
export function ReminderEmojiSequence({ value, onChange }: ReminderEmojiSequenceProps) {
  const { t } = useTranslation();
  const nameOf = (emoji: string) => {
    const key = emojiLabelKey(emoji);
    return key ? t(key) : emoji;
  };
  const move = (from: number, to: number) => {
    const next = [...value];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-control">{t("reminders.images.label")}</span>
      {value.length === 0 && (
        <p className="text-muted-foreground text-control">{t("reminders.images.empty")}</p>
      )}
      <ol
        aria-label={t("reminders.images.label")}
        className="m-0 flex list-none flex-wrap gap-2 p-0"
      >
        {value.map((emoji, index) => {
          const name = nameOf(emoji);
          return (
            <li
              key={`${emoji}-${index}`}
              data-testid={`reminder-emoji-${index}`}
              className="bg-muted/40 flex flex-col items-center gap-1 rounded-xl border p-1"
            >
              <span className="flex size-12 items-center justify-center" title={name}>
                <NotoEmoji emoji={emoji} size={40} />
              </span>
              <span className="flex">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={index === 0}
                  aria-label={t("reminders.images.moveEarlier").replace("{emoji}", name)}
                  onClick={() => move(index, index - 1)}
                >
                  <ChevronLeft className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={index === value.length - 1}
                  aria-label={t("reminders.images.moveLater").replace("{emoji}", name)}
                  onClick={() => move(index, index + 1)}
                >
                  <ChevronRight className="size-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  data-testid={`reminder-emoji-remove-${index}`}
                  aria-label={t("reminders.images.remove").replace("{emoji}", name)}
                  onClick={() => onChange(value.filter((_, i) => i !== index))}
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
      {/* The add button opens its popover rightwards from the left edge, so it sits on its own
          row: at the end of a full row of tiles the popover would be clipped by the dialog. */}
      <div className="flex items-center gap-3">
        {value.length < MAX_REMINDER_EMOJIS && (
          <EmojiPicker
            value={null}
            emptyLabel={t("reminders.images.add")}
            dialogLabel={t("reminders.images.pickerTitle")}
            onChange={(emoji) => {
              if (emoji) onChange([...value, emoji]);
            }}
          />
        )}
        <p className="text-muted-foreground text-sm">{t("reminders.images.hint")}</p>
      </div>
    </div>
  );
}
