import { languageCodeOf } from "./languageFlags";
import type { LanguageHoursRow } from "./languageHours";
import { languageKey } from "./languageLimits";
import type { WatchSummary } from "./watchLog";

/**
 * The languages someone follows. Everything else is still counted, folded into one "Other"
 * row so totals stay honest while charts and lists show only what matters to them.
 */

export const FOCUS_LANGUAGES_KEY = "focusLanguages";
export const OTHER_LANGUAGES = "Other";

/** The watch log, the queue and overrides can name one language differently ("Slovak", "slovaki", "sk"), so they meet on the code. */
export function focusKeyOf(label: string): string {
  return languageCodeOf(label) ?? languageKey(label);
}

export function parseFocusLanguages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((each): each is string => typeof each === "string" && each.trim() !== "").map(focusKeyOf))];
}

export async function loadFocusLanguages(): Promise<string[]> {
  if (!browser.storage?.local) return [];
  const stored = await browser.storage.local.get(FOCUS_LANGUAGES_KEY);
  return parseFocusLanguages(stored[FOCUS_LANGUAGES_KEY]);
}

export async function saveFocusLanguages(keys: string[]): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [FOCUS_LANGUAGES_KEY]: parseFocusLanguages(keys) });
}

/** With nothing picked every language is followed, so the setting never hides data until it is used. */
export function isFocusLanguage(focus: readonly string[], label: string): boolean {
  return focus.length === 0 || focus.includes(focusKeyOf(label));
}

export function focusLabelOf(focus: readonly string[], label: string): string {
  return isFocusLanguage(focus, label) ? label : OTHER_LANGUAGES;
}

function addSeconds(target: Record<string, number>, label: string, seconds: number): void {
  target[label] = (target[label] ?? 0) + seconds;
}

/** Folds every language outside `focus` into one row, last in order. Videos keep their own language. */
export function focusWatchSummary(watch: WatchSummary, focus: readonly string[]): WatchSummary {
  if (focus.length === 0) return watch;
  const days = watch.days.map((day) => {
    const languages: Record<string, number> = {};
    for (const [label, seconds] of Object.entries(day.languages)) addSeconds(languages, focusLabelOf(focus, label), seconds);
    return { ...day, languages };
  });
  const kept = watch.byLanguage.filter((row) => isFocusLanguage(focus, row.label));
  const rest = watch.byLanguage.filter((row) => !isFocusLanguage(focus, row.label));
  const otherVideos = new Set(watch.videos.filter((video) => !isFocusLanguage(focus, video.language)).map((video) => video.videoId)).size;
  const byLanguage = rest.length > 0 ? [...kept, { label: OTHER_LANGUAGES, seconds: rest.reduce((sum, row) => sum + row.seconds, 0), videos: otherVideos }] : kept;
  const byChannel = watch.byChannel.map((channel) => ({ ...channel, language: focusLabelOf(focus, channel.language) }));
  return { ...watch, days, byLanguage, byChannel };
}

export function focusHoursRows(rows: readonly LanguageHoursRow[], focus: readonly string[]): LanguageHoursRow[] {
  return rows.filter((row) => isFocusLanguage(focus, row.language));
}
