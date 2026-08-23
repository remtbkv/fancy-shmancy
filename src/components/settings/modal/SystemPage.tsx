import React from "react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
import type { OverlayPosition, OverlayStyle, SoundTheme } from "@/bindings";
import { SettingRow } from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { useSettingsStore } from "@/stores/settingsStore";
import { FieldSelect, IconAction, RangeField } from "./controls";
import { GroupCard, ToggleRow } from "./rows";

/** Bundled themes; `custom` only appears once both files are on disk. */
const SOUND_THEME_LABELS: Record<SoundTheme, string> = {
  marimba: "Marimba",
  pop: "Pop",
  custom: "Custom",
};

/**
 * How the app behaves as part of the desktop: launch, window, tray, overlay,
 * sound and updates. The reference's System page, minus its notification
 * section (we have none).
 */
export const SystemPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    getSetting,
    updateSetting,
    isUpdating,
    outputDevices,
    refreshOutputDevices,
    isLoading,
  } = useSettings();
  const playTestSound = useSettingsStore((state) => state.playTestSound);
  const customSounds = useSettingsStore((state) => state.customSounds);

  // Two choices: off, or the live panel. `minimal` was retired — Rust migrates
  // a stored one to `live` on load, and this fold covers the frame before that
  // reaches the UI.
  const storedOverlayStyle = getSetting("overlay_style");
  const overlayStyle: OverlayStyle =
    storedOverlayStyle === "none" ? "none" : "live";
  // Only top and bottom are selectable; a legacy "none" position reads as
  // bottom, exactly as the old selector resolved it.
  const overlayPosition: OverlayPosition =
    getSetting("overlay_position") === "top" ? "top" : "bottom";
  const audioFeedback = getSetting("audio_feedback") ?? false;
  const soundTheme = (getSetting("sound_theme") ?? "marimba") as SoundTheme;
  const volume = getSetting("audio_feedback_volume") ?? 0.5;
  const outputDevice =
    getSetting("selected_output_device") === "default"
      ? "Default"
      : getSetting("selected_output_device") || "Default";

  const overlayStyleOptions: { value: OverlayStyle; label: string }[] = [
    { value: "none", label: t("settings.advanced.overlay.style.options.none") },
    { value: "live", label: t("settings.advanced.overlay.style.options.live") },
  ];
  const overlayPositionOptions: { value: OverlayPosition; label: string }[] = [
    {
      value: "bottom",
      label: t("settings.advanced.overlay.position.options.bottom"),
    },
    {
      value: "top",
      label: t("settings.advanced.overlay.position.options.top"),
    },
  ];
  const soundThemeOptions = (
    customSounds.start && customSounds.stop
      ? (["marimba", "pop", "custom"] as SoundTheme[])
      : (["marimba", "pop"] as SoundTheme[])
  ).map((value) => ({ value, label: SOUND_THEME_LABELS[value] }));

  return (
    <>
      <GroupCard title={t("settings.modal.groups.appSettings")}>
        <ToggleRow
          settingKey="autostart_enabled"
          title={t("settings.advanced.autostart.label")}
        />
        <ToggleRow
          settingKey="start_hidden"
          title={t("settings.advanced.startHidden.label")}
          subtitle={t("settings.advanced.startHidden.description")}
        />
        <ToggleRow
          settingKey="show_tray_icon"
          title={t("settings.advanced.showTrayIcon.label")}
          fallback
        />
        <SettingRow
          title={t("settings.advanced.overlay.style.title")}
          subtitle={
            overlayStyleOptions.find((option) => option.value === overlayStyle)
              ?.label ?? ""
          }
        >
          <FieldSelect
            options={overlayStyleOptions}
            value={overlayStyle}
            onSelect={(value) =>
              void updateSetting("overlay_style", value as OverlayStyle)
            }
            disabled={isUpdating("overlay_style")}
          />
        </SettingRow>
        {overlayStyle !== "none" && (
          <SettingRow
            title={t("settings.advanced.overlay.position.title")}
            subtitle={
              overlayPositionOptions.find(
                (option) => option.value === overlayPosition,
              )?.label ?? ""
            }
          >
            <FieldSelect
              options={overlayPositionOptions}
              value={overlayPosition}
              onSelect={(value) =>
                void updateSetting("overlay_position", value as OverlayPosition)
              }
              disabled={isUpdating("overlay_position")}
            />
          </SettingRow>
        )}
      </GroupCard>

      <GroupCard title={t("settings.sound.title")}>
        <ToggleRow
          settingKey="audio_feedback"
          title={t("settings.sound.audioFeedback.label")}
        />
        <SettingRow
          title={t("settings.debug.soundTheme.label")}
          subtitle={SOUND_THEME_LABELS[soundTheme]}
          disabled={!audioFeedback}
        >
          <div className="flex items-center gap-[8px]">
            <FieldSelect
              options={soundThemeOptions}
              value={soundTheme}
              onSelect={(value) =>
                void updateSetting("sound_theme", value as SoundTheme)
              }
              disabled={!audioFeedback}
            />
            <IconAction
              onClick={() => {
                void playTestSound("start").then(() => playTestSound("stop"));
              }}
              label={t("settings.modal.rows.previewSound")}
              disabled={!audioFeedback}
            >
              <Play size={14} aria-hidden />
            </IconAction>
          </div>
        </SettingRow>
        <SettingRow
          title={t("settings.sound.outputDevice.title")}
          subtitle={outputDevice}
          disabled={!audioFeedback}
        >
          <FieldSelect
            wide
            options={outputDevices.map((device) => ({
              value: device.name,
              label: device.name,
            }))}
            value={outputDevice}
            placeholder={t("settings.sound.outputDevice.loading")}
            onOpen={() => void refreshOutputDevices()}
            onSelect={(value) =>
              void updateSetting("selected_output_device", value)
            }
            disabled={
              !audioFeedback ||
              isUpdating("selected_output_device") ||
              isLoading ||
              outputDevices.length === 0
            }
          />
        </SettingRow>
        <SettingRow
          title={t("settings.sound.volume.title")}
          subtitle={t("settings.modal.rows.percent", {
            value: Math.round(volume * 100),
          })}
          disabled={!audioFeedback}
        >
          <RangeField
            value={volume}
            onChange={(next) =>
              void updateSetting("audio_feedback_volume", next)
            }
            disabled={!audioFeedback}
            label={t("settings.sound.volume.title")}
          />
        </SettingRow>
        <ToggleRow
          settingKey="pause_playback_while_recording"
          title={t("settings.sound.pausePlaybackWhileRecording.label")}
          subtitle={t("settings.modal.hints.pausePlayback")}
          fallback
        />
      </GroupCard>

      <GroupCard title={t("settings.modal.groups.updates")}>
        <ToggleRow
          settingKey="update_checks_enabled"
          title={t("settings.debug.updateChecks.label")}
          fallback
        />
      </GroupCard>
    </>
  );
};
