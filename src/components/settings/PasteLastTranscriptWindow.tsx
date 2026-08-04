import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";

interface PasteLastTranscriptWindowProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

/**
 * How recent the last transcript has to be for the paste-last-transcript
 * shortcut to paste it. Past that the shortcut behaves as an ordinary paste.
 */
export const PasteLastTranscriptWindow: React.FC<
  PasteLastTranscriptWindowProps
> = ({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const windowSecs = getSetting("paste_last_transcript_window_secs") ?? 300;

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const minutes = parseFloat(event.target.value);
    if (!isNaN(minutes) && minutes >= 0) {
      updateSetting(
        "paste_last_transcript_window_secs",
        Math.round(minutes * 60),
      );
    }
  };

  return (
    <SettingContainer
      title={t("settings.general.pasteLastTranscriptWindow.title")}
      description={t("settings.general.pasteLastTranscriptWindow.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
    >
      <div className="flex items-center space-x-2">
        <Input
          type="number"
          min="0"
          max="1440"
          step="1"
          value={Math.round(windowSecs / 60)}
          onChange={handleChange}
          disabled={isUpdating("paste_last_transcript_window_secs")}
          className="w-20"
        />
        <span className="text-sm text-text">
          {t("settings.general.pasteLastTranscriptWindow.minutes")}
        </span>
      </div>
    </SettingContainer>
  );
};
