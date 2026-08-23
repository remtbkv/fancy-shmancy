import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { HardDrive, Monitor, SlidersHorizontal, Wrench } from "lucide-react";
import { SectionLabel, SidebarItem } from "@/components/ui";
import { AdvancedPage } from "./modal/AdvancedPage";
import { GeneralPage } from "./modal/GeneralPage";
import { StoragePage } from "./modal/StoragePage";
import { SystemPage } from "./modal/SystemPage";

export type SettingsPage = "general" | "system" | "storage" | "advanced";

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  initialPage?: SettingsPage;
}

const PAGES: {
  id: SettingsPage;
  titleKey: string;
  icon: React.ReactNode;
  Component: React.FC;
}[] = [
  {
    id: "general",
    titleKey: "settings.general.title",
    icon: <SlidersHorizontal size={18} aria-hidden />,
    Component: GeneralPage,
  },
  {
    id: "system",
    titleKey: "settings.modal.pages.system",
    icon: <Monitor size={18} aria-hidden />,
    Component: SystemPage,
  },
  {
    id: "storage",
    titleKey: "settings.modal.pages.storage",
    icon: <HardDrive size={18} aria-hidden />,
    Component: StoragePage,
  },
  {
    id: "advanced",
    titleKey: "sidebar.advanced",
    icon: <Wrench size={18} aria-hidden />,
    Component: AdvancedPage,
  },
];

/**
 * Settings as a modal over the app, per the reference's screenshot 2.
 *
 * Geometry is the measured set: a 960x640 sheet at a 12px radius, a 208px
 * cream mini-sidebar with a hairline divider, 36px nav items that touch, the
 * app version pinned 21px above the sheet's bottom edge, and a 48px content
 * pane whose page title is the one place the serif is used.
 *
 * Motion keeps MOTION.md's grammar — scrim and sheet arrive together with
 * their content already laid out, nothing slides, a page swap is an instant
 * replacement, and dismissal is far quicker than arrival — but the enter runs
 * at `--fs-enter-surface` on a real deceleration curve rather than the 80ms
 * measured off the reference, because at 80ms the scale never registers and
 * the sheet reads as popping. On close the sheet is removed at once and only
 * the scrim fades, over `--fs-exit`.
 */
const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  initialPage = "general",
}) => {
  const { t } = useTranslation();
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [version, setVersion] = useState("");
  // `mounted` outlives `open` by the exit fade; `shown` drives the transition
  // itself, once the browser has actually painted a state to animate from.
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  // A fresh open lands on the page the caller asked for.
  useEffect(() => {
    if (open) setPage(initialPage);
  }, [open, initialPage]);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames, not one. A single rAF callback can land in the same frame
      // that first paints the sheet, so the browser never sees the opacity-0 /
      // scale-0.98 state as a start value and skips the transition outright —
      // which is the abruptness, not the duration. Waiting for the frame after
      // the paint guarantees there is something to animate from.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), 30);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    sheetRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An open select owns Escape first — it closes its own menu.
      if (document.querySelector("[data-fs-menu-open]")) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!mounted) return null;

  const active = PAGES.find((entry) => entry.id === page) ?? PAGES[0];
  const ActivePage = active.Component;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        aria-hidden
        onClick={onClose}
        className="absolute inset-0"
        style={{
          background: "var(--fs-scrim)",
          opacity: shown ? 1 : 0,
          transitionProperty: "opacity",
          transitionTimingFunction: "var(--fs-ease-out)",
          transitionDuration: shown
            ? "var(--fs-enter-surface)"
            : "var(--fs-exit)",
        }}
      />

      {open && (
        <div
          ref={sheetRef}
          role="dialog"
          aria-modal="true"
          aria-label={t("settings.modal.title")}
          tabIndex={-1}
          className="relative flex overflow-hidden outline-none"
          style={{
            width: "var(--fs-modal-w)",
            height: "var(--fs-modal-h)",
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "calc(100vh - 32px)",
            borderRadius: "var(--fs-radius-modal)",
            background: "var(--fs-modal)",
            // Estimated from the reference's edge gradient over an already
            // scrimmed backdrop — see MEASUREMENTS.md, which labels it approximate.
            boxShadow: "0 8px 40px rgba(0, 0, 0, 0.10)",
            opacity: shown ? 1 : 0,
            // 0.965 rather than the reference's 0.98: over a 155ms travel a 2%
            // scale is still too small to read as movement, and 3.5% on a
            // 960px sheet is 34px of width — visible, and nowhere near a zoom.
            transform: shown ? "scale(1)" : "scale(0.965)",
            transitionProperty: "opacity, transform",
            transitionTimingFunction: "var(--fs-ease-out)",
            transitionDuration: "var(--fs-enter-surface)",
          }}
        >
          <nav
            className="flex shrink-0 flex-col"
            style={{
              // 208 of cream plus the 1px divider, which border-box would
              // otherwise eat: the reference's cream runs 554-969 native and
              // the divider sits at 970-971, so the pane starts at 209 and its
              // card measures 655, not 656.
              width: "calc(var(--fs-modal-sidebar-w) + 1px)",
              background: "var(--fs-canvas)",
              borderRight: "1px solid var(--fs-hairline)",
              paddingTop: "19px",
              paddingBottom: "21px",
              paddingInline: "8px",
            }}
          >
            <SectionLabel
              variant="eyebrow"
              className="mb-[16px] px-[var(--fs-item-px)]"
            >
              {t("settings.modal.title")}
            </SectionLabel>
            {PAGES.map((entry) => (
              <SidebarItem
                key={entry.id}
                dense
                icon={entry.icon}
                label={t(entry.titleKey)}
                selected={entry.id === page}
                onClick={() => setPage(entry.id)}
              />
            ))}
            <span
              className="mt-auto truncate px-[var(--fs-item-px)]"
              style={{
                fontFamily: "var(--fs-font-sans)",
                fontSize: "var(--fs-text-label)",
                color: "var(--fs-ink-muted)",
              }}
            >
              {version ? t("settings.modal.version", { version }) : ""}
            </span>
          </nav>

          {/* Remounting on the page id resets the pane's scroll, which is what
              an instant content replacement does. */}
          <div
            key={page}
            className="min-w-0 flex-1 overflow-y-auto"
            style={{ padding: "var(--fs-modal-px)" }}
          >
            <h1
              className="relative mb-[30px]"
              style={{
                fontFamily: "var(--fs-font-serif)",
                fontSize: "var(--fs-text-title-serif)",
                fontWeight: 400,
                lineHeight: 1.2,
                // EB Garamond's ascent runs 1.5px deeper than the reference
                // face at 28px, which put the cap top at 54.5 below the modal
                // edge against a measured 53. Painted offset only, so the
                // heading under it keeps its measured 117.5.
                top: "-1.5px",
                color: "var(--fs-ink)",
              }}
            >
              {t(active.titleKey)}
            </h1>
            <ActivePage />
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsModal;
