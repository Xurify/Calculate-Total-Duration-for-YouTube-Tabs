import { languageOverrideFor, type LanguageOverrides } from "./languageOverrides";
import { dateKeyOf } from "./timeLog";
import { newTypeId } from "./typeId";

/**
 * YouTube watch history from the page player: counts while the video plays (not ads), on screen or audible.
 * Independent of Mandala and site rules.
 */

export interface WatchSample {
  videoId: string;
  title: string;
  channelName: string;
  language: string | null;
  languageName: string | null;
  durationSeconds: number;
  isLive: boolean;
  isShort: boolean;
  startedAt: number;
  endedAt: number;
  playedSeconds: number;
  videoSeconds: number;
  visibleSeconds: number;
  captionSeconds: number;
  adSeconds: number;
  position: number;
}

export interface WatchEntry extends Omit<WatchSample, "position"> {
  id: string;
  lastPosition: number;
  hours: Record<string, number>;
}

export const WATCH_LOG_KEY = "watchLog";
/** Same video, same local day, gap under this → one sitting. */
export const WATCH_MERGE_GAP_MS = 30 * 60_000;
export const WATCH_KEEP_DAYS = 365;
export const WATCH_MAX_ENTRIES = 6000;
/** End cards and credits rarely get sat through; this share counts as finished. */
export const COMPLETED_SHARE = 0.9;
export const UNKNOWN_LANGUAGE = "Unknown language";

function finiteSeconds(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, max) : 0;
}

export function cleanWatchSample(raw: unknown): WatchSample | null {
  if (!raw || typeof raw !== "object") return null;
  const sample = raw as Partial<WatchSample>;
  if (typeof sample.videoId !== "string" || !/^[\w-]{6,20}$/.test(sample.videoId)) return null;
  const startedAt = finiteSeconds(sample.startedAt, Number.MAX_SAFE_INTEGER);
  const endedAt = finiteSeconds(sample.endedAt, Number.MAX_SAFE_INTEGER);
  if (!startedAt || endedAt < startedAt) return null;
  const span = (endedAt - startedAt) / 1000 + 5;
  const playedSeconds = finiteSeconds(sample.playedSeconds, span);
  const adSeconds = finiteSeconds(sample.adSeconds, span);
  if (playedSeconds < 1 && adSeconds < 1) return null;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  return {
    videoId: sample.videoId,
    title: text(sample.title, 300),
    channelName: text(sample.channelName, 200),
    language: typeof sample.language === "string" && sample.language ? sample.language.slice(0, 20) : null,
    languageName: typeof sample.languageName === "string" && sample.languageName ? sample.languageName.slice(0, 80) : null,
    durationSeconds: finiteSeconds(sample.durationSeconds, 7 * 86_400),
    isLive: Boolean(sample.isLive),
    isShort: Boolean(sample.isShort),
    startedAt,
    endedAt,
    playedSeconds,
    // 16× is the fastest a media element plays.
    videoSeconds: finiteSeconds(sample.videoSeconds, playedSeconds * 16),
    visibleSeconds: finiteSeconds(sample.visibleSeconds, playedSeconds),
    captionSeconds: finiteSeconds(sample.captionSeconds, playedSeconds),
    adSeconds,
    position: finiteSeconds(sample.position, 7 * 86_400),
  };
}

export function recordWatchSample(entries: WatchEntry[], sample: WatchSample): WatchEntry[] {
  const last = [...entries].reverse().find((entry) => entry.videoId === sample.videoId);
  const hour = String(new Date(sample.endedAt).getHours());
  if (
    last &&
    sample.startedAt - last.endedAt <= WATCH_MERGE_GAP_MS &&
    sample.startedAt >= last.startedAt &&
    dateKeyOf(last.startedAt) === dateKeyOf(sample.startedAt)
  ) {
    last.endedAt = Math.max(last.endedAt, sample.endedAt);
    last.playedSeconds += sample.playedSeconds;
    last.videoSeconds += sample.videoSeconds;
    last.visibleSeconds += sample.visibleSeconds;
    last.captionSeconds += sample.captionSeconds;
    last.adSeconds += sample.adSeconds;
    last.lastPosition = sample.position;
    last.hours[hour] = (last.hours[hour] ?? 0) + sample.playedSeconds;
    // Title, channel and language arrive after playback starts.
    if (sample.title) last.title = sample.title;
    if (sample.channelName) last.channelName = sample.channelName;
    if (sample.language || sample.languageName) {
      last.language = sample.language;
      last.languageName = sample.languageName;
    }
    if (sample.durationSeconds) last.durationSeconds = sample.durationSeconds;
    last.isLive = sample.isLive;
    return entries;
  }
  const { position, ...rest } = sample;
  entries.push({ ...rest, id: newTypeId("watch", sample.startedAt), lastPosition: position, hours: { [hour]: sample.playedSeconds } });
  return entries;
}

