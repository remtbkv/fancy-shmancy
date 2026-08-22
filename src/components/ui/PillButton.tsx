import React from "react";

interface PillButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `quiet` — the reference's `Change` button: the same fill as a selected
   * sidebar item. `dark` — its inverted call-to-action ("Upgrade to Pro").
   */
  variant?: "quiet" | "dark";
  /**
   * Stretch to the 164px width Wispr uses for the right-hand control column,
   * so several rows' buttons line up.
   */
  column?: boolean;
}

/**
 * Measured: 36px tall, 8px radius, 15px/600 label. The quiet fill is
 * `--fs-quiet`; the dark variant is ink-on-card at the same size and radius.
 */
export const PillButton: React.FC<PillButtonProps> = ({
  variant = "quiet",
  column = false,
  className = "",
  children,
  ...props
}) => {
  const skin =
    variant === "dark"
      ? {
          background: "var(--fs-ink)",
          color: "var(--fs-card)",
        }
      : {
          background: "var(--fs-quiet)",
          color: "var(--fs-ink)",
        };

  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center justify-center rounded-[var(--fs-radius-pill)]
        transition-colors disabled:cursor-not-allowed disabled:opacity-50
        ${variant === "quiet" ? "hover:bg-[var(--fs-quiet-hover)]" : "hover:opacity-90"}
        ${className}`}
      style={{
        ...skin,
        height: "var(--fs-control-h)",
        minWidth: column ? "164px" : undefined,
        paddingInline: "var(--fs-row-px)",
        fontFamily: "var(--fs-font-sans)",
        fontSize: "var(--fs-text-body)",
        fontWeight: 600,
        transitionDuration: "var(--fs-enter)",
      }}
      {...props}
    >
      {children}
    </button>
  );
};
