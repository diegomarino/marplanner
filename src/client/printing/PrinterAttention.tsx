import { useEffect, useState } from "react";
import { Printer } from "lucide-react";

import { appUrl } from "@/lib/base-path";
import { whenCelebrationsSettled } from "@/chores/CompletionCelebration";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { usePrinterSession } from "./PrinterSession";

/** A compact recovery entry point; it reports session facts but never infers printer health.
 * Discreet while the session is healthy (paired or printing) and a destructive-styled attention
 * request when action is needed (kiosk-shell-navigation contract). A pair started from the
 * dialog closes it once the session reports paired; a failed pair keeps it open.
 * It also opens by itself when the session finds queued work and no printer to drain it (an
 * auto-printed briefing), after any chore celebration on screen has finished, and then leads
 * with a large pair button a child can recognise. */
export function PrinterAttention(): React.JSX.Element | null {
  const t = useT();
  const session = usePrinterSession();
  const [open, setOpen] = useState(false);
  const [pairRequested, setPairRequested] = useState(false);
  const [waitingWork, setWaitingWork] = useState(false);
  const displayState = session?.displayState;
  const promptId = session?.pairingPromptId ?? 0;
  const canPair = session?.canPair ?? false;

  // The request stays set until the dialog closes: a failed or cancelled pair leaves it open,
  // and the next healthy state closes it. Clearing it on failure from an effect would race a
  // quick retry (the stale effect can run after the next click and erase that request).
  useEffect(() => {
    if (pairRequested && (displayState === "paired" || displayState === "printing")) {
      setPairRequested(false);
      setOpen(false);
    }
  }, [pairRequested, displayState]);

  // Each new prompt request opens the dialog, but never on top of a celebration: the confetti
  // finishes (timer or tap) first, then the pairing prompt appears.
  useEffect(() => {
    if (promptId === 0 || !canPair) return;
    return whenCelebrationsSettled(() => {
      setWaitingWork(true);
      setOpen(true);
    });
  }, [promptId, canPair]);

  if (!session?.active) return null;
  const healthy = displayState === "paired" || displayState === "printing";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setPairRequested(false);
          setWaitingWork(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant={healthy ? "ghost" : "destructive"}
          data-testid="printer-attention-pill"
          data-healthy={healthy ? "true" : "false"}
        >
          {healthy
            ? `${t("printing.executor.title")} · ${t(session.stateLabelKey)}`
            : t("printing.attention.pill")}
        </Button>
      </DialogTrigger>
      <DialogContent
        data-testid="printer-attention-dialog"
        data-reason={waitingWork ? "waiting-work" : "manual"}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle>
            {t(waitingWork ? "printing.attention.waitingTitle" : "printing.attention.title")}
          </DialogTitle>
          <DialogDescription>
            {t(
              waitingWork
                ? "printing.attention.waitingDescription"
                : "printing.attention.description"
            )}
          </DialogDescription>
        </DialogHeader>
        <p data-testid="printer-attention-state" className="text-sm">
          {t(session.stateLabelKey)}
        </p>
        {session.canPair && (
          <Button
            type="button"
            data-testid="printer-attention-pair"
            className="min-h-28 w-full gap-4 rounded-2xl shadow-lg ring-4 ring-primary/30"
            onClick={() => {
              setPairRequested(true);
              session.pair();
            }}
          >
            <Printer aria-hidden="true" className="size-12 motion-safe:animate-bounce" />
            <span className="text-3xl font-bold">
              {t(
                session.displayState === "disconnected"
                  ? "printing.executor.repairButton"
                  : "printing.executor.pairButton"
              )}
            </span>
          </Button>
        )}
        <DialogFooter>
          <Button variant="outline" asChild>
            <a href={appUrl("/admin/printing")}>{t("printing.attention.admin")}</a>
          </Button>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("printing.attention.dismiss")}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
