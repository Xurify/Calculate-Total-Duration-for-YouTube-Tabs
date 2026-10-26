import { describe, expect, test } from "bun:test";
import { archiveEntries, emptyLanguageHours, languageHoursRows, milestoneProgress, setEarlierHours } from "../utils/languageHours";
import { at, watchEntry } from "./fixtures";

const slovak = (day: number, minutes: number) =>
  watchEntry({ startedAt: at(day, 9), playedSeconds: minutes * 60, language: "sk", languageName: "Slovak", videoId: `sk${day}abcdefg` });
const english = (day: number, minutes: number) => watchEntry({ startedAt: at(day, 20), playedSeconds: minutes * 60, videoId: `en${day}abcdefg` });

describe("milestoneProgress", () => {
  test("before the first milestone", () => {
    expect(milestoneProgress(5)).toEqual({ reached: 0, next: 10, progress: 0.5 });
  });
  test("between milestones", () => {
    expect(milestoneProgress(100)).toEqual({ reached: 50, next: 150, progress: 0.5 });
  });
  test("past the last milestone", () => {
    expect(milestoneProgress(2000)).toEqual({ reached: 1500, next: null, progress: 1 });
  });
});

describe("languageHoursRows", () => {
  const goals = [{ language: "Slovak", minutes: 30, kind: "goal" as const }, { language: "English", minutes: 60 }];

  test("shows goal languages only, with earlier and archived hours added", () => {
    let store = setEarlierHours(emptyLanguageHours(), "Slovak", 12);
    store = archiveEntries(store, [slovak(1, 60)]);
    const rows = languageHoursRows([slovak(20, 60), english(20, 600)], store, goals, at(25, 12));
    expect(rows.map((row) => row.language)).toEqual(["Slovak"]);
    expect(rows[0].hours).toBe(14);
    expect(rows[0].earlierHours).toBe(12);
    expect(rows[0].reached).toBe(10);
    expect(rows[0].next).toBe(50);
  });

  test("estimates days to the next milestone from the recent pace", () => {
    const log = Array.from({ length: 28 }, (_item, index) => watchEntry({ startedAt: at(25, 9) - index * 86_400_000, playedSeconds: 3600, language: "sk", languageName: "Slovak", videoId: `sk${index}abcdefg` }));
    const [row] = languageHoursRows(log, emptyLanguageHours(), goals, at(25, 12));
    expect(row.hours).toBe(28);
    expect(row.dailySeconds).toBe(3600);
    expect(row.daysToNext).toBe(22);
  });

  test("without goals the most watched languages stand in", () => {
    const rows = languageHoursRows([slovak(20, 30), english(20, 90)], emptyLanguageHours(), [], at(25, 12));
    expect(rows.map((row) => row.language)).toEqual(["English", "Slovak"]);
  });

  test("a language with only earlier hours still shows", () => {
    const store = setEarlierHours(emptyLanguageHours(), "Estonian", 3);
    const rows = languageHoursRows([], store, goals, at(25, 12));
    expect(rows.map((row) => [row.language, row.hours])).toEqual([["Estonian", 3], ["Slovak", 0]]);
  });

  test("clearing earlier hours removes them", () => {
    const store = setEarlierHours(setEarlierHours(emptyLanguageHours(), "Slovak", 5), "Slovak", 0);
    expect(store.earlier).toEqual({});
  });
});
