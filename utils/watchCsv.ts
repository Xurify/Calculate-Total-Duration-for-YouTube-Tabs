import type { LanguageOverrides } from "./languageOverrides";
import { dateKeyOf } from "./timeLog";
import { entryLanguage, type WatchEntry } from "./watchLog";

/** The watch history as CSV, one row per sitting, for spreadsheets. */

export const CSV_COLUMNS = [
  { id: "date", label: "Date" },
  { id: "time", label: "Start time" },
  { id: "title", label: "Title" },
  { id: "channel", label: "Channel" },
  { id: "language", label: "Language" },
  { id: "watched", label: "Watched (real time)" },
  { id: "video", label: "Video time" },
  { id: "speed", label: "Speed" },
  { id: "subtitles", label: "With subtitles" },
  { id: "progress", label: "Progress" },
  { id: "url", label: "URL" },
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number]["id"];

export const DEFAULT_CSV_COLUMNS: CsvColumn[] = ["date", "title", "channel", "language", "watched"];

const HEADERS: Record<CsvColumn, string> = {
  date: "date",
  time: "start_time",
  title: "title",
  channel: "channel",
  language: "language",
  watched: "watched_min",
  video: "video_min",
  speed: "speed",
  subtitles: "subtitles_min",
  progress: "progress_pct",
  url: "url",
};

/** Spreadsheets run a cell starting with these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number): string {
  if (typeof value === "number") return String(value);
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function minutes(seconds: number): number {
  return Math.round((seconds / 60) * 10) / 10;
}

function cellOf(column: CsvColumn, entry: WatchEntry, language: string): string | number {
  const start = new Date(entry.startedAt);
  switch (column) {
    case "date":
      return dateKeyOf(entry.startedAt);
    case "time":
      return `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
    case "title":
      return entry.title;
    case "channel":
      return entry.channelName;
    case "language":
      return language;
    case "watched":
      return minutes(entry.playedSeconds);
    case "video":
      return minutes(entry.videoSeconds);
    case "speed":
      return entry.playedSeconds > 0 ? Math.round((entry.videoSeconds / entry.playedSeconds) * 100) / 100 : 1;
    case "subtitles":
      return minutes(entry.captionSeconds);
    case "progress":
      return entry.durationSeconds > 0 && !entry.isLive ? Math.min(100, Math.round((entry.lastPosition / entry.durationSeconds) * 100)) : "";
    case "url":
      return entry.isShort ? `https://www.youtube.com/shorts/${entry.videoId}` : `https://www.youtube.com/watch?v=${entry.videoId}`;
  }
}

export function watchEntriesSince(entries: readonly WatchEntry[], days: number | null, now: number = Date.now()): WatchEntry[] {
  if (days === null) return entries.filter((entry) => entry.playedSeconds > 0);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return entries.filter((entry) => entry.playedSeconds > 0 && entry.startedAt >= start.getTime());
}

export function watchCsv(entries: readonly WatchEntry[], columns: readonly CsvColumn[], overrides: LanguageOverrides | null = null): string {
  const ordered = CSV_COLUMNS.map((column) => column.id).filter((id) => columns.includes(id));
  const lines = [ordered.map((column) => HEADERS[column]).join(",")];
  for (const entry of [...entries].sort((first, second) => second.startedAt - first.startedAt)) {
    const language = entryLanguage(entry, overrides);
    lines.push(ordered.map((column) => csvCell(cellOf(column, entry, language))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
