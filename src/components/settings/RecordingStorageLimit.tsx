import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../ui/Input";
import { SettingContainer } from "../ui/SettingContainer";
import { useSettings } from "../../hooks/useSettings";
import { commands } from "@/bindings";

const GB = 1_000_000_000;

const formatBytes = (bytes: number): string =>
  bytes >= GB
    ? `${(bytes / GB).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;

/**
 * The only retention control: how much disk the recordings may use. Age is the
 * wrong axis for dictation — a month-old take is no less useful than
 * yesterday's — so nothing is deleted for being old, only for being the oldest
 * thing still over budget.
 *
 * The figures to the left are measured from the audio actually kept rather than
 * derived from the sample format, so they already account for the silence the
 * VAD strips. A cap means nothing without them.
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

  const handleChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const next = parseFloat(event.target.value);
    if (!Number.isFinite(next) || next <= 0) return;
    await updateSetting("recording_storage_limit_gb", next);
    await commands.updateRecordingStorageLimit(next);
    refresh();
  };

  // What the cap buys, at the rate this user's speech is actually written.
  const capacityHours =
    usage && usage.perHour > 0 ? (limitGb * GB) / usage.perHour : null;

  return (
    <SettingContainer
      title={t("settings.debug.recordingStorage.title")}
      description={t("settings.debug.recordingStorage.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
    >
      <div className="flex items-center gap-3">
        {usage && (
          <span className="text-xs text-mid-gray text-right leading-tight">
            {t("settings.debug.recordingStorage.usedNow", {
              used: formatBytes(usage.used),
              hours: usage.hours.toFixed(1),
            })}
            <br />
            {t("settings.debug.recordingStorage.rate", {
              perHour: formatBytes(usage.perHour),
              capacity: capacityHours ? Math.round(capacityHours) : "—",
            })}
          </span>
        )}
        <Input
          type="number"
          min="0.5"
          max="500"
          step="0.5"
          value={limitGb}
          onChange={handleChange}
          disabled={isUpdating("recording_storage_limit_gb")}
          className="w-20"
        />
        <span className="text-sm text-text">
          {t("settings.debug.recordingStorage.gigabytes")}
        </span>
      </div>
    </SettingContainer>
  );
});
