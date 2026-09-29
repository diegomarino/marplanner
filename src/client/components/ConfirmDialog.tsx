import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/** L2 composed component (FR-005/FR-008 — wiring and accessibility).
 * * Wiring:* coordinates focus trapping, portal behavior, and the Escape/confirm keyboard
 * contract. Radix mounts the portal to `document.body`, outside the surface that opened it, so
 * density styling must apply there too. Callers would otherwise assemble this behavior from
 * `components/ui/dialog.tsx` primitives by hand. * Accessibility:* dialog role and focus
 * management (inherited from
 * `@radix-ui/react-dialog`), applied consistently instead of per surface.
 * * Scope rule (FR-008, DP2 — this is a contract, not a suggestion):* this component guards the
 * DESTRUCTIVE direction of a toggle ONLY. Concretely, for the chore board: un-completing an
 * already-completed chore opens this dialog; completing an incomplete chore MUST stay a single,
 * ungated tap via `StatusToggle` directly. A call site that opens `ConfirmDialog` for BOTH
 * directions of a toggle violates FR-008 even though the component itself would work — this
 * component has no way to enforce that from inside itself (it doesn't know what a "chore" is),
 * so the call site carries the obligation. See this file's spec for
 * the executable proof of the pattern.
 * `title`/`description`/`confirmLabel`/`cancelLabel` are call-site-owned, already-localized
 * strings — this component introduces no shared i18n keys (same convention as
 * `components/ui/dialog.tsx`'s `closeLabel` prop).
 * Radix restores focus to its `DialogTrigger` on
 * close, by default — but every call site here uses a CONTROLLED `open` prop with no
 * `DialogTrigger` (the toggle that opens it isn't Radix's trigger, it's a separate `onPress`
 * handler deciding whether to open this dialog at all, per the DP2 scope rule above). With no
 * trigger to restore to, closing (Escape, Cancel, or Confirm) drops focus to `<body>` — on a
 * keyboard-operated kiosk that loses the user's place. Fixed HERE, once, rather than re-derived
 * at every call site: `onOpenAutoFocus` captures whatever had focus immediately before Radix's
 * own auto-focus behaviour runs (the element that opened this dialog), and `onCloseAutoFocus`
 * restores it, overriding Radix's trigger-seeking default.
 */
export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Localized dialog title. */
  title: string;
  /** Localized dialog body text. */
  description?: string;
  /** Localized confirm-button text (e.g. "Undo"). */
  confirmLabel: string;
  /** Localized cancel-button text (e.g. "Cancel"). */
  cancelLabel: string;
  /** Invoked when the confirm button is pressed; the dialog closes immediately after. */
  onConfirm: () => void;
  /** Styles the confirm button as destructive. Defaults to `true` — this component exists to
   * guard a destructive transition (FR-008); a call site confirming a NON-destructive action
   * should not be using this component at all (see DP2 note above). */
  destructive?: boolean;
  confirmTestId?: string;
  cancelTestId?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  destructive = true,
  confirmTestId,
  cancelTestId,
}: ConfirmDialogProps) {
  // The element focused immediately before this dialog took focus — captured in
  // `onOpenAutoFocus` (which fires before Radix's default focus-move runs, so
  // `document.activeElement` still names the pre-dialog control) and restored in
  // `onCloseAutoFocus`, which otherwise has no `DialogTrigger` to fall back to (see the file
  // focus-restoration note above).
  const returnFocusRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        closeLabel={cancelLabel}
        onOpenAutoFocus={() => {
          returnFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocusRef.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            data-testid={cancelTestId}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            data-testid={confirmTestId}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
