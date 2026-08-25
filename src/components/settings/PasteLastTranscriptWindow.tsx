import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";

/** Where an emptied or out-of-range field lands once you leave it. */
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 1440;

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
  // While the field is being typed in it shows exactly what was typed, empty
  // included. Saving on every keystroke would fight the caret, so the value is
  // only stored on the way out.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const typed = parseInt(draft, 10);
    const minutes = isNaN(typed)
      ? MIN_WINDOW_MINUTES
      : Math.min(Math.max(typed, MIN_WINDOW_MINUTES), MAX_WINDOW_MINUTES);
    setDraft(null);
    if (minutes * 60 !== windowSecs) {
      updateSetting("paste_last_transcript_window_secs", minutes * 60);
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
          min={MIN_WINDOW_MINUTES}
          max={MAX_WINDOW_MINUTES}
          step="1"
          value={draft ?? String(Math.round(windowSecs / 60))}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
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
