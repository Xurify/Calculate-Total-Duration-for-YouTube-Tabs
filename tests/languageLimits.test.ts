import { describe, expect, test } from "bun:test";
import { cleanLanguageLimits, languageKey, languageTodayRows, levelOf, limitUsage, newLimitWarnings } from "../utils/languageLimits";
import type { WatchEntry } from "../utils/watchLog";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

function entry(overrides: Partial<WatchEntry> = {}): WatchEntry {
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
    videoSeconds: 1200,
    visibleSeconds: 600,
    captionSeconds: 0,
    adSeconds: 0,
    lastPosition: 1200,
    hours: {},
    ...overrides,
  };
}

describe("cleanLanguageLimits", () => {
  test("keeps one limit per language, rounds minutes, drops junk", () => {
    expect(
      cleanLanguageLimits([
        { language: " English ", minutes: 89.6 },
        { language: "english", minutes: 30 },
        { language: "Unknown language", minutes: 10 },
        { language: "Russian", minutes: -5 },
        { language: "", minutes: 10 },
        { minutes: 10 },
        "Slovak",
      ])
    ).toEqual([
      { language: "English", minutes: 90 },
      { language: "Russian", minutes: 1 },
    ]);
    expect(cleanLanguageLimits(null)).toEqual([]);
  });
});

describe("levelOf", () => {
  test("warns from 80% and marks the limit itself", () => {
    expect(levelOf(70 * 60, 90)).toBeNull();
    expect(levelOf(72 * 60, 90)).toBe("near");
    expect(levelOf(90 * 60, 90)).toBe("over");
  });
});

describe("limitUsage", () => {
  test("counts today's real playing time for the limited language only", () => {
    const now = at(25, 20);
    const entries = [
      entry({ startedAt: at(25, 9) }),
      entry({ startedAt: at(25, 12), playedSeconds: 1200 }),
      entry({ startedAt: at(24, 22), playedSeconds: 3000 }),
      entry({ startedAt: at(25, 13), language: "sk", languageName: "Slovak", playedSeconds: 5000 }),
    ];
    const [english] = limitUsage([{ language: "english", minutes: 30 }], entries, now);
    expect(english.usedSeconds).toBe(1800);
    expect(english.level).toBe("over");
  });

  test("follows language overrides", () => {
    const overrides = { videos: { abc123def45: { code: "sk", name: "Slovak" } }, channels: {} };
    const [english] = limitUsage([{ language: "English", minutes: 30 }], [entry()], at(25, 20), overrides);
    expect(english.usedSeconds).toBe(0);
  });
});

describe("languageTodayRows", () => {
  test("lists rules first, then today's other languages by time", () => {
    const now = at(25, 20);
    const entries = [
      entry({ startedAt: at(25, 9), playedSeconds: 4700 }),
      entry({ startedAt: at(25, 13), language: "sk", languageName: "Slovak", playedSeconds: 3900 }),
      entry({ startedAt: at(25, 14), language: "et", languageName: "Estonian", playedSeconds: 720 }),
      entry({ startedAt: at(24, 14), language: "cs", languageName: "Czech", playedSeconds: 9000 }),
    ];
    const rows = languageTodayRows([{ language: "English", minutes: 90 }], entries, now);
    expect(rows.map((row) => [row.language, row.usedSeconds, row.level])).toEqual([
      ["English", 4700, "near"],
      ["Slovak", 3900, null],
      ["Estonian", 720, null],
    ]);
    expect(rows[1].minutes).toBeUndefined();
  });
});

describe("newLimitWarnings", () => {
  const usage = (usedMinutes: number) => limitUsage([{ language: "English", minutes: 90 }], [entry({ playedSeconds: usedMinutes * 60 })], at(25, 20));

  test("warns once per level per day", () => {
    const now = at(25, 20);
    const first = newLimitWarnings(usage(75), null, now);
    expect(first.warnings.map((warning) => warning.level)).toEqual(["near"]);
    const again = newLimitWarnings(usage(80), first.shown, now);
    expect(again.warnings).toEqual([]);
    const over = newLimitWarnings(usage(95), again.shown, now);
    expect(over.warnings.map((warning) => warning.level)).toEqual(["over"]);
  });

  test("starts over on a new day", () => {
    const shown = { day: "2026-10-24", levels: { english: "over" as const } };
    expect(newLimitWarnings(usage(95), shown, at(25, 20)).warnings).toHaveLength(1);
  });

  test("warns again after the limit is raised and crossed again", () => {
    const now = at(25, 20);
    const raised = limitUsage([{ language: "English", minutes: 120 }], [entry({ playedSeconds: 95 * 60 })], now);
    const after = newLimitWarnings(raised, { day: "2026-10-25", levels: { english: "over" } }, now);
    expect(after.warnings).toEqual([]);
    expect(newLimitWarnings(usage(95), after.shown, now).warnings.map((warning) => warning.level)).toEqual(["over"]);
  });
});

describe("languageKey", () => {
  test("names YouTube gives in other UI languages meet the English name on one code", () => {
    expect(languageKey("slovaki")).toBe(languageKey("Slovak"));
    expect(languageKey("sk")).toBe(languageKey("Slovak"));
    expect(languageKey("Klingon")).toBe("klingon");
  });
});
