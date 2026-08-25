import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { SettingContainer } from "../ui/SettingContainer";
import { MiddleTruncate } from "../ui/MiddleTruncate";
import { commands } from "@/bindings";

/**
 * Where recordings land. The default is inside the app's data directory, which
 * is a path most people would never find and cannot back up deliberately — so
 * it is a choice rather than a fact about the app.
 */
export const RecordingsFolder: React.FC<{
  descriptionMode?: "inline" | "tooltip";
  grouped?: boolean;
}> = React.memo(({ descriptionMode = "tooltip", grouped = false }) => {
  const { t } = useTranslation();
  const [dir, setDir] = useState<string>("");

  const refresh = useCallback(() => {
    commands.getRecordingsDir().then((r) => {
      if (r.status === "ok") setDir(r.data);
    });
  }, []);
  useEffect(refresh, [refresh]);

  const choose = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    const r = await commands.setRecordingsDir(picked);
    if (r.status === "ok") setDir(r.data);
  };

  const reset = async () => {
    const r = await commands.setRecordingsDir("");
    if (r.status === "ok") setDir(r.data);
  };

  return (
    <SettingContainer
      title={t("settings.debug.recordingsFolder.title")}
      description={t("settings.debug.recordingsFolder.description")}
      descriptionMode={descriptionMode}
      grouped={grouped}
      layout="horizontal"
    >
      {/* The path is the only part of this row that can give up width, so it is
          the only part allowed to shrink — the two buttons stay whole and
          inside the card however deep the chosen folder is. */}
      <div className="flex items-center gap-2 min-w-0">
        <MiddleTruncate text={dir} className="text-xs text-mid-gray" />
        <button
          type="button"
          onClick={choose}
          className="shrink-0 px-2 py-1 text-sm rounded border border-mid-gray/30 hover:bg-mid-gray/10 transition-colors"
        >
          {t("settings.debug.recordingsFolder.choose")}
        </button>
        <button
          type="button"
          onClick={reset}
          className="shrink-0 px-2 py-1 text-sm rounded text-text/60 hover:text-text transition-colors"
        >
          {t("settings.debug.recordingsFolder.reset")}
        </button>
      </div>
    </SettingContainer>
  );
});
