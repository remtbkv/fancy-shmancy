import React from "react";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Required: the switch carries no visible label of its own. */
  label: string;
  className?: string;
}

/**
 * The bare switch, restyled to the reference: a 42x25 fully-rounded track with
 * a 21px white knob inset by 2px, so it travels 17px. Off track
 * `--fs-toggle-off`, on track `--fs-ink`.
 *
 * This is the control alone — the label and its current value belong to
 * `SettingRow`. `ToggleSwitch` remains for the existing settings components
 * that still wrap `SettingContainer`.
 *
 * The knob crossfades over `--fs-enter` (80ms): no toggle flip was captured in
 * the reference recording, so it borrows the house enter duration rather than
 * inventing a longer one.
 */
export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  label,
  className = "",
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50
      ${disabled ? "" : "cursor-pointer"} ${className}`}
    style={{
      width: "var(--fs-toggle-w)",
      height: "var(--fs-toggle-h)",
      background: checked ? "var(--fs-ink)" : "var(--fs-toggle-off)",
      transitionDuration: "var(--fs-enter)",
    }}
  >
    <span
      aria-hidden
      className="absolute top-[2px] left-[2px] rounded-full transition-transform"
      style={{
        width: "var(--fs-toggle-knob)",
        height: "var(--fs-toggle-knob)",
        background: "var(--fs-toggle-knob-fill)",
        transform: checked
          ? "translateX(calc(var(--fs-toggle-w) - var(--fs-toggle-knob) - 4px))"
          : "translateX(0)",
        transitionDuration: "var(--fs-enter)",
        transitionTimingFunction: "ease-out",
      }}
    />
  </button>
);
