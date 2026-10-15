import { useEffect, useState } from "react";
import type { Chore, ChoreInput } from "../../../shared";
import { useT } from "@/i18n";
import { EmojiPicker } from "@/chores/EmojiPicker";
import { ErrorNotice } from "@/components/ErrorNotice";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface ChoreFormDialogProps {
  open: boolean;
  /** The chore being edited; null adds a new one. */
  chore: Chore | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: ChoreInput) => void;
}

export function ChoreFormDialog({
  open,
  chore,
  saving,
  error,
  onClose,
  onSubmit,
}: ChoreFormDialogProps) {
  const t = useT();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(chore?.name ?? "");
    setIcon(chore?.icon ?? null);
  }, [open, chore]);

  const trimmed = name.trim();
  function submit() {
    if (!trimmed || saving) return;
    onSubmit({ name: trimmed, icon });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogContent closeLabel={t("routines.action.cancel")} data-testid="chore-form-dialog">
        <DialogHeader>
          <DialogTitle>
            {chore ? t("routines.admin.editChore") : t("routines.action.createChore")}
          </DialogTitle>
          <DialogDescription>{t("routines.admin.choreFormDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-end gap-3">
          <EmojiPicker value={icon} onChange={setIcon} />
          <form
            id="chore-form"
            className="flex min-w-0 flex-1 flex-col gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Label htmlFor="chore-form-name">{t("routines.admin.choreNameLabel")}</Label>
            <Input
              id="chore-form-name"
              data-testid="chore-form-name"
              value={name}
              placeholder={t("routines.chores.placeholder")}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                submit();
              }}
            />
          </form>
        </div>
        <ErrorNotice message={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
            {t("routines.action.cancel")}
          </Button>
          <Button
            type="submit"
            form="chore-form"
            disabled={saving || !trimmed}
            data-testid="chore-form-submit"
          >
            {chore ? t("routines.admin.saveChore") : t("routines.action.createChore")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
