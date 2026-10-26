import { describe, expect, test } from "bun:test";
import { dayStatusOf, goalStreaks } from "../utils/goals";
import { at, watchEntry } from "./fixtures";

const slovak = (day: number, minutes: number) =>
  watchEntry({ startedAt: at(day, 9), playedSeconds: minutes * 60, language: "sk", languageName: "Slovak", videoId: `sk${day}abcdefg` });
const english = (day: number, minutes: number) => watchEntry({ startedAt: at(day, 20), playedSeconds: minutes * 60, videoId: `en${day}abcdefg` });

describe("dayStatusOf", () => {
  const rules = [
    { language: "Slovak", minutes: 30, kind: "goal" as const },
    { language: "Estonian", minutes: 20, kind: "goal" as const },
    { language: "English", minutes: 60 },
  ];
  test("all when every goal is reached and every limit kept", () => {
    expect(dayStatusOf(rules, new Map([["slovak", 1800], ["estonian", 1200], ["english", 3600]]))).toBe("all");
  });
  test("some when a goal is reached but not everything", () => {
    expect(dayStatusOf(rules, new Map([["slovak", 1800], ["english", 4000]]))).toBe("some");
  });
  test("none when no goal is reached", () => {
    expect(dayStatusOf(rules, new Map([["english", 100]]))).toBe("none");
  });
  test("without rules a watched minute is enough", () => {
    expect(dayStatusOf([], new Map([["english", 60]]))).toBe("all");
    expect(dayStatusOf([], undefined)).toBe("none");
  });
});

describe("goalStreaks", () => {
  const goal = [{ language: "Slovak", minutes: 30, kind: "goal" as const }];

  test("counts days in a row that reached the goal, and today does not break it yet", () => {
    const log = [slovak(20, 40), slovak(22, 30), slovak(23, 35), slovak(24, 31), slovak(25, 5)];
    const streaks = goalStreaks(log, goal, at(25, 12));
    expect(streaks.current).toBe(3);
    expect(streaks.longest).toBe(3);
    expect(streaks.rules[0].current).toBe(3);
  });

  test("today counts once it is reached", () => {
    expect(goalStreaks([slovak(24, 30), slovak(25, 30)], goal, at(25, 12)).current).toBe(2);
  });

  test("a limit streak breaks on the day it was passed", () => {
    const limit = [{ language: "English", minutes: 60 }];
    const streaks = goalStreaks([english(20, 10), english(22, 90), english(23, 10), english(25, 10)], limit, at(25, 22));
    expect(streaks.current).toBe(3);
    expect(streaks.longest).toBe(3);
  });

  test("the calendar is whole weeks, Monday first, ending this week", () => {
    const streaks = goalStreaks([slovak(25, 40)], goal, at(25, 12));
    expect(streaks.calendar).toHaveLength(56);
    expect(new Date(`${streaks.calendar[0].key}T12:00`).getDay()).toBe(1);
    expect(streaks.calendar.find((day) => day.key === "2026-10-25")?.status).toBe("all");
    expect(streaks.calendar.find((day) => day.key === "2026-10-24")?.status).toBe("before");
    expect(streaks.calendar.at(-1)?.status).not.toBe("before");
  });

  test("falls back to watched days without rules", () => {
    expect(goalStreaks([english(24, 2), english(25, 2)], [], at(25, 22)).mode).toBe("watching");
    expect(goalStreaks([english(24, 2), english(25, 2)], [], at(25, 22)).current).toBe(2);
  });
});
