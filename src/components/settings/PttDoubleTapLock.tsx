import React from "react";
import { useTranslation } from "react-i18next";
import { ToggleSwitch } from "../ui/ToggleSwitch";
import { useSettings } from "../../hooks/useSettings";

interface PttDoubleTapLockProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const PttDoubleTapLock: React.FC<PttDoubleTapLockProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    const enabled = getSetting("ptt_double_tap_lock") || false;

    return (
      <ToggleSwitch
        checked={enabled}
        onChange={(next) => updateSetting("ptt_double_tap_lock", next)}
        isUpdating={isUpdating("ptt_double_tap_lock")}
        label={t("settings.general.pttDoubleTapLock.label")}
        description={t("settings.general.pttDoubleTapLock.description")}
        descriptionMode={descriptionMode}
        grouped={grouped}
      />
    );
  },
);
