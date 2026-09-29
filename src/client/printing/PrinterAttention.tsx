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

/** A compact recovery entry point; it reports session facts but never infers printer health. */
export function PrinterAttention(): React.JSX.Element | null {
  const t = useT();
  const session = usePrinterSession();
  if (!session?.active) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" data-testid="printer-attention-pill">
          {t("printing.attention.pill")}
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
            <Button type="button" data-testid="printer-attention-pair" onClick={session.pair}>
              {t(
                session.displayState === "disconnected"
                  ? "printing.executor.repairButton"
                  : "printing.executor.pairButton"
              )}
            </Button>
          )}
          <Button variant="outline" asChild>
            <a href="/admin/printing">{t("printing.attention.admin")}</a>
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
