import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import { EMOJI_CATEGORIES } from "./emoji-catalog";
import { NotoEmoji } from "./noto-emoji";

interface EmojiPickerProps {
  value: string | null | undefined;
  onChange: (emoji: string | null) => void;
  className?: string;
}

export function EmojiPicker({ value, onChange, className }: EmojiPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const filteredCategories = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return EMOJI_CATEGORIES;
    return EMOJI_CATEGORIES.map((category) => ({
      ...category,
      items: category.items.filter((item) =>
        `${item.label} ${item.keywords.join(" ")}`.toLowerCase().includes(normalized)
      ),
    })).filter((category) => category.items.length > 0);
  }, [search]);

  const choose = (emoji: string | null) => {
    onChange(emoji);
    setOpen(false);
    setSearch("");
  };

  return (
    <div className={cn("relative", className)}>
      <Button
        type="button"
        variant="outline"
        className="size-[var(--control-height)] p-0 [font-size:1.5rem]"
        aria-label={
          value
            ? t("routines.emojiPicker.change").replace("{icon}", value)
            : t("routines.emojiPicker.select")
        }
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((current) => !current)}
      >
        {value ? <NotoEmoji emoji={value} size={24} /> : <span aria-hidden="true">＋</span>}
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label={t("routines.emojiPicker.title")}
          className="bg-card absolute top-full left-0 z-50 mt-2 w-max rounded-2xl border p-3 shadow-xl"
        >
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label={t("routines.emojiPicker.search")}
            placeholder={t("routines.emojiPicker.search")}
            className="mb-2"
          />
          <div className="max-h-60 space-y-3 overflow-y-auto pr-1">
            {filteredCategories.map((category) => (
              <section key={category.id}>
                <h4 className="text-muted-foreground mb-1 text-xs font-semibold uppercase tracking-wide">
                  {category.name}
                </h4>
                <div className="grid grid-cols-[repeat(8,var(--control-height))] gap-1">
                  {category.items.map((item) => (
                    <Button
                      key={`${category.id}-${item.emoji}`}
                      type="button"
                      variant={value === item.emoji ? "secondary" : "ghost"}
                      size="icon"
                      aria-label={`${t("routines.emojiPicker.choose")} ${item.label}`}
                      aria-pressed={value === item.emoji}
                      title={`${item.label} (${item.keywords.join(", ")})`}
                      onClick={() => choose(item.emoji)}
                    >
                      <NotoEmoji emoji={item.emoji} size={20} />
                    </Button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {filteredCategories.length === 0 && (
            <p className="text-muted-foreground mt-2 text-sm">
              {t("routines.emojiPicker.noResults")}
            </p>
          )}
          {value && (
            <Button
              type="button"
              variant="ghost"
              className="mt-2 w-full"
              onClick={() => choose(null)}
            >
              {t("routines.emojiPicker.clear")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
