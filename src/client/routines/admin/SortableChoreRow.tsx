import type { CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import type { Chore } from "../../../shared";
import type { MessageKey } from "@/i18n/messages";
import { useT } from "@/i18n";
import { Button } from "@/components/ui/button";
import { NotoEmoji } from "@/chores/noto-emoji";

export function SortableChoreRow({
  chore,
  busy,
  onEdit,
  onDelete,
}: {
  chore: Chore;
  busy: boolean;
  onEdit: (chore: Chore) => void;
  onDelete: (chore: Chore) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: chore.id,
  });
  const named = (key: MessageKey) => t(key).replace("{name}", chore.name);

  return (
    <li
      ref={setNodeRef}
      data-testid={`chore-${chore.id}`}
      // eslint-disable-next-line ui-policy/debt -- DnD frame values only forward CSS custom properties; token classes own presentation.
      style={
        {
          "--drag-transform": CSS.Transform.toString(transform) ?? "none",
          "--drag-transition": transition ?? "none",
        } as CSSProperties
      }
      className={`bg-card flex items-center gap-2 rounded-2xl border py-2 pr-2 pl-1 shadow-sm [transform:var(--drag-transform)] [transition:var(--drag-transition)] ${isDragging ? "opacity-70" : ""}`}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing"
        aria-label={named("routines.admin.dragChore")}
        disabled={busy}
        data-testid={`chore-drag-${chore.id}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical aria-hidden="true" className="size-4" />
      </Button>
      <NotoEmoji emoji={chore.icon ?? "📋"} size={24} />
      <span className="min-w-0 flex-1 font-medium break-words">{chore.name}</span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="shrink-0"
        aria-label={named("routines.admin.editChoreAria")}
        title={named("routines.admin.editChoreAria")}
        disabled={busy}
        data-testid={`chore-edit-${chore.id}`}
        onClick={() => onEdit(chore)}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-destructive shrink-0"
        aria-label={named("routines.admin.deleteChoreAria")}
        title={named("routines.admin.deleteChoreAria")}
        disabled={busy}
        data-testid={`chore-delete-${chore.id}`}
        onClick={() => onDelete(chore)}
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </Button>
    </li>
  );
}
