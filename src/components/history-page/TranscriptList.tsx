import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { HistoryEntry } from "@/bindings";
import { SectionLabel } from "../ui";
import { TranscriptRow } from "./TranscriptRow";
import { groupByDay } from "./format";

interface TranscriptListProps {
  entries: HistoryEntry[];
  /** Shown when the list is empty — differs for "no history" vs "no matches". */
  emptyLabel: string;
  getAudioUrl: (fileName: string) => Promise<string | null>;
  onToggleSaved: (id: number) => Promise<void>;
  onRetry: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/** The one popover fade in this module; MOTION.md: 80ms in, nothing slides. */
const FADE_KEYFRAMES = `@keyframes fs-fade-in { from { opacity: 0 } to { opacity: 1 } }`;

/**
 * Transcripts grouped under an uppercase date eyebrow, hairline-divided rows
 * beneath it. Used by both the home page and the History page so the row
 * treatment is identical in each.
 */
export const TranscriptList: React.FC<TranscriptListProps> = ({
  entries,
  emptyLabel,
  getAudioUrl,
  onToggleSaved,
  onRetry,
  onDelete,
}) => {
  const { t, i18n } = useTranslation();
  const [playingId, setPlayingId] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // One player for the whole list: starting a row stops whatever was playing.
  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const togglePlay = useCallback(
    async (entry: HistoryEntry) => {
      if (playingId === entry.id) {
        audioRef.current?.pause();
        setPlayingId(null);
        return;
      }
      audioRef.current?.pause();
      const url = await getAudioUrl(entry.file_name);
      if (!url) {
        toast.error(t("shell.transcripts.playError"));
        return;
      }
      const audio = new Audio(url);
      audio.onended = () => setPlayingId(null);
      audioRef.current = audio;
      setPlayingId(entry.id);
      try {
        await audio.play();
      } catch (error) {
        console.error("Failed to play recording:", error);
        setPlayingId(null);
        toast.error(t("shell.transcripts.playError"));
      }
    },
    [getAudioUrl, playingId, t],
  );

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await onDelete(id);
    } catch (error) {
      console.error("Failed to delete entry:", error);
      toast.error(t("shell.transcripts.deleteError"));
    }
  };

  const handleRetry = async (id: number) => {
    try {
      await onRetry(id);
    } catch (error) {
      console.error("Failed to re-transcribe:", error);
      toast.error(t("shell.transcripts.retranscribeError"));
    }
  };

  if (entries.length === 0) {
    return (
      <p
        style={{
          fontFamily: "var(--fs-font-sans)",
          fontSize: "var(--fs-text-body)",
          color: "var(--fs-ink-muted)",
        }}
      >
        {emptyLabel}
      </p>
    );
  }

  return (
    <div>
      <style>{FADE_KEYFRAMES}</style>
      {groupByDay(entries, i18n.language).map((day, index) => (
        <section key={day.key} className={index === 0 ? "" : "mt-[32px]"}>
          {/* 10, not 12: the reference's gap is ink-to-divider (34 native, 17
              css) and the 12px line box hangs ~3.5 css below its own ink. */}
          <SectionLabel className="mb-[10px]">{day.label}</SectionLabel>
          {day.entries.map((entry) => (
            <TranscriptRow
              key={entry.id}
              entry={entry}
              playing={playingId === entry.id}
              onTogglePlay={() => togglePlay(entry)}
              onCopy={() => copyText(entry.transcription_text)}
              onToggleSaved={() => onToggleSaved(entry.id)}
              onRetry={() => handleRetry(entry.id)}
              onDelete={() => handleDelete(entry.id)}
            />
          ))}
        </section>
      ))}
    </div>
  );
};
