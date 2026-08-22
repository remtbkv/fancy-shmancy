import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  commands,
  events,
  type HistoryEntry,
  type HistoryUpdatePayload,
} from "@/bindings";
import { useOsType } from "@/hooks/useOsType";

/**
 * The transcript list behind both the home page and the History page.
 *
 * The paging, the live `history-update` subscription and the optimistic
 * mutations are the same ones `settings/history/HistorySettings.tsx` runs
 * against the same commands; that logic lived inline in the component, so it is
 * lifted here rather than duplicated per page. The settings component is
 * untouched.
 */
export interface UseTranscriptsResult {
  entries: HistoryEntry[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
  toggleSaved: (id: number) => Promise<void>;
  deleteEntry: (id: number) => Promise<void>;
  retryEntry: (id: number) => Promise<void>;
  getAudioUrl: (fileName: string) => Promise<string | null>;
}

export const useTranscripts = (pageSize = 30): UseTranscriptsResult => {
  const osType = useOsType();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const entriesRef = useRef<HistoryEntry[]>([]);
  const loadingRef = useRef(false);

  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const loadPage = useCallback(
    async (cursor?: number) => {
      const isFirstPage = cursor === undefined;
      if (!isFirstPage && loadingRef.current) return;
      loadingRef.current = true;
      if (isFirstPage) setLoading(true);

      try {
        const result = await commands.getHistoryEntries(
          cursor ?? null,
          pageSize,
        );
        if (result.status === "ok") {
          const { entries: page, has_more } = result.data;
          setEntries((prev) => (isFirstPage ? page : [...prev, ...page]));
          setHasMore(has_more);
        }
      } catch (error) {
        console.error("Failed to load history entries:", error);
      } finally {
        setLoading(false);
        loadingRef.current = false;
      }
    },
    [pageSize],
  );

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  const loadMore = useCallback(() => {
    const last = entriesRef.current[entriesRef.current.length - 1];
    if (last) loadPage(last.id);
  }, [loadPage]);

  const reload = useCallback(() => loadPage(), [loadPage]);

  // New transcriptions arrive from the pipeline while the window is open.
  // "deleted" and "toggled" are already applied optimistically below, so
  // acting on them here would double-mutate.
  useEffect(() => {
    const unlisten = events.historyUpdatePayload.listen((event) => {
      const payload: HistoryUpdatePayload = event.payload;
      if (payload.action === "added") {
        setEntries((prev) => [payload.entry, ...prev]);
      } else if (payload.action === "updated") {
        setEntries((prev) =>
          prev.map((e) => (e.id === payload.entry.id ? payload.entry : e)),
        );
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const toggleSaved = useCallback(async (id: number) => {
    const flip = () =>
      setEntries((prev) =>
        prev.map((e) => (e.id === id ? { ...e, saved: !e.saved } : e)),
      );
    flip();
    try {
      const result = await commands.toggleHistoryEntrySaved(id);
      if (result.status !== "ok") flip();
    } catch (error) {
      console.error("Failed to toggle saved status:", error);
      flip();
    }
  }, []);

  const deleteEntry = useCallback(
    async (id: number) => {
      setEntries((prev) => prev.filter((e) => e.id !== id));
      try {
        const result = await commands.deleteHistoryEntry(id);
        if (result.status !== "ok") {
          loadPage();
          throw new Error(String(result.error));
        }
      } catch (error) {
        loadPage();
        throw error;
      }
    },
    [loadPage],
  );

  const retryEntry = useCallback(async (id: number) => {
    const result = await commands.retryHistoryEntryTranscription(id);
    if (result.status !== "ok") {
      throw new Error(String(result.error));
    }
  }, []);

  const getAudioUrl = useCallback(
    async (fileName: string) => {
      try {
        const result = await commands.getAudioFilePath(fileName);
        if (result.status !== "ok") return null;
        if (osType === "linux") {
          const fileData = await readFile(result.data);
          return URL.createObjectURL(
            new Blob([fileData], { type: "audio/wav" }),
          );
        }
        return convertFileSrc(result.data, "asset");
      } catch (error) {
        console.error("Failed to get audio file path:", error);
        return null;
      }
    },
    [osType],
  );

  return {
    entries,
    loading,
    hasMore,
    loadMore,
    reload,
    toggleSaved,
    deleteEntry,
    retryEntry,
    getAudioUrl,
  };
};
