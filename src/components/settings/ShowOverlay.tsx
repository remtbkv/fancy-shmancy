import React from "react";
import { useTranslation } from "react-i18next";
import { Dropdown } from "../ui/Dropdown";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import type { OverlayPosition, OverlayStyle } from "@/bindings";

interface ShowOverlayProps {
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}

export const ShowOverlay: React.FC<ShowOverlayProps> = React.memo(
  ({ descriptionMode = "tooltip", grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();

    // "minimal" is not offered: the pill was a worse Live, so the choice is
    // whether there is an overlay at all. The variant survives in Rust for old
    // stores, which the settings migration folds onto "live" on load.
    const styleOptions = [
      {
        value: "none",
        label: t("settings.advanced.overlay.style.options.none"),
      },
      {
        value: "live",
        label: t("settings.advanced.overlay.style.options.live"),
      },
    ];

    const positionOptions = [
      {
        value: "bottom",
        label: t("settings.advanced.overlay.position.options.bottom"),
      },
      {
        value: "top",
        label: t("settings.advanced.overlay.position.options.top"),
      },
    ];

    // A store that still says "minimal" reads as Live here, matching what the
    // backend will have written by the time this renders.
    const stored = getSetting("overlay_style");
    const selectedStyle: OverlayStyle = stored === "none" ? "none" : "live";
    // Only "top" and "bottom" are selectable; anything else (empty, or a legacy
    // "none" from before the position was retired) falls back to "bottom".
    const selectedPosition: OverlayPosition =
      getSetting("overlay_position") === "top" ? "top" : "bottom";

    return (
      <>
        <SettingContainer
          title={t("settings.advanced.overlay.style.title")}
          description={t("settings.advanced.overlay.style.description")}
          descriptionMode={descriptionMode}
          grouped={grouped}
        >
          <Dropdown
            options={styleOptions}
            selectedValue={selectedStyle}
            onSelect={(value) =>
              updateSetting("overlay_style", value as OverlayStyle)
            }
            disabled={isUpdating("overlay_style")}
          />
        </SettingContainer>

        {selectedStyle !== "none" && (
          <SettingContainer
            title={t("settings.advanced.overlay.position.title")}
            description={t("settings.advanced.overlay.position.description")}
            descriptionMode={descriptionMode}
            grouped={grouped}
          >
            <Dropdown
              options={positionOptions}
              selectedValue={selectedPosition}
              onSelect={(value) =>
                updateSetting("overlay_position", value as OverlayPosition)
              }
              disabled={isUpdating("overlay_position")}
            />
          </SettingContainer>
        )}
      </>
    );
  },
);
