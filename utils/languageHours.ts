import { englishLanguageName } from "./languageFlags";
import { isGoal, languageKey, type LanguageLimit } from "./languageLimits";
import type { LanguageOverrides } from "./languageOverrides";
import { entryLanguage, languageLabelOf, UNKNOWN_LANGUAGE, type WatchEntry } from "./watchLog";

/**
 * Lifetime listening hours per language, counted toward milestones. The watch log forgets entries after a year,
 * so their time is folded into `archived` before it goes; `earlier` holds hours the user had before the extension.
 */

export interface LanguageHoursStore {
  earlier: Record<string, number>;
  archived: Record<string, number>;
}

export interface LanguageHoursRow {
  language: string;
  hours: number;
  earlierHours: number;
  /** The milestone already passed, 0 before the first. */
  reached: number;
  /** null once every milestone is behind. */
  next: number | null;
  /** Share of the way from `reached` to `next`. */
  progress: number;
  /** Average over the pace window, in seconds a day. */
  dailySeconds: number;
  /** Days to the next milestone at that pace, null without a pace or a next milestone. */
  daysToNext: number | null;
}

export const LANGUAGE_HOURS_KEY = "languageHours";
export const MILESTONE_HOURS = [10, 50, 150, 300, 600, 1000, 1500] as const;
export const PACE_DAYS = 28;
const MAX_EARLIER_HOURS = 20_000;
const FALLBACK_LANGUAGES = 3;

export function emptyLanguageHours(): LanguageHoursStore {
  return { earlier: {}, archived: {} };
}

function cleanNumbers(raw: unknown, max: number): Record<string, number> {
  const clean: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return clean;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    // Older stores keyed by name ("slovak", "slovaki") meet on one code now, so their hours add up.
    const code = languageKey(key);
    clean[code] = Math.min((clean[code] ?? 0) + value, max);
  }
  return clean;
}

export function cleanLanguageHours(raw: unknown): LanguageHoursStore {
  const store = (raw ?? {}) as Partial<LanguageHoursStore>;
  return { earlier: cleanNumbers(store.earlier, MAX_EARLIER_HOURS), archived: cleanNumbers(store.archived, Number.MAX_SAFE_INTEGER) };
}

export async function loadLanguageHours(): Promise<LanguageHoursStore> {
  if (!browser.storage?.local) return emptyLanguageHours();
  const data = await browser.storage.local.get(LANGUAGE_HOURS_KEY);
  return cleanLanguageHours(data[LANGUAGE_HOURS_KEY]);
}

export async function saveLanguageHours(store: LanguageHoursStore): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [LANGUAGE_HOURS_KEY]: store });
}

export function setEarlierHours(store: LanguageHoursStore, language: string, hours: number): LanguageHoursStore {
  const earlier = { ...store.earlier };
  const key = languageKey(language);
  if (Number.isFinite(hours) && hours > 0) earlier[key] = Math.min(Math.round(hours * 100) / 100, MAX_EARLIER_HOURS);
  else delete earlier[key];
  return { ...store, earlier };
}

/** Called with the entries a trim is about to drop. */
export function archiveEntries(store: LanguageHoursStore, dropped: readonly WatchEntry[]): LanguageHoursStore {
  if (dropped.length === 0) return store;
  const archived = { ...store.archived };
  for (const entry of dropped) {
    const key = languageKey(languageLabelOf(entry.languageName, entry.language));
    archived[key] = (archived[key] ?? 0) + entry.playedSeconds;
  }
  return { ...store, archived };
}

export function milestoneProgress(hours: number): Pick<LanguageHoursRow, "reached" | "next" | "progress"> {
  let reached = 0;
  for (const milestone of MILESTONE_HOURS) if (hours >= milestone) reached = milestone;
  const next = MILESTONE_HOURS.find((milestone) => milestone > hours) ?? null;
  const progress = next === null ? 1 : (hours - reached) / (next - reached);
  return { reached, next, progress };
}

/**
 * Rows for languages with a daily goal and any with earlier hours. Without either, the most watched languages
 * stand in, so the section is never empty for someone who has not set goals.
 */
export function languageHoursRows(
  entries: readonly WatchEntry[],
  store: LanguageHoursStore,
  rules: readonly LanguageLimit[],
  now: number = Date.now(),
  overrides: LanguageOverrides | null = null
): LanguageHoursRow[] {
  const paceFloor = now - PACE_DAYS * 86_400_000;
  const totals = new Map<string, { label: string; seconds: number; recent: number }>();
  const add = (label: string, seconds: number, recent: number) => {
    const key = languageKey(label);
    const row = totals.get(key) ?? { label, seconds: 0, recent: 0 };
    row.seconds += seconds;
    row.recent += recent;
    totals.set(key, row);
  };
  for (const entry of entries) {
    const label = entryLanguage(entry, overrides);
    if (label === UNKNOWN_LANGUAGE) continue;
    add(label, entry.playedSeconds, entry.startedAt >= paceFloor ? entry.playedSeconds : 0);
  }

  const chosen = new Map<string, string>();
  for (const rule of rules) if (isGoal(rule)) chosen.set(languageKey(rule.language), rule.language);
  for (const key of Object.keys(store.earlier)) {
    if (!chosen.has(key)) chosen.set(key, totals.get(key)?.label ?? englishLanguageName(key) ?? key.charAt(0).toUpperCase() + key.slice(1));
  }
  if (chosen.size === 0) {
    [...totals.entries()]
      .sort((first, second) => second[1].seconds - first[1].seconds)
      .slice(0, FALLBACK_LANGUAGES)
      .forEach(([key, row]) => chosen.set(key, row.label));
  }

  const rows = [...chosen].map(([key, fallbackLabel]) => {
    const total = totals.get(key);
    const earlierHours = store.earlier[key] ?? 0;
    const hours = ((total?.seconds ?? 0) + (store.archived[key] ?? 0)) / 3600 + earlierHours;
    const dailySeconds = (total?.recent ?? 0) / PACE_DAYS;
    const milestone = milestoneProgress(hours);
    const daysToNext =
      milestone.next !== null && dailySeconds >= 60 ? Math.ceil(((milestone.next - hours) * 3600) / dailySeconds) : null;
    return { language: total?.label ?? fallbackLabel, hours, earlierHours, dailySeconds, daysToNext, ...milestone };
  });
  return rows.sort((first, second) => second.hours - first.hours);
}
