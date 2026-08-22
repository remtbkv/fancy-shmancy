import React from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings } from "@/bindings";
import { SectionLabel, SettingRow, SoftCard, Toggle } from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { ShortcutInput } from "../ShortcutInput";

/**
 * A heading and the cream card its rows sit in. `SectionLabel` already carries
 * the measured 30px-above / 20px-below rhythm, and `SoftCard variant="inset"`
 * the 12px radius and cream fill, so a page is a list of these.
 */
export const GroupCard: React.FC<{
  title?: string;
  children: React.ReactNode;
}> = ({ title, children }) => (
  <>
    {title && <SectionLabel variant="group">{title}</SectionLabel>}
    <SoftCard variant="inset" className={title ? "" : "mt-0"}>
      {children}
    </SoftCard>
  </>
);

interface ToggleRowProps<K extends keyof AppSettings> {
  settingKey: K;
  title: string;
  /**
   * Only for settings whose title does not say what they do. The reference's
   * toggle rows are single-line; a value line here is the same 86px row it
   * uses for `Microphone`.
   */
  subtitle?: string;
  fallback?: boolean;
  disabled?: boolean;
}

/**
 * Every existing toggle component is the same three lines —
 * `getSetting(key) ?? fallback`, `updateSetting(key, next)`,
 * `isUpdating(key)` — wrapped in the old `ToggleSwitch`. This is that shape
 * against the ported `SettingRow` + `Toggle`, so the pages carry no state of
 * their own and nothing about how a setting is stored changes.
 */
export function ToggleRow<K extends keyof AppSettings>({
  settingKey,
  title,
  subtitle,
  fallback = false,
  disabled = false,
}: ToggleRowProps<K>) {
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const checked = (getSetting(settingKey) as boolean | undefined) ?? fallback;

  return (
    <SettingRow title={title} subtitle={subtitle} disabled={disabled}>
      <Toggle
        checked={checked}
        // The key is a boolean-valued one by construction at every call site;
        // the generic cannot express "this K's value type is boolean" without
        // widening `updateSetting`, which is shared with the old pages.
        onChange={(next) =>
          void updateSetting(settingKey, next as AppSettings[K])
        }
        disabled={disabled || isUpdating(settingKey)}
        label={title}
      />
    </SettingRow>
  );
}

/**
 * One keyboard binding. The current combination is the row's control — an
 * orange keycap that starts recording when clicked — and the value line says
 * what the binding does, so the shortcut is shown exactly once.
 *
 * Recording itself is untouched: `ShortcutInput` still picks the Tauri or
 * handy-keys implementation and both keep their own capture, suspend/resume
 * and commit logic; `chrome="none"` only drops their old container.
 */
export const ShortcutRow: React.FC<{
  shortcutId: string;
  hintKey: string;
  disabled?: boolean;
}> = ({ shortcutId, hintKey, disabled = false }) => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const binding = (getSetting("bindings") || {})[shortcutId];

  return (
    <SettingRow
      title={t(
        `settings.general.shortcut.bindings.${shortcutId}.name`,
        binding?.name ?? shortcutId,
      )}
      subtitle={t(hintKey)}
      disabled={disabled}
    >
      <ShortcutInput
        shortcutId={shortcutId}
        chrome="none"
        disabled={disabled}
      />
    </SettingRow>
  );
};
