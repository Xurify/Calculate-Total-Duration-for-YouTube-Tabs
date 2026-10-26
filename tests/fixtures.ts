import type { WatchEntry } from "../utils/watchLog";

export const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

export function watchEntry(overrides: Partial<WatchEntry> = {}): WatchEntry {
  const startedAt = overrides.startedAt ?? at(25, 9);
  return {
    id: `watch_${startedAt}`,
    videoId: "abc123def45",
    title: "A video",
    channelName: "Some channel",
    language: "en",
    languageName: "English",
    durationSeconds: 3600,
    isLive: false,
    isShort: false,
    startedAt,
    endedAt: startedAt + 600_000,
    playedSeconds: 600,
    videoSeconds: 600,
    visibleSeconds: 600,
    captionSeconds: 0,
    adSeconds: 0,
    lastPosition: 600,
    hours: {},
    ...overrides,
  };
}
