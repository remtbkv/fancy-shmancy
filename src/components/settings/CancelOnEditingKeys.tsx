import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface CancelOnEditingKeysProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const CancelOnEditingKeys: React.FC<CancelOnEditingKeysProps> =
  React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("cancel_on_editing_keys") ?? true;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(next) => updateSetting("cancel_on_editing_keys", next)}
        isUpdating={isUpdating("cancel_on_editing_keys")}
        label={t("settings.general.cancelOnEditingKeys.label")}
        description={t("settings.general.cancelOnEditingKeys.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  });
