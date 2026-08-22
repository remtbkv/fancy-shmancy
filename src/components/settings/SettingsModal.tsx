import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import {
  Cpu,
  HardDrive,
  Monitor,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { SectionLabel, SidebarItem } from "@/components/ui";
import { AdvancedPage } from "./modal/AdvancedPage";
import { GeneralPage } from "./modal/GeneralPage";
import { ModelsPage } from "./modal/ModelsPage";
import { StoragePage } from "./modal/StoragePage";
import { SystemPage } from "./modal/SystemPage";

export type SettingsPage =
  | "general"
  | "system"
  | "models"
  | "storage"
  | "advanced";

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
    id: "models",
    titleKey: "sidebar.models",
    icon: <Cpu size={18} aria-hidden />,
    Component: ModelsPage,
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
 * Motion follows MOTION.md exactly: scrim and sheet fade in together over
 * 80ms with a 0.98 -> 1.00 scale and their content already laid out; on close
 * the sheet is removed at once and only the scrim fades, over 30ms. Nothing
 * slides, and a page swap is an instant content replacement.
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
  // itself, one frame after mount so the browser has a state to animate from.
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
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
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
          transitionTimingFunction: "ease-out",
          transitionDuration: shown ? "var(--fs-enter)" : "var(--fs-exit)",
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
            transform: shown ? "scale(1)" : "scale(0.98)",
            transitionProperty: "opacity, transform",
            transitionTimingFunction: "ease-out",
            transitionDuration: "var(--fs-enter)",
          }}
        >
          <nav
            className="flex shrink-0 flex-col"
            style={{
              width: "var(--fs-modal-sidebar-w)",
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
              className="mb-[30px]"
              style={{
                fontFamily: "var(--fs-font-serif)",
                fontSize: "var(--fs-text-title-serif)",
                fontWeight: 400,
                lineHeight: 1.2,
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
