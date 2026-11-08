import { useEffect, useState } from "react";

import { appUrl } from "@/lib/base-path";
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
 * dialog closes it once the session reports paired; a failed pair keeps it open. */
export function PrinterAttention(): React.JSX.Element | null {
  const t = useT();
  const session = usePrinterSession();
  const [open, setOpen] = useState(false);
  const [pairRequested, setPairRequested] = useState(false);
  const displayState = session?.displayState;

  useEffect(() => {
    if (!pairRequested) return;
    if (displayState === "paired" || displayState === "printing") {
      setPairRequested(false);
      setOpen(false);
    } else if (displayState !== "pairing") {
      // The pair attempt ended without a connection (cancelled chooser, error): stay open.
      setPairRequested(false);
    }
  }, [pairRequested, displayState]);

  if (!session?.active) return null;
  const healthy = displayState === "paired" || displayState === "printing";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPairRequested(false);
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
      <DialogContent data-testid="printer-attention-dialog" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("printing.attention.title")}</DialogTitle>
          <DialogDescription>{t("printing.attention.description")}</DialogDescription>
        </DialogHeader>
        <p data-testid="printer-attention-state" className="text-sm">
          {t(session.stateLabelKey)}
        </p>
        <DialogFooter>
          {session.canPair && (
            <Button
              type="button"
              data-testid="printer-attention-pair"
              onClick={() => {
                setPairRequested(true);
                session.pair();
              }}
            >
              {t(
                session.displayState === "disconnected"
                  ? "printing.executor.repairButton"
                  : "printing.executor.pairButton"
              )}
            </Button>
          )}
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