export function trimWatchLog(entries: WatchEntry[], now: number = Date.now()): WatchEntry[] {
  const floor = now - WATCH_KEEP_DAYS * 86_400_000;
  const kept = entries.filter((entry) => entry.endedAt >= floor).sort((first, second) => first.startedAt - second.startedAt);
  return kept.length > WATCH_MAX_ENTRIES ? kept.slice(kept.length - WATCH_MAX_ENTRIES) : kept;
}

export async function loadWatchLog(): Promise<WatchEntry[]> {
  if (!browser.storage?.local) return [];
  const data = await browser.storage.local.get(WATCH_LOG_KEY);
  const raw = data[WATCH_LOG_KEY];
  return Array.isArray(raw) ? (raw as WatchEntry[]) : [];
}

export async function saveWatchLog(entries: WatchEntry[]): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [WATCH_LOG_KEY]: trimWatchLog(entries) });
}

export function languageLabelOf(languageName: string | null | undefined, code: string | null | undefined): string {
  const stripped = languageName ? languageName.split("(")[0].trim() : "";
  if (stripped) return stripped;
  if (code) return code.toUpperCase();
  return UNKNOWN_LANGUAGE;
}

function entryLanguage(entry: WatchEntry, overrides: LanguageOverrides | null): string {
  const override = overrides ? languageOverrideFor(overrides, entry.videoId, entry.channelName) : null;
  return override ? override.name : languageLabelOf(entry.languageName, entry.language);
}

export interface WatchVideoRow {
  videoId: string;
  title: string;
  channelName: string;
  language: string;
  playedSeconds: number;
  videoSeconds: number;
  durationSeconds: number;
  coverage: number;
  sittings: number;
  lastAt: number;
  isLive: boolean;
  isShort: boolean;
}

export interface WatchSummary {
  days: { key: string; seconds: number; visible: number }[];
  total: {
    playedSeconds: number;
    videoSeconds: number;
    visibleSeconds: number;
    captionSeconds: number;
    adSeconds: number;
    shortsSeconds: number;
    liveSeconds: number;
    videos: number;
    completed: number;
    sittings: number;
    activeDays: number;
  };
  byLanguage: { label: string; seconds: number; videos: number }[];
  byChannel: { channelName: string; seconds: number; videos: number; language: string }[];
  byHour: number[];
  videos: WatchVideoRow[];
  streak: { current: number; longest: number };
}

const STREAK_DAY_SECONDS = 60;

