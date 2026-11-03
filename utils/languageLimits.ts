import { languageCodeOf } from "./languageFlags";
import type { LanguageOverrides } from "./languageOverrides";
import { dateKeyOf } from "./timeLog";
import { entryLanguage, UNKNOWN_LANGUAGE, type WatchEntry } from "./watchLog";

/**
 * Daily caps (limits) and minimums (goals) on how long YouTube plays in a language, counted in real time
 * (2× speed counts half), matched against the same language labels the Time page shows.
 */

export interface LanguageLimit {
  language: string;
  minutes: number;
  /** Absent means a limit, so lists saved before goals existed read the same. */
  kind?: "goal";
}

export type LimitLevel = "near" | "over" | "met";

export interface LanguageLimitUsage extends LanguageLimit {
  usedSeconds: number;
  level: LimitLevel | null;
}

export interface LimitWarning {
  language: string;
  minutes: number;
  usedSeconds: number;
  level: LimitLevel;
  kind?: "goal";
}

/** Which levels have been shown today, so each one is shown once. */
export interface LimitWarningsShown {
  day: string;
  levels: Record<string, LimitLevel>;
}

export const LANGUAGE_LIMITS_KEY = "languageLimits";
export const LIMIT_WARNINGS_KEY = "languageLimitWarnings";
export const NEAR_LIMIT_SHARE = 0.8;
export const MAX_LIMIT_MINUTES = 24 * 60;

const LEVEL_RANK: Record<LimitLevel, number> = { near: 1, over: 2, met: 1 };

/** Keyed by code where one is known, so a "Slovak" goal counts videos YouTube labelled "slovaki" or "sk". */
export function languageKey(language: string): string {
  return languageCodeOf(language) ?? language.trim().toLowerCase();
}

export function isGoal(rule: Pick<LanguageLimit, "kind">): boolean {
  return rule.kind === "goal";
}

/** A language can have both a goal and a limit, so rules are told apart by kind as well. */
export function ruleKey(rule: Pick<LanguageLimit, "language" | "kind">): string {
  return isGoal(rule) ? `goal:${languageKey(rule.language)}` : languageKey(rule.language);
}

export function cleanLanguageLimits(raw: unknown): LanguageLimit[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const limits: LanguageLimit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { language, minutes, kind } = item as Partial<LanguageLimit>;
    if (typeof language !== "string" || typeof minutes !== "number" || !Number.isFinite(minutes)) continue;
    const name = language.trim().slice(0, 80);
    const key = ruleKey({ language: name, kind });
    if (!name || languageKey(name) === languageKey(UNKNOWN_LANGUAGE) || seen.has(key)) continue;
    seen.add(key);
    const rounded = Math.min(MAX_LIMIT_MINUTES, Math.max(1, Math.round(minutes)));
    limits.push(kind === "goal" ? { language: name, minutes: rounded, kind } : { language: name, minutes: rounded });
  }
  return limits;
}

const UNIT_MINUTES: Record<string, number> = { h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, m: 1, min: 1, mins: 1, minute: 1, minutes: 1 };

/**
 * Reads an amount typed the way people say it: "45", "45 min", "3h", "1h30", "1:30", "2.5 h".
 * A bare number is in `bareUnit` (minutes by default), except right after hours ("1h 30"). Returns null when the text is not a time.
 */
export function parseDurationMinutes(text: string, bareUnit: "min" | "h" = "min"): number | null {
  const value = text.trim().toLowerCase().replace(",", ".");
  if (!value) return null;
  const clock = /^(\d+):([0-5]?\d)$/.exec(value);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const part = /(\d+(?:\.\d+)?)\s*([a-z]*)\s*/y;
  let total = 0;
  let lastUnit = 0;
  const bare = /^\d+(?:\.\d+)?$/.test(value) && bareUnit === "h" ? 60 : 1;
  while (part.lastIndex < value.length) {
    const match = part.exec(value);
    if (!match) return null;
    const unit = match[2] ? UNIT_MINUTES[match[2]] : lastUnit === 1 ? null : bare;
    if (!unit) return null;
    total += Number(match[1]) * unit;
    lastUnit = unit;
  }
  return Math.round(total);
}

