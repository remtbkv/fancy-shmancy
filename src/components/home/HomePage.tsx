import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { commands } from "@/bindings";
import { TranscriptList, useTranscripts } from "../history-page";
import { PageShell } from "./PageShell";

/** Pages pulled in while a search is running, so a match further back is found. */
const SEARCH_LOAD_CAP = 1000;
const GB = 1_000_000_000;

const formatBytes = (bytes: number): string =>
  bytes >= GB
    ? `${(bytes / GB).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;

/**
 * "Dictation" — the only place transcripts live. It used to be two pages: a
 * recent list here and a History page carrying the identical rows behind a
 * second nav item. One page with the search field on it does both, and the
 * sidebar loses an entry that only ever led back here.
 *
 * The header is one muted line of totals plus the search field. Deliberately not
 * the reference's stats rail — three numbers do not earn a card, and its rail
 * exists to sell a word quota we do not have.
 */
export const HomePage: React.FC = () => {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [stats, setStats] = useState<{
    entries: number;
    hours: number;
    bytes: number;
  } | null>(null);
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

  const refreshStats = useCallback(() => {
    commands
      .getRecordingStorageUsage()
      .then((result) => {
        if (result.status !== "ok") return;
        setStats({
          entries: result.data.entry_count,
          hours: result.data.hours_recorded,
          bytes: result.data.bytes_used,
        });
      })
      .catch(() => undefined);
  }, []);

  // Keyed off the list length so recording or deleting one moves the totals
  // without a manual refresh.
  useEffect(refreshStats, [refreshStats, entries.length]);

  // Infinite scroll.
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

  // An empty span rather than nothing, so the search field stays right-aligned
  // while the totals are still being read off disk.
  const statsLine = stats ? (
    <p
      className="truncate"
      style={{
        fontFamily: "var(--fs-font-sans)",
        fontSize: "var(--fs-text-meta)",
        color: "var(--fs-ink-muted)",
      }}
    >
      {t("shell.home.stats", {
        count: stats.entries,
        hours: stats.hours.toFixed(1),
        size: formatBytes(stats.bytes),
      })}
    </p>
  ) : (
    <span />
  );

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
    <PageShell header={statsLine} actions={search}>
      {loading ? null : (
        <>
          <TranscriptList
            entries={matches}
            emptyLabel={
              query ? t("shell.history.noResults") : t("shell.home.empty")
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
