import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { PageShell } from "../home/PageShell";
import { TranscriptList } from "./TranscriptList";
import { useTranscripts } from "./useTranscripts";

/** Pages pulled in while a search is running, so a match further back is found. */
const SEARCH_LOAD_CAP = 1000;

export const HistoryPage: React.FC = () => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const sentinelRef = useRef<HTMLDivElement>(null);
  const {
    entries,
    loading,
    hasMore,
    loadMore,
    getAudioUrl,
    toggleSaved,
    retryEntry,
    deleteEntry,
  } = useTranscripts();

  // Infinite scroll, same shape as the settings history list.
  useEffect(() => {
    if (loading) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;

    const observer = new IntersectionObserver(
      ([first]) => {
        if (first.isIntersecting) loadMore();
      },
      { threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadMore]);

  // The backend has no search command, so matching runs over what is loaded;
  // while a query is active keep pulling pages so older matches surface.
  useEffect(() => {
    if (!query || loading || !hasMore) return;
    if (entries.length >= SEARCH_LOAD_CAP) return;
    loadMore();
  }, [query, loading, hasMore, entries.length, loadMore]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
      entry.transcription_text.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  const search = (
    <label
      className="flex w-[240px] shrink-0 items-center gap-[8px] rounded-[var(--fs-radius-pill)]"
      style={{
        height: "var(--fs-control-h)",
        paddingInline: "12px",
        background: "var(--fs-quiet)",
      }}
    >
      <Search size={16} strokeWidth={1.5} color="var(--fs-ink-muted)" />
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("shell.history.search")}
        className="w-full min-w-0 bg-transparent outline-none"
        style={{
          fontFamily: "var(--fs-font-sans)",
          fontSize: "var(--fs-text-body)",
          color: "var(--fs-ink)",
        }}
      />
    </label>
  );

  return (
    <PageShell title={t("shell.history.title")} actions={search}>
      {loading ? (
        <p
          style={{
            fontFamily: "var(--fs-font-sans)",
            fontSize: "var(--fs-text-body)",
            color: "var(--fs-ink-muted)",
          }}
        >
          {t("shell.history.loading")}
        </p>
      ) : (
        <>
          <TranscriptList
            entries={matches}
            emptyLabel={
              query ? t("shell.history.noResults") : t("shell.history.empty")
            }
            getAudioUrl={getAudioUrl}
            onToggleSaved={toggleSaved}
            onRetry={retryEntry}
            onDelete={deleteEntry}
          />
          <div ref={sentinelRef} className="h-[1px]" />
        </>
      )}
    </PageShell>
  );
};
