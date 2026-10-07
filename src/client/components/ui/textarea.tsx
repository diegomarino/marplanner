import * as React from "react";
import { cn } from "@/lib/utils";

/** Native multiline input; rows and caller minimums may grow beyond the density floor. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-input placeholder:text-muted-foreground min-h-[var(--control-height)] w-full rounded-md border bg-transparent px-3 py-2 text-control outline-none focus-visible:ring-ring focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
}
export { Textarea };
