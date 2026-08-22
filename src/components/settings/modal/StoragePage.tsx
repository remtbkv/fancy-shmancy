import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { commands } from "@/bindings";
import { PillButton, SettingRow } from "@/components/ui";
import { useSettings } from "@/hooks/useSettings";
import { NumberField } from "./controls";
import { GroupCard } from "./rows";

const GB = 1_000_000_000;
const MIN_WINDOW_MINUTES = 1;
const MAX_WINDOW_MINUTES = 1440;

const formatBytes = (bytes: number): string =>
  bytes >= GB
    ? `${(bytes / GB).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;

/**
 * What the app keeps on disk. The cap's value line is the measured usage, not
 * a restatement of the number in the field — a cap means nothing without what
 * it currently holds and what an hour of talking costs.
 */
export const StoragePage: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting, updateSetting, isUpdating } = useSettings();
  const [usage, setUsage] = useState<{
    used: number;
    perHour: number;
    hours: number;
  } | null>(null);
  const [dir, setDir] = useState("");

  const limitGb = Number(getSetting("recording_storage_limit_gb") ?? 5);
  const windowSecs = getSetting("paste_last_transcript_window_secs") ?? 300;

  const refreshUsage = useCallback(() => {
    commands
      .getRecordingStorageUsage()
      .then((result) => {
        if (result.status === "ok") {
          setUsage({
            used: result.data.bytes_used,
            perHour: result.data.bytes_per_hour,
            hours: result.data.hours_recorded,
          });
        }
      })
      .catch(() => undefined);
  }, []);

  const refreshDir = useCallback(() => {
    commands
      .getRecordingsDir()
      .then((result) => {
        if (result.status === "ok") setDir(result.data);
      })
      .catch(() => undefined);
  }, []);

  useEffect(refreshUsage, [refreshUsage]);
  useEffect(refreshDir, [refreshDir]);

  const capacityHours =
    usage && usage.perHour > 0 ? (limitGb * GB) / usage.perHour : null;

  const chooseDir = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    const result = await commands.setRecordingsDir(picked);
    if (result.status === "ok") setDir(result.data);
  };

  const resetDir = async () => {
    const result = await commands.setRecordingsDir("");
    if (result.status === "ok") setDir(result.data);
  };

  return (
    <>
      <GroupCard title={t("settings.modal.groups.recordings")}>
        <SettingRow
          title={t("settings.debug.recordingStorage.title")}
          subtitle={
            usage
              ? t("settings.modal.rows.storageUsage", {
                  used: formatBytes(usage.used),
                  hours: usage.hours.toFixed(1),
                  perHour: formatBytes(usage.perHour),
                  capacity: capacityHours ? Math.round(capacityHours) : "—",
                })
              : t("common.loading")
          }
        >
          <NumberField
            value={limitGb}
            unit={t("settings.debug.recordingStorage.gigabytes")}
            min={0.5}
            max={500}
            step={0.5}
            decimals={1}
            disabled={isUpdating("recording_storage_limit_gb")}
            onCommit={(next) => {
              void updateSetting("recording_storage_limit_gb", next)
                .then(() => commands.updateRecordingStorageLimit(next))
                .then(refreshUsage);
            }}
          />
        </SettingRow>
        <SettingRow
          title={t("settings.debug.recordingsFolder.title")}
          subtitle={dir}
        >
          <div className="flex items-center gap-[8px]">
            <PillButton onClick={() => void chooseDir()}>
              {t("settings.modal.rows.change")}
            </PillButton>
            <PillButton onClick={() => void resetDir()}>
              {t("settings.debug.recordingsFolder.reset")}
            </PillButton>
          </div>
        </SettingRow>
      </GroupCard>

      <GroupCard title={t("settings.general.pasteLastTranscript.title")}>
        <SettingRow
          title={t("settings.general.pasteLastTranscriptWindow.title")}
          subtitle={t("settings.modal.hints.pasteWindow")}
        >
          <NumberField
            value={Math.round(windowSecs / 60)}
            unit={t("settings.general.pasteLastTranscriptWindow.minutes")}
            min={MIN_WINDOW_MINUTES}
            max={MAX_WINDOW_MINUTES}
            disabled={isUpdating("paste_last_transcript_window_secs")}
            onCommit={(next) =>
              void updateSetting("paste_last_transcript_window_secs", next * 60)
            }
          />
        </SettingRow>
      </GroupCard>
    </>
  );
};
