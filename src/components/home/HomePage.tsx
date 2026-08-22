import React from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/useSettings";
import { KeycapPill } from "../ui";
import { TranscriptList, useTranscripts } from "../history-page";
import { PageShell } from "./PageShell";

const RECENT_PAGE_SIZE = 20;

/**
 * "Dictation": the greeting carrying the shortcut the user has actually bound,
 * then the most recent transcripts. The reference's stats rail and promo banner
 * are features we don't have, so the layout simply compresses.
 */
export const HomePage: React.FC = () => {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const {
    entries,
    loading,
    getAudioUrl,
    toggleSaved,
    retryEntry,
    deleteEntry,
  } = useTranscripts(RECENT_PAGE_SIZE);

  const shortcut = settings?.bindings?.transcribe?.current_binding ?? "";

  const greeting = shortcut ? (
    <h1
      className="flex items-center gap-[14px]"
      style={{
        fontFamily: "var(--fs-font-sans)",
        fontSize: "var(--fs-text-title)",
        fontWeight: 600,
        color: "var(--fs-ink)",
      }}
    >
      {t("shell.home.greeting")}
      <KeycapPill shortcut={shortcut} showArrow />
    </h1>
  ) : (
    <h1
      style={{
        fontFamily: "var(--fs-font-sans)",
        fontSize: "var(--fs-text-title)",
        fontWeight: 600,
        color: "var(--fs-ink)",
      }}
    >
      {t("shell.home.greetingNoShortcut")}
    </h1>
  );

  return (
    <PageShell header={greeting}>
      {loading ? null : (
        <TranscriptList
          entries={entries}
          emptyLabel={t("shell.home.empty")}
          getAudioUrl={getAudioUrl}
          onToggleSaved={toggleSaved}
          onRetry={retryEntry}
          onDelete={deleteEntry}
        />
      )}
    </PageShell>
  );
};
