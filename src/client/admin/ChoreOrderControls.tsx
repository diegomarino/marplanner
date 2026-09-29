import { useState } from "react";
import { authFetch } from "@/lib/credential";
import { log } from "@/lib/logger";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { ErrorNotice } from "@/components/ErrorNotice";

interface ChoreOrderControlsProps {
  routineId: string;
  chores: Array<{ id: string; name: string }>;
  onReorder: (newOrder: string[]) => void;
}

/** ChoreOrderControls — move-up/move-down reorder UI for one routine's chore
 * list (no drag-and-drop). Wires PUT
 * /api/routines/:id/chores/order.
 * (token dialect, FR-009): every raw scale-class button ("text-blue-500",
 * "bg-green-500",...) is now the shared `Button` primitive, which inherits
 * density-token sizing and never needs its own colour literal.
 * (independent): a failed order PUT used to be `log`-ed and
 * nothing else — no `ErrorNotice`, no visible message, the panel silently stayed in edit mode.
 * `SC011_SELECTOR` (eslint.config.mjs) only fires on error-COLOURED text, so a plain swallowed
 * catch cleared the ratchet while a real failure stayed invisible to everyone, including
 * assistive technology (SC-011: every error state a surface can render is announced through the
 * shared live region, or the surface is documented as rendering none — this file could not make
 * that second claim once its error path was exercised, so it now takes the first).
 */
export function ChoreOrderControls({ routineId, chores, onReorder }: ChoreOrderControlsProps) {
  const { t } = useTranslation();
  const [isEditingOrder, setIsEditingOrder] = useState(false);
  const [localOrder, setLocalOrder] = useState<string[]>(chores.map((c) => c.id));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const nameById = (id: string): string => chores.find((c) => c.id === id)?.name ?? id;

  function handleMoveUp(index: number) {
    if (index === 0) return;
    const newOrder = [...localOrder];
    [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
    setLocalOrder(newOrder);
  }

  function handleMoveDown(index: number) {
    if (index === localOrder.length - 1) return;
    const newOrder = [...localOrder];
    [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
    setLocalOrder(newOrder);
  }

  async function handleSaveOrder() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await authFetch(`/api/routines/${routineId}/chores/order`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choreIds: localOrder }),
      });
      if (!res.ok) throw new Error("Failed to reorder chores");
      onReorder(localOrder);
      setIsEditingOrder(false);
    } catch (err) {
      log("error", "admin.chores.reorder", "Failed to reorder chores", {
        routineId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      setSaveError(t("routines.chores.reorderError"));
    } finally {
      setSaving(false);
    }
  }

  function handleStartEdit() {
    setSaveError(null);
    setLocalOrder(chores.map((c) => c.id));
    setIsEditingOrder(true);
  }

  function handleCancelOrder() {
    setSaveError(null);
    setLocalOrder(chores.map((c) => c.id));
    setIsEditingOrder(false);
  }

  if (!isEditingOrder) {
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        onClick={handleStartEdit}
        disabled={chores.length < 2}
      >
        {t("routines.chores.reorder")}
      </Button>
    );
  }

  return (
    <div className="mt-2">
      {saveError && <ErrorNotice message={saveError} className="mb-2" />}
      <ul className="space-y-1 mb-2">
        {localOrder.map((choreId, index) => (
          <li key={choreId} className="flex justify-between items-center gap-2">
            <span>{nameById(choreId)}</span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleMoveUp(index)}
                disabled={index === 0}
                aria-label={t("routines.chores.moveUp")}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleMoveDown(index)}
                disabled={index === localOrder.length - 1}
                aria-label={t("routines.chores.moveDown")}
              >
                ↓
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={handleSaveOrder}
          disabled={saving}
        >
          {saving ? t("routines.management.loading") : t("routines.chores.saveOrder")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCancelOrder}
          disabled={saving}
        >
          {t("routines.action.cancel")}
        </Button>
      </div>
    </div>
  );
}
