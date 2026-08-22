import React from "react";

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  selected?: boolean;
  /** Unread count; rendered as the reference's red circle when > 0. */
  badge?: number;
  /** Mini-sidebar items sit flush (36px pitch); app-sidebar items get a 4px gap. */
  dense?: boolean;
  onClick?: () => void;
  className?: string;
}

/**
 * A nav row: icon, label, and a quiet rounded fill when selected.
 *
 * Measured: 192x36 box, 6px radius, 8px inner padding, 20px icon, 8px gap,
 * 15px label, `--fs-quiet` selected fill. The app sidebar repeats these at a
 * 40px pitch, the settings modal's mini-sidebar at 36px (items touch).
 */
export const SidebarItem: React.FC<SidebarItemProps> = ({
  icon,
  label,
  selected = false,
  badge,
  dense = false,
  onClick,
  className = "",
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={selected ? "page" : undefined}
    className={`flex w-full cursor-pointer items-center rounded-[var(--fs-radius-item)] text-left
      ${dense ? "" : "mb-[4px]"}
      ${selected ? "bg-[var(--fs-quiet)]" : "bg-transparent hover:bg-[var(--fs-row-hover)]"}
      ${className}`}
    style={{
      height: "var(--fs-item-h)",
      paddingInline: "var(--fs-item-px)",
      gap: "var(--fs-item-gap)",
      fontFamily: "var(--fs-font-sans)",
      fontSize: "var(--fs-text-body)",
      fontWeight: 500,
      color: "var(--fs-ink)",
    }}
  >
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center"
      style={{ width: "var(--fs-item-icon)", height: "var(--fs-item-icon)" }}
    >
      {icon}
    </span>
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {badge !== undefined && badge > 0 && (
      <span
        className="flex shrink-0 items-center justify-center rounded-full font-semibold"
        style={{
          width: "var(--fs-badge-size)",
          height: "var(--fs-badge-size)",
          background: "var(--fs-badge)",
          color: "var(--fs-badge-ink)",
          fontSize: "11px",
        }}
      >
        {badge}
      </span>
    )}
  </button>
);
