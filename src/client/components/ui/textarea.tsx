import * as React from "react";
import { cn } from "@/lib/utils";

/** Native multiline input; rows and caller minimums may grow beyond the density floor. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground bg-field min-h-[var(--control-height)] w-full rounded-md border px-3 py-2 text-control shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  );
}
export { Textarea };
