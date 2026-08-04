import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";

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

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(event.target.value, 10);
    if (!isNaN(value) && value >= 0) {
      updateSetting("editing_cancel_grace_ms", value);
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
          min="0"
          max="2000"
          step="50"
          value={graceMs}
          onChange={handleChange}
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
