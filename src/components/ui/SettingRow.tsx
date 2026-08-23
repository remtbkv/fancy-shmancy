import React from "react";

interface SettingRowProps {
  title: string;
  /**
   * The setting's CURRENT VALUE, shown under the title — "Built-in mic
   * (recommended)", "English". Its presence is what makes the row the taller
   * two-line variant. A node may be passed for values that need their own
   * shrink behaviour (see `MiddleTruncate` for paths).
   */
  subtitle?: React.ReactNode;
  /** Right-aligned control: a Toggle, a PillButton, a Select. */
  children?: React.ReactNode;
  badge?: number;
  disabled?: boolean;
  className?: string;
}

/**
 * One setting inside a SoftCard. Rows are siblings; each draws its own bottom
 * hairline and the last one drops it, which reproduces the reference's
 * divider-between-rows-only look without the card knowing how many there are.
 *
 * Measured: 65px single-line / 86px with a value line, both plus a 1px
 * `--fs-hairline` divider; 20px horizontal padding; title 15px/600 in
 * `--fs-ink`; value line 15px/400 in `--fs-ink-secondary`, sitting 26px below
 * the title's baseline (which centring the pair reproduces exactly).
 */
export const SettingRow: React.FC<SettingRowProps> = ({
  title,
  subtitle,
  children,
  badge,
  disabled = false,
  className = "",
}) => (
  <div
    className={`flex items-center justify-between border-b border-[var(--fs-hairline)] last:border-b-0
      ${disabled ? "opacity-50" : ""} ${className}`}
    style={{
      // content-box so the divider sits outside the measured row height: the
      // reference's single-line row is 65 of row plus a 1px hairline = 66
      // pitch, and the last row, which drops the hairline, is 65.
      boxSizing: "content-box",
      minHeight: subtitle ? "var(--fs-row-h-stacked)" : "var(--fs-row-h)",
      paddingInline: "var(--fs-row-px)",
      gap: "var(--fs-row-px)",
      fontFamily: "var(--fs-font-sans)",
    }}
  >
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-[8px]">
        <span
          className="truncate"
          style={{
            fontSize: "var(--fs-text-body)",
            fontWeight: 600,
            lineHeight: "21px",
            color: "var(--fs-ink)",
          }}
        >
          {title}
        </span>
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
      </div>
      {subtitle && (
        <div
          // A string value ellipsizes at its end; a node brings its own rule.
          className={typeof subtitle === "string" ? "truncate" : "min-w-0"}
          style={{
            fontSize: "var(--fs-text-body)",
            fontWeight: 400,
            lineHeight: "21px",
            marginTop: "5px",
            color: "var(--fs-ink-secondary)",
          }}
        >
          {subtitle}
        </div>
      )}
    </div>
    {children && <div className="flex shrink-0 items-center">{children}</div>}
  </div>
);
