import React from "react";
import { useTranslation } from "react-i18next";
import { formatKeyCombination, type OSType } from "@/lib/utils/keyboard";

interface KeycapPillProps {
  /** Raw binding as stored in settings, e.g. `option_left+shift+space`. */
  shortcut: string;
  /**
   * `lg` is the measured size — it sits inline in the 24px greeting line.
   * `sm` scales it to body text for use inside a row; that size is derived,
   * not measured, since the reference only ever shows the large one.
   */
  size?: "lg" | "sm";
  /** The reference's greeting ends the pill with an arrow: "⌘ Cmd →". */
  showArrow?: boolean;
  className?: string;
}

/** A symbol, not translatable copy — kept out of JSX so the i18n lint agrees. */
const ARROW = "→";

const isMacOS = (): boolean => {
  const platform = document.documentElement.dataset.platform;
  return platform ? platform === "macos" : /mac/i.test(navigator.userAgent);
};

const SIZES = {
  lg: {
    height: "35px",
    fontSize: "var(--fs-text-title)",
    paddingInline: "12px",
  },
  sm: { height: "24px", fontSize: "var(--fs-text-body)", paddingInline: "8px" },
} as const;

/**
 * Renders the shortcut the user has actually configured, in the reference's
 * orange keycap: `--fs-keycap` fill, a 1px ink border, 6px radius, and on
 * macOS the modifier symbol ahead of its short name.
 *
 * Neither bundled face carries ⌘ ⌥ ⇧ ⌃, so those glyphs come from the
 * `system-ui` fallback in `--fs-font-sans`.
 */
export const KeycapPill: React.FC<KeycapPillProps> = ({
  shortcut,
  size = "lg",
  showArrow = false,
  className = "",
}) => {
  const { t } = useTranslation();
  const mac = isMacOS();
  const osType: OSType = mac ? "macos" : "windows";

  const modifiers: Record<string, { symbol?: string; label: string }> = mac
    ? {
        command: { symbol: "⌘", label: t("keycap.cmd") },
        meta: { symbol: "⌘", label: t("keycap.cmd") },
        option: { symbol: "⌥", label: t("keycap.opt") },
        alt: { symbol: "⌥", label: t("keycap.opt") },
        shift: { symbol: "⇧", label: t("keycap.shift") },
        ctrl: { symbol: "⌃", label: t("keycap.ctrl") },
      }
    : {
        super: { label: t("keycap.super") },
        meta: { label: t("keycap.win") },
        win: { label: t("keycap.win") },
        alt: { label: t("keycap.alt") },
        option: { label: t("keycap.alt") },
        shift: { label: t("keycap.shift") },
        ctrl: { label: t("keycap.ctrl") },
      };

  const parts = shortcut
    .split("+")
    .map((raw) => raw.trim().replace(/_(left|right)$/, ""))
    .filter(Boolean)
    .map((key) => {
      const modifier = modifiers[key];
      if (modifier) {
        return modifier.symbol
          ? `${modifier.symbol} ${modifier.label}`
          : modifier.label;
      }
      return formatKeyCombination(key, osType);
    });

  if (parts.length === 0) {
    return null;
  }

  return (
    <span
      className={`inline-flex items-center gap-[8px] rounded-[var(--fs-radius-item)]
        border align-middle whitespace-nowrap ${className}`}
      style={{
        ...SIZES[size],
        background: "var(--fs-keycap)",
        borderColor: "var(--fs-keycap-border)",
        color: "var(--fs-keycap-border)",
        fontFamily: "var(--fs-font-sans)",
        fontWeight: 600,
      }}
    >
      {parts.join(" ")}
      {showArrow && <span aria-hidden>{ARROW}</span>}
    </span>
  );
};
