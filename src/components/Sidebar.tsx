import React from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Cpu,
  FlaskConical,
  History,
  Info,
  Mic,
  Settings as SettingsIcon,
} from "lucide-react";
import HandyTextLogo from "./icons/HandyTextLogo";
import UpdateChecker from "./update-checker";
import { SidebarItem } from "./ui";
import { useSettings } from "../hooks/useSettings";

/** The pages the app sidebar navigates between. Settings is a modal, not a page. */
export type ShellPage =
  | "dictation"
  | "history"
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
    page: "history",
    labelKey: "shell.nav.history",
    icon: <History {...ICON} />,
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
        paddingTop: "14px",
        paddingBottom: "14px",
        background: "var(--fs-canvas)",
      }}
    >
      <div
        className="flex shrink-0 items-center gap-[8px]"
        style={{ height: "28px", paddingInline: "var(--fs-item-px)" }}
      >
        <HandyTextLogo width={26} />
        <span
          className="truncate"
          style={{
            fontFamily: "var(--fs-font-sans)",
            fontSize: "17px",
            fontWeight: 600,
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
        {/* Keeps the update flow reachable now that the footer bar is gone. */}
        <div
          className="mt-[8px] flex items-center"
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