export function formatDurationInput(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Steps grow with the amount, so going from 30 min to 3 h takes a handful of presses rather than thirty. */
export function stepDurationMinutes(minutes: number, direction: 1 | -1): number {
  const stepAt = (value: number) => (value < 60 ? 5 : value < 180 ? 15 : 30);
  const step = stepAt(direction === 1 ? minutes : minutes - 1);
  const next = direction === 1 ? Math.floor(minutes / step) * step + step : Math.ceil(minutes / step) * step - step;
  return Math.min(MAX_LIMIT_MINUTES, Math.max(1, next));
}

export async function loadLanguageLimits(): Promise<LanguageLimit[]> {
  if (!browser.storage?.local) return [];
  const data = await browser.storage.local.get(LANGUAGE_LIMITS_KEY);
  return cleanLanguageLimits(data[LANGUAGE_LIMITS_KEY]);
}

export async function saveLanguageLimits(limits: LanguageLimit[]): Promise<LanguageLimit[]> {
  const cleaned = cleanLanguageLimits(limits);
  if (browser.storage?.local) await browser.storage.local.set({ [LANGUAGE_LIMITS_KEY]: cleaned });
  return cleaned;
}

export function levelOf(usedSeconds: number, minutes: number, kind?: "goal"): LimitLevel | null {
  const limitSeconds = minutes * 60;
  if (kind === "goal") return usedSeconds >= limitSeconds ? "met" : null;
  if (usedSeconds >= limitSeconds) return "over";
  if (usedSeconds >= limitSeconds * NEAR_LIMIT_SHARE) return "near";
  return null;
}

/** A sitting is filed under the day it started, like the Time page's day bars. */
export function secondsTodayByLanguage(entries: readonly WatchEntry[], now: number, overrides: LanguageOverrides | null): Map<string, number> {
  const today = dateKeyOf(now);
  const totals = new Map<string, number>();
  for (const entry of entries) {
    if (entry.playedSeconds <= 0 || dateKeyOf(entry.startedAt) !== today) continue;
    const key = languageKey(entryLanguage(entry, overrides));
    totals.set(key, (totals.get(key) ?? 0) + entry.playedSeconds);
  }
  return totals;
}

export function limitUsage(
  limits: readonly LanguageLimit[],
  entries: readonly WatchEntry[],
  now: number = Date.now(),
  overrides: LanguageOverrides | null = null
): LanguageLimitUsage[] {
  const totals = secondsTodayByLanguage(entries, now, overrides);
  return limits.map((limit) => {
    const usedSeconds = totals.get(languageKey(limit.language)) ?? 0;
    return { ...limit, usedSeconds, level: levelOf(usedSeconds, limit.minutes, limit.kind) };
  });
}

export interface LanguageTodayRow {
  language: string;
  usedSeconds: number;
  /** Set when the row comes from a rule. */
  minutes?: number;
  kind?: "goal";
  level: LimitLevel | null;
}

/** The popup's "today" strip: every rule first, then the most-watched languages that have no rule. */
export function languageTodayRows(
  limits: readonly LanguageLimit[],
  entries: readonly WatchEntry[],
  now: number = Date.now(),
  overrides: LanguageOverrides | null = null,
  max = 3
): LanguageTodayRow[] {
  const today = dateKeyOf(now);
  const watched = new Map<string, { language: string; usedSeconds: number }>();
  for (const entry of entries) {
    if (entry.playedSeconds <= 0 || dateKeyOf(entry.startedAt) !== today) continue;
    const language = entryLanguage(entry, overrides);
    if (language === UNKNOWN_LANGUAGE) continue;
    const row = watched.get(languageKey(language)) ?? { language, usedSeconds: 0 };
    row.usedSeconds += entry.playedSeconds;
    watched.set(languageKey(language), row);
  }
  const rules: LanguageTodayRow[] = limitUsage(limits, entries, now, overrides).sort(
    (a, b) => Number(isGoal(a)) - Number(isGoal(b)) || b.usedSeconds / (b.minutes * 60) - a.usedSeconds / (a.minutes * 60)
  );
  const ruled = new Set(rules.map((rule) => languageKey(rule.language)));
  const others: LanguageTodayRow[] = [...watched.entries()]
    .filter(([key]) => !ruled.has(key))
    .map(([, row]) => ({ ...row, level: null }))
    .sort((a, b) => b.usedSeconds - a.usedSeconds);
  return [...rules, ...others].slice(0, max);
}

/**
 * Warnings that are new since `shown`, plus what to store next. A level that drops (the limit was raised)
 * is forgotten, so crossing it again warns again.
 */
export function newLimitWarnings(
  usage: readonly LanguageLimitUsage[],
  shown: LimitWarningsShown | null,
  now: number = Date.now()
): { warnings: LimitWarning[]; shown: LimitWarningsShown } {
  const day = dateKeyOf(now);
  const previous = shown?.day === day ? shown.levels : {};
  const levels: Record<string, LimitLevel> = {};
  const warnings: LimitWarning[] = [];
  for (const row of usage) {
    if (!row.level) continue;
    const key = ruleKey(row);
    levels[key] = row.level;
    const before = previous[key];
    if (!before || LEVEL_RANK[row.level] > LEVEL_RANK[before]) {
      const warning: LimitWarning = { language: row.language, minutes: row.minutes, usedSeconds: row.usedSeconds, level: row.level };
      if (row.kind) warning.kind = row.kind;
      warnings.push(warning);
    }
  }
  return { warnings, shown: { day, levels } };
}

export async function loadLimitWarningsShown(): Promise<LimitWarningsShown | null> {
  if (!browser.storage?.local) return null;
  const data = await browser.storage.local.get(LIMIT_WARNINGS_KEY);
  const raw = data[LIMIT_WARNINGS_KEY] as Partial<LimitWarningsShown> | undefined;
  return raw && typeof raw.day === "string" && raw.levels && typeof raw.levels === "object" ? { day: raw.day, levels: { ...raw.levels } } : null;
}

export async function saveLimitWarningsShown(shown: LimitWarningsShown): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [LIMIT_WARNINGS_KEY]: shown });
}
