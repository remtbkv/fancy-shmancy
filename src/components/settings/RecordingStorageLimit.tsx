import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { commands } from "@/bindings";

const GB = 1_000_000_000;

const formatBytes = (bytes: number): string =>
  bytes >= GB
    ? `${(bytes / GB).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;

/**
 * How much disk the kept recordings use, what an hour of talking adds, and the
 * cap. The per-hour figure is measured from the audio actually kept rather than
 * derived from the sample format, so it already accounts for the silence the
 * VAD strips — a number you can plan against instead of a theoretical bitrate.
 */
export const RecordingStorageLimit: React.FC<{
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}> = React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const limitGb = Number(getSetting("recording_storage_limit_gb") ?? 5);
  const [usage, setUsage] = useState<{
    used: number;
    perHour: number;
    hours: number;
  } | null>(null);

  const refresh = useCallback(() => {
    commands.getRecordingStorageUsage().then((r) => {
      if (r.status === "ok") {
        setUsage({
          used: r.data.bytes_used,
          perHour: r.data.bytes_per_hour,
          hours: r.data.hours_recorded,
        });
      }
    });
  }, []);

  useEffect(refresh, [refresh]);

  const onChange = async (next: number) => {
    await updateSetting("recording_storage_limit_gb", next);
    await commands.updateRecordingStorageLimit(next);
    refresh();
  };

  // What the cap buys, at this user's measured rate.
  const capacityHours =
    usage && usage.perHour > 0 ? (limitGb * GB) / usage.perHour : 0;

  return (
    <SettingContainer
      title={t("settings.debug.recordingRetention.storageTitle")}
      description={
        usage
          ? t("settings.debug.recordingRetention.storageUsage", {
              used: formatBytes(usage.used),
              limit: limitGb,
              perHour: formatBytes(usage.perHour),
              hours: Math.round(capacityHours),
            })
          : t("settings.debug.recordingRetention.storageDescription")
      }
      descriptionMode={descriptionMode}
      grouped={grouped}
    >
      <input
        type="number"
        min={0.5}
        max={500}
        step={0.5}
        value={limitGb}
        disabled={isUpdating("recording_storage_limit_gb")}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) void onChange(next);
        }}
        className="w-24 px-2 py-1 rounded border border-mid-gray/30 bg-background text-text text-sm"
      />
    </SettingContainer>
  );
});
