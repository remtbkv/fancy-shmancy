import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";

/** Where an emptied or out-of-range field lands once you leave it. */
const MIN_GRACE_MS = 1;
const MAX_GRACE_MS = 2000;

interface EditingCancelGraceProps {
  descriptionMode?: "tooltip" | "inline";
  grouped?: boolean;
}

/**
 * How long the overlay, the tray icon and the paused music wait before showing
 * up, so a hold that turns out to be an editing chord leaves no trace. Longer
 * catches slower chords; shorter makes the overlay feel more immediate.
 */
export const EditingCancelGrace: React.FC<EditingCancelGraceProps> = ({
  descriptionMode = "tooltip",
  grouped = false,
}) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();

  const graceMs = getSetting("editing_cancel_grace_ms") ?? 250;
  // While the field is being typed in it shows exactly what was typed, empty
  // included. Saving on every keystroke would fight the caret, so the value is
  // only stored on the way out.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const typed = parseInt(draft, 10);
    const ms = isNaN(typed)
      ? MIN_GRACE_MS
      : Math.min(Math.max(typed, MIN_GRACE_MS), MAX_GRACE_MS);
    setDraft(null);
    if (ms !== graceMs) {
      updateSetting("editing_cancel_grace_ms", ms);
    }
  };

  return (
    <SettingContainer
      title={t("settings.general.editingCancelGrace.title")}
      description={t("settings.general.editingCancelGrace.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
    >
      <div className="flex items-center space-x-2">
        <Input
          type="number"
          min={MIN_GRACE_MS}
          max={MAX_GRACE_MS}
          step="50"
          value={draft ?? String(graceMs)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          disabled={isUpdating("editing_cancel_grace_ms")}
          className="w-20"
        />
        <span className="text-sm text-text">
          {t("settings.general.editingCancelGrace.ms")}
        </span>
      </div>
    </SettingContainer>
  );
};