function streaksOf(entries: readonly WatchEntry[], now: number): { current: number; longest: number } {
  const perDay = new Map<string, number>();
  for (const entry of entries) {
    const key = dateKeyOf(entry.startedAt);
    perDay.set(key, (perDay.get(key) ?? 0) + entry.playedSeconds);
  }
  const watchedDays = [...perDay].filter(([, seconds]) => seconds >= STREAK_DAY_SECONDS).map(([key]) => key).sort();
  let longest = 0;
  let run = 0;
  let previous: Date | null = null;
  for (const key of watchedDays) {
    const [year, month, day] = key.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const next = previous ? new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1) : null;
    run = next && dateKeyOf(next.getTime()) === key ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  const watched = new Set(watchedDays);
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  // Today still counts as unbroken before anything has been watched in it.
  if (!watched.has(dateKeyOf(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (watched.has(dateKeyOf(cursor.getTime()))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

export function summarizeWatch(
  entries: readonly WatchEntry[],
  days = 7,
  now: number = Date.now(),
  overrides: LanguageOverrides | null = null
): WatchSummary {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const dayKeys: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    dayKeys.push(dateKeyOf(date.getTime()));
  }
  const perDay = new Map(dayKeys.map((key) => [key, { key, seconds: 0, visible: 0 }]));
  const total: WatchSummary["total"] = {
    playedSeconds: 0,
    videoSeconds: 0,
    visibleSeconds: 0,
    captionSeconds: 0,
    adSeconds: 0,
    shortsSeconds: 0,
    liveSeconds: 0,
    videos: 0,
    completed: 0,
    sittings: 0,
    activeDays: 0,
  };
  const byHour = Array.from({ length: 24 }, () => 0);
  const videos = new Map<string, WatchVideoRow>();
  const languages = new Map<string, { label: string; seconds: number; videoIds: Set<string> }>();
  const channels = new Map<string, { channelName: string; seconds: number; videoIds: Set<string>; languages: Map<string, number> }>();

  for (const entry of entries) {
    const day = perDay.get(dateKeyOf(entry.startedAt));
    if (!day) continue;
    day.seconds += entry.playedSeconds;
    day.visible += entry.visibleSeconds;
    total.playedSeconds += entry.playedSeconds;
    total.videoSeconds += entry.videoSeconds;
    total.visibleSeconds += entry.visibleSeconds;
    total.captionSeconds += entry.captionSeconds;
    total.adSeconds += entry.adSeconds;
    if (entry.isShort) total.shortsSeconds += entry.playedSeconds;
    if (entry.isLive) total.liveSeconds += entry.playedSeconds;
    if (entry.playedSeconds > 0) total.sittings += 1;
    for (const [hour, seconds] of Object.entries(entry.hours ?? {})) {
      const index = Number(hour);
      if (index >= 0 && index < 24) byHour[index] += seconds;
    }

    const language = entryLanguage(entry, overrides);
    const video = videos.get(entry.videoId) ?? {
      videoId: entry.videoId,
      title: entry.title,
      channelName: entry.channelName,
      language,
      playedSeconds: 0,
      videoSeconds: 0,
      durationSeconds: entry.durationSeconds,
      coverage: 0,
      sittings: 0,
      lastAt: 0,
      isLive: entry.isLive,
      isShort: entry.isShort,
    };
    video.playedSeconds += entry.playedSeconds;
    video.videoSeconds += entry.videoSeconds;
    video.sittings += 1;
    if (entry.endedAt >= video.lastAt) {
      video.lastAt = entry.endedAt;
      video.title = entry.title || video.title;
      video.channelName = entry.channelName || video.channelName;
      video.language = language;
      video.durationSeconds = entry.durationSeconds || video.durationSeconds;
      video.isLive = entry.isLive;
    }
    videos.set(entry.videoId, video);

    if (entry.playedSeconds <= 0) continue;
    const languageRow = languages.get(language) ?? { label: language, seconds: 0, videoIds: new Set<string>() };
    languageRow.seconds += entry.playedSeconds;
    languageRow.videoIds.add(entry.videoId);
    languages.set(language, languageRow);

    const channelName = entry.channelName || "Unknown channel";
    const channel = channels.get(channelName) ?? { channelName, seconds: 0, videoIds: new Set<string>(), languages: new Map<string, number>() };
    channel.seconds += entry.playedSeconds;
    channel.videoIds.add(entry.videoId);
    channel.languages.set(language, (channel.languages.get(language) ?? 0) + entry.playedSeconds);
    channels.set(channelName, channel);
  }

  const videoRows = [...videos.values()].filter((video) => video.playedSeconds > 0);
  for (const video of videoRows) {
    video.coverage = !video.isLive && video.durationSeconds > 0 ? Math.min(1, video.videoSeconds / video.durationSeconds) : 0;
    if (video.coverage >= COMPLETED_SHARE) total.completed += 1;
  }
  total.videos = videoRows.length;
  total.activeDays = [...perDay.values()].filter((day) => day.seconds >= STREAK_DAY_SECONDS).length;

  return {
    days: dayKeys.map((key) => perDay.get(key)!),
    total,
    byLanguage: [...languages.values()]
      .map((row) => ({ label: row.label, seconds: row.seconds, videos: row.videoIds.size }))
      .sort((first, second) => second.seconds - first.seconds),
    byChannel: [...channels.values()]
      .map((row) => ({
        channelName: row.channelName,
        seconds: row.seconds,
        videos: row.videoIds.size,
        language: [...row.languages].sort((first, second) => second[1] - first[1])[0]?.[0] ?? UNKNOWN_LANGUAGE,
      }))
      .sort((first, second) => second.seconds - first.seconds),
    byHour,
    videos: videoRows.sort((first, second) => second.lastAt - first.lastAt),
    streak: streaksOf(entries, now),
  };
}
