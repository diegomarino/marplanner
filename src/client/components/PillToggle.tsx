import { PillControl } from "./PillControl";

/** L2 composed component (wiring and accessibility).
 * An on/off choice drawn as a pill: plain when off, filled when on. Use it where several
 * independent choices sit side by side (filters, the people on an event, the meals a recipe
 * suits) and a column of checkboxes would spend more room than the choice deserves.
 * It stays a native checkbox for keyboard and assistive tech. The input is laid invisibly over
 * the whole pill, so the touch target is the full control and meets the density minimum.
 */
export interface PillToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Localized label text (call-site-owned). */
  label: string;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
}

export function PillToggle({
  checked,
  onChange,
  label,
  disabled,
  className,
  "data-testid": testId,
}: PillToggleProps) {
  return (
    <PillControl
      type="checkbox"
      checked={checked}
      onChange={onChange}
      label={label}
      disabled={disabled}
      className={className}
      data-testid={testId}
    />
  );
}
