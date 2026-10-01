import { CheckboxField } from "@/components/CheckboxField";
import { useState, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import type { HighlightRule } from "../../../shared";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function HighlightRuleCard({
  rule,
  busy,
  onToggle,
  onDelete,
}: {
  rule: HighlightRule;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rule.id,
  });
  return (
    <>
      <article
        ref={setNodeRef}
        data-testid={`highlight-rule-${rule.id}`}
        // eslint-disable-next-line ui-policy/debt -- DnD frame values only forward CSS custom properties; token classes own presentation.
        style={
          {
            "--drag-transform": CSS.Transform.toString(transform) ?? "none",
            "--drag-transition": transition ?? "none",
          } as CSSProperties
        }
        className={`space-y-2 rounded-2xl border bg-card p-3 shadow-sm [transform:var(--drag-transform)] [transition:var(--drag-transition)] ${isDragging ? "opacity-70" : ""}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="cursor-grab touch-none rounded p-1 active:cursor-grabbing"
              aria-label={t("calendar.admin.dragRule").replace("{emoji}", rule.emoji)}
              disabled={busy}
              {...attributes}
              {...listeners}
            >
              <GripVertical aria-hidden="true" className="size-4" />
            </Button>
            <p className="min-w-0 break-words font-medium">
              {rule.emoji} {rule.keywords.join(", ")}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("calendar.admin.deleteRule")}
            disabled={busy}
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </div>
        <CheckboxField
          checked={rule.enabled}
          disabled={busy}
          onChange={(checked) => onToggle(rule.id, checked)}
          label={t("calendar.admin.enabled")}
        />
      </article>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("calendar.admin.deleteRuleConfirm").replace("{emoji}", rule.emoji)}
        description={t("calendar.admin.deleteRuleDescription")}
        confirmLabel={t("calendar.admin.delete")}
        cancelLabel={t("calendar.admin.cancel")}
        onConfirm={() => onDelete(rule.id)}
      />
    </>
  );
}
