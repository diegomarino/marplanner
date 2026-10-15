import type { CSSProperties } from "react";
import type { Member } from "../../../shared";
import { cn } from "@/lib/utils";

/** A member's name on their own colour, as on the Members page. */
export function MemberChip({
  member,
  className,
}: {
  member: Pick<Member, "displayName" | "colorKey">;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-member-avatar-foreground max-w-full truncate rounded-full bg-[var(--member-color)] px-2 py-0.5 text-sm font-semibold",
        className
      )}
      // eslint-disable-next-line ui-policy/debt -- Closed member keys select generated semantic token custom properties only.
      style={{ "--member-color": `var(--color-member-${member.colorKey}-500)` } as CSSProperties}
    >
      {member.displayName}
    </span>
  );
}
