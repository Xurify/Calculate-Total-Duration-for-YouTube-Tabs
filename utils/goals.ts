import { isGoal, languageKey, type LanguageLimit } from "./languageLimits";
import type { LanguageOverrides } from "./languageOverrides";
import { dateKeyOf } from "./timeLog";
import { entryLanguage, type WatchEntry } from "./watchLog";

/**
 * Streaks of days that kept every daily rule: each goal reached and each limit kept. Today's rules are applied
 * to past days too, since rules are not versioned. Without any rule a day counts once a minute was watched.
 */

export type DayStatus = "all" | "some" | "none" | "before" | "future";

export interface GoalStreaks {
  mode: "rules" | "watching";
  current: number;
  longest: number;
  /** Whole weeks, Monday first, ending with the current week. */
  calendar: { key: string; status: DayStatus }[];
  rules: { language: string; minutes: number; kind?: "goal"; current: number; longest: number }[];
}

export const CALENDAR_WEEKS = 8;
const WATCHED_DAY_SECONDS = 60;

type DayTotals = Map<string, Map<string, number>>;

function dayTotalsOf(entries: readonly WatchEntry[], overrides: LanguageOverrides | null): DayTotals {
  const totals: DayTotals = new Map();
  for (const entry of entries) {
    if (entry.playedSeconds <= 0) continue;
    const key = dateKeyOf(entry.startedAt);
    const day = totals.get(key) ?? new Map<string, number>();
    const language = languageKey(entryLanguage(entry, overrides));
    day.set(language, (day.get(language) ?? 0) + entry.playedSeconds);
    totals.set(key, day);
  }
  return totals;
}

function ruleKept(rule: LanguageLimit, day: Map<string, number> | undefined): boolean {
  const used = day?.get(languageKey(rule.language)) ?? 0;
  return isGoal(rule) ? used >= rule.minutes * 60 : used <= rule.minutes * 60;
}

export function dayStatusOf(rules: readonly LanguageLimit[], day: Map<string, number> | undefined): "all" | "some" | "none" {
  if (rules.length === 0) {
    const watched = [...(day?.values() ?? [])].reduce((sum, seconds) => sum + seconds, 0);
    return watched >= WATCHED_DAY_SECONDS ? "all" : "none";
  }
  if (rules.every((rule) => ruleKept(rule, day))) return "all";
  return rules.some((rule) => isGoal(rule) && ruleKept(rule, day)) ? "some" : "none";
}

function shiftDay(key: string, by: number): string {
  const [year, month, day] = key.split("-").map(Number);
  return dateKeyOf(new Date(year, month - 1, day + by).getTime());
}

/** `kept(key)` per day from the first logged day to today; today only breaks nothing until it is kept. */
function streakOf(kept: (key: string) => boolean, firstKey: string | null, todayKey: string): { current: number; longest: number } {
  if (!firstKey) return { current: 0, longest: 0 };
  let longest = 0;
  let run = 0;
  for (let key = firstKey; key <= todayKey; key = shiftDay(key, 1)) {
    run = kept(key) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let cursor = kept(todayKey) ? todayKey : shiftDay(todayKey, -1);
  let current = 0;
  while (cursor >= firstKey && kept(cursor)) {
    current += 1;
    cursor = shiftDay(cursor, -1);
  }
  return { current, longest };
}

export function goalStreaks(
  entries: readonly WatchEntry[],
  rules: readonly LanguageLimit[],
  now: number = Date.now(),
  overrides: LanguageOverrides | null = null
): GoalStreaks {
  const totals = dayTotalsOf(entries, overrides);
  const todayKey = dateKeyOf(now);
  const firstKey = [...totals.keys()].sort()[0] ?? null;
  const allKept = (key: string) => dayStatusOf(rules, totals.get(key)) === "all";
  const { current, longest } = streakOf(allKept, firstKey, todayKey);

  const today = new Date(now);
  const mondayOffset = (today.getDay() + 6) % 7;
  const calendarStart = shiftDay(todayKey, -mondayOffset - (CALENDAR_WEEKS - 1) * 7);
  const calendar: GoalStreaks["calendar"] = [];
  for (let index = 0; index < CALENDAR_WEEKS * 7; index++) {
    const key = shiftDay(calendarStart, index);
    const status: DayStatus = key > todayKey ? "future" : !firstKey || key < firstKey ? "before" : dayStatusOf(rules, totals.get(key));
    calendar.push({ key, status });
  }

  return {
    mode: rules.length > 0 ? "rules" : "watching",
    current,
    longest,
    calendar,
    rules: rules.map((rule) => ({ ...rule, ...streakOf((key) => ruleKept(rule, totals.get(key)), firstKey, todayKey) })),
  };
}
