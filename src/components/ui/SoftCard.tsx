import React from "react";

type SoftCardVariant = "card" | "inset" | "panel";

interface SoftCardProps {
  /**
   * `card` — the main content surface in the app window (white, 24px radius,
   * 40px padding). `inset` — a settings group inside the modal (cream, 12px
   * radius, no padding: SettingRows sit flush to its edges). `panel` — a
   * bordered side panel such as the stats rail (cream, 1px hairline, 16px
   * radius, 24px padding).
   */
  variant?: SoftCardVariant;
  className?: string;
  children: React.ReactNode;
}

const VARIANTS: Record<
  SoftCardVariant,
  { background: string; borderRadius: string; padding: string; border: string }
> = {
  card: {
    background: "var(--fs-card)",
    borderRadius: "var(--fs-radius-card)",
    padding: "var(--fs-card-px)",
    border: "none",
  },
  inset: {
    background: "var(--fs-inset)",
    borderRadius: "var(--fs-radius-inset)",
    padding: "0",
    border: "none",
  },
  panel: {
    background: "var(--fs-inset)",
    borderRadius: "var(--fs-radius-panel)",
    padding: "var(--fs-panel-px)",
    border: "1px solid var(--fs-hairline)",
  },
};

/**
 * The one surface primitive. Depth comes from the background step
 * (cream canvas → white card → cream inset), never from a shadow.
 */
export const SoftCard: React.FC<SoftCardProps> = ({
  variant = "card",
  className = "",
  children,
}) => (
  <div
    className={`overflow-hidden ${className}`}
    style={{ ...VARIANTS[variant], color: "var(--fs-ink)" }}
  >
    {children}
  </div>
);
