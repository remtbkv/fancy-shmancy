import React from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Cpu,
  FlaskConical,
  Info,
  Mic,
  Settings as SettingsIcon,
} from "lucide-react";
import HandyTextLogo from "./icons/HandyTextLogo";
import UpdateChecker from "./update-checker";
import { SidebarItem } from "./ui";
import { useSettings } from "../hooks/useSettings";

/**
 * The pages the app sidebar navigates between. Settings is a modal, not a page,
 * and history is not a page either — the dictation page *is* the history.
 */
export type ShellPage =
  | "dictation"
  | "dictionary"
  | "models"
  | "about"
  | "debug";

interface SidebarProps {
  activePage: ShellPage;
  onNavigate: (page: ShellPage) => void;
  onOpenSettings: () => void;
}

/** Wispr's icons are drawn light; lucide's default stroke reads far heavier. */
const ICON = { size: 18, strokeWidth: 1.5 } as const;

const NAV: { page: ShellPage; labelKey: string; icon: React.ReactNode }[] = [
  {
    page: "dictation",
    labelKey: "shell.nav.dictation",
    icon: <Mic {...ICON} />,
  },
  {
    page: "dictionary",
    labelKey: "shell.nav.dictionary",
    icon: <BookOpen {...ICON} />,
  },
  { page: "models", labelKey: "shell.nav.models", icon: <Cpu {...ICON} /> },
];

/**
 * 216 wide on the cream canvas: wordmark, the four pages, then the utility
 * group pinned to the bottom. Items are 192x36 inset 12 from each edge and
 * repeat at a 40 pitch (`SidebarItem` carries the 4px gap).
 *
 * Debug only appears once Cmd/Ctrl+Shift+D has switched it on, which is where
 * the plan leaves it.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  activePage,
  onNavigate,
  onOpenSettings,
}) => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const debugEnabled = settings?.debug_mode ?? false;

  return (
    <nav
      className="flex h-full shrink-0 flex-col"
      style={{
        width: "var(--fs-sidebar-w)",
        paddingInline: "var(--fs-sidebar-inset)",
        // The wordmark clears the traffic lights, which puts the first nav item
        // at the measured 123 css below the window top (14 + 53 + the 28px
        // wordmark row + the 28px gap under it).
        paddingTop: "calc(var(--fs-titlebar-h) + 14px)",
        paddingBottom: "14px",
        background: "var(--fs-canvas)",
      }}
    >
      {/* The lockup is the mark, not a bullet beside a word: 67 held up in a
          pair of hands, at 84 across, with the name set under it. The reference
          puts a small glyph next to its wordmark, but its glyph is a logotype
          and ours is a joke — it only works at a size you can read it at. */}
      <div
        className="flex shrink-0 flex-col items-start"
        style={{ paddingInline: "var(--fs-item-px)" }}
      >
        <HandyTextLogo width={84} className="-ms-[4px]" />
        <span
          className="mt-[8px] truncate"
          style={{
            fontFamily: "var(--fs-font-sans)",
            fontSize: "20px",
            fontWeight: 600,
            letterSpacing: "-0.01em",
            color: "var(--fs-ink)",
          }}
        >
          {t("shell.appName")}
        </span>
      </div>

      <div className="mt-[28px] flex flex-col">
        {NAV.map((item) => (
          <SidebarItem
            key={item.page}
            icon={item.icon}
            label={t(item.labelKey)}
            selected={activePage === item.page}
            onClick={() => onNavigate(item.page)}
          />
        ))}
      </div>

      <div className="mt-auto flex flex-col">
        {debugEnabled && (
          <SidebarItem
            icon={<FlaskConical {...ICON} />}
            label={t("shell.nav.debug")}
            selected={activePage === "debug"}
            onClick={() => onNavigate("debug")}
          />
        )}
        <SidebarItem
          icon={<SettingsIcon {...ICON} />}
          label={t("shell.nav.settings")}
          onClick={onOpenSettings}
        />
        <SidebarItem
          icon={<Info {...ICON} />}
          label={t("shell.nav.about")}
          selected={activePage === "about"}
          onClick={() => onNavigate("about")}
        />
        {/* Keeps the update flow reachable now that the footer bar is gone.
            `empty:hidden` because UpdateChecker renders nothing when there is
            no update to report — a permanent line at the sidebar's foot is
            chrome that never changes and so says nothing. */}
        <div
          className="mt-[8px] flex items-center empty:hidden"
          style={{
            paddingInline: "var(--fs-item-px)",
            fontSize: "var(--fs-text-label)",
            color: "var(--fs-ink-muted)",
          }}
        >
          <UpdateChecker />
        </div>
      </div>
    </nav>
  );
};
