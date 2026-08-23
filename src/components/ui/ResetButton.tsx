import React from "react";
import ResetIcon from "../icons/ResetIcon";

interface ResetButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  children?: React.ReactNode;
}

export const ResetButton: React.FC<ResetButtonProps> = React.memo(
  ({ onClick, disabled = false, className = "", ariaLabel, children }) => (
    <button
      type="button"
      aria-label={ariaLabel}
      className={`p-1 rounded-md border border-transparent transition-all duration-[80ms] ${
        disabled
          ? "opacity-50 cursor-not-allowed text-text/40"
          : "hover:bg-[var(--fs-quiet)] active:bg-[var(--fs-quiet-hover)] active:translate-y-[1px] hover:cursor-pointer hover:border-logo-primary text-text/80"
      } ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children ?? <ResetIcon />}
    </button>
  ),
);
