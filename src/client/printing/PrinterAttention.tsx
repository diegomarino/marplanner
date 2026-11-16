import { useEffect, useState } from "react";
import { Printer } from "lucide-react";

import { appUrl } from "@/lib/base-path";
import { whenCelebrationsSettled } from "@/chores/CompletionCelebration";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { usePrinterSession } from "./PrinterSession";
import { loadRememberedPrinter } from "./rememberedPrinter";

/** A compact recovery entry point; it reports session facts but never infers printer health.
 * Discreet while the session is healthy (paired or printing) and a destructive-styled attention
 * request when action is needed (kiosk-shell-navigation contract). A pair started from the
 * dialog closes it once the session reports paired; a failed pair keeps it open.
 * It also opens by itself when the session finds queued work and no printer to drain it (an
 * auto-printed briefing), after any chore celebration on screen has finished, and then leads
 * with a prominent pair button a child can recognise. The copy says whether this screen had a
 * printer before (the session's last pairing, else the one remembered for reconnects). */
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

  // An automatic prompt has nothing left to ask once the session is healthy again, including
  // after a gesture-free reconnect that finished while it was open.
  useEffect(() => {
    if (waitingWork && (displayState === "paired" || displayState === "printing")) {
      setWaitingWork(false);
      setOpen(false);
    }
  }, [waitingWork, displayState]);

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
  const known = session.pairedDevice ?? loadRememberedPrinter();
  const withName = (
    key: "printing.attention.knownPrinter" | "printing.attention.connectedPrinter"
  ) => t(key).replace("{name}", known?.name ?? "");
  const printerLine = healthy
    ? known?.name
      ? withName("printing.attention.connectedPrinter")
      : t(session.stateLabelKey)
    : displayState === "pairing"
      ? t(session.stateLabelKey)
      : known
        ? known.name
          ? withName("printing.attention.knownPrinter")
          : t("printing.attention.knownPrinterUnnamed")
        : t("printing.attention.noPrinter");

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
        closeLabel={t("printing.attention.dismiss")}
      >
        <DialogHeader>
          <DialogTitle>
            {t(waitingWork ? "printing.attention.waitingTitle" : "printing.attention.title")}
          </DialogTitle>
          <DialogDescription data-testid="printer-attention-state" data-state={displayState}>
            {printerLine}
            {waitingWork && !healthy && ` ${t("printing.attention.waitingDescription")}`}
          </DialogDescription>
        </DialogHeader>
        {session.canPair && (
          <Button
            type="button"
            data-testid="printer-attention-pair"
            className="min-h-16 w-full rounded-xl shadow-md ring-4 ring-primary/25"
            onClick={() => {
              setPairRequested(true);
              session.pair();
            }}
          >
            <Printer aria-hidden="true" className="size-6" />
            <span className="text-xl font-semibold">
              {t(known ? "printing.attention.reconnectButton" : "printing.executor.pairButton")}
            </span>
          </Button>
        )}
        <DialogFooter>
          <Button variant="link" size="sm" asChild>
            <a href={appUrl("/admin/printing")}>{t("printing.attention.admin")}</a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
