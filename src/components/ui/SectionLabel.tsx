import React from "react";

interface SectionLabelProps {
  /**
   * `eyebrow` — the small-caps marker: `SETTINGS`, `ACCOUNT`,
   * `AUGUST 19, 2026`. 12px, uppercase, 0.08em tracking, muted label ink.
   * `group` — the sentence-case heading that sits above a card on the settings
   * pages: `App settings`, `Sound`. 15px/600 in full ink.
   */
  variant?: "eyebrow" | "group";
  className?: string;
  children: React.ReactNode;
}

/**
 * Measured tracking for the eyebrow: inter-glyph gaps run 4 native px against
 * a ~1.5 native side bearing at a 17 native cap height, i.e. ~0.08em at 12px.
 * The group heading sits 20px above its card, 30px below the previous one.
 */
export const SectionLabel: React.FC<SectionLabelProps> = ({
  variant = "eyebrow",
  className = "",
  children,
}) =>
  variant === "group" ? (
    <h2
      className={`mt-[30px] mb-[20px] first:mt-0 ${className}`}
      style={{
        fontFamily: "var(--fs-font-sans)",
        fontSize: "var(--fs-text-body)",
        fontWeight: 600,
        color: "var(--fs-ink)",
      }}
    >
      {children}
    </h2>
  ) : (
    <div
      className={`uppercase ${className}`}
      style={{
        fontFamily: "var(--fs-font-sans)",
        fontSize: "var(--fs-text-label)",
        fontWeight: 600,
        letterSpacing: "var(--fs-tracking-label)",
        color: "var(--fs-ink-label)",
      }}
    >
      {children}
    </div>
  );
