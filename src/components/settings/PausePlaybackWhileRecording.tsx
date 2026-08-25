import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface PausePlaybackWhileRecordingProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const PausePlaybackWhileRecording: React.FC<PausePlaybackWhileRecordingProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("pause_playback_while_recording") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(next) =>
          updateSetting("pause_playback_while_recording", next)
        }
        isUpdating={isUpdating("pause_playback_while_recording")}
        label={t("settings.sound.pausePlaybackWhileRecording.label")}
        description={t(
          "settings.sound.pausePlaybackWhileRecording.description",
        )}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  });
