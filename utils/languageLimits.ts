import type { LanguageOverrides } from "./languageOverrides";
import { dateKeyOf } from "./timeLog";
import { entryLanguage, UNKNOWN_LANGUAGE, type WatchEntry } from "./watchLog";

/**
 * Daily caps on how long YouTube plays in a language, counted in real time (2× speed counts half),
 * matched against the same language labels the Time page shows.
 */

export interface LanguageLimit {
  language: string;
  minutes: number;
}

export type LimitLevel = "near" | "over";

export interface LanguageLimitUsage extends LanguageLimit {
  usedSeconds: number;
  level: LimitLevel | null;
}

export interface LimitWarning {
  language: string;
  minutes: number;
  usedSeconds: number;
  level: LimitLevel;
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

const LEVEL_RANK: Record<LimitLevel, number> = { near: 1, over: 2 };

export function languageKey(language: string): string {
  return language.trim().toLowerCase();
}

export function cleanLanguageLimits(raw: unknown): LanguageLimit[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const limits: LanguageLimit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { language, minutes } = item as Partial<LanguageLimit>;
    if (typeof language !== "string" || typeof minutes !== "number" || !Number.isFinite(minutes)) continue;
    const name = language.trim().slice(0, 80);
    const key = languageKey(name);
    if (!name || key === languageKey(UNKNOWN_LANGUAGE) || seen.has(key)) continue;
    seen.add(key);
    limits.push({ language: name, minutes: Math.min(MAX_LIMIT_MINUTES, Math.max(1, Math.round(minutes))) });
  }
  return limits;
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

export function levelOf(usedSeconds: number, minutes: number): LimitLevel | null {
  const limitSeconds = minutes * 60;
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
    return { ...limit, usedSeconds, level: levelOf(usedSeconds, limit.minutes) };
  });
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
    const key = languageKey(row.language);
    levels[key] = row.level;
    const before = previous[key];
    if (!before || LEVEL_RANK[row.level] > LEVEL_RANK[before]) {
      warnings.push({ language: row.language, minutes: row.minutes, usedSeconds: row.usedSeconds, level: row.level });
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
