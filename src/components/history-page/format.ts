import type { HistoryEntry } from "@/bindings";

/** Stable per-day key for grouping, in the viewer's own timezone. */
export const dayKey = (timestamp: number): string => {
  const date = new Date(timestamp * 1000);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** `August 19, 2026` — the eyebrow above each day's rows renders it uppercase. */
export const formatDayLabel = (timestamp: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(timestamp * 1000));

/**
 * `5:03 pm` — the reference sets the day period lowercase, which no `Intl`
 * option produces, so it is lowered after formatting. Locales without a day
 * period are unaffected.
 */
export const formatClockTime = (timestamp: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(timestamp * 1000))
    .replace(/\b(AM|PM)\b/g, (period) => period.toLowerCase());

export interface TranscriptDay {
  key: string;
  label: string;
  entries: HistoryEntry[];
}

export const groupByDay = (
  entries: HistoryEntry[],
  locale: string,
): TranscriptDay[] => {
  const days: TranscriptDay[] = [];
  for (const entry of entries) {
    const key = dayKey(entry.timestamp);
    const current = days[days.length - 1];
    if (current && current.key === key) {
      current.entries.push(entry);
    } else {
      days.push({
        key,
        label: formatDayLabel(entry.timestamp, locale),
        entries: [entry],
      });
    }
  }
  return days;
};
