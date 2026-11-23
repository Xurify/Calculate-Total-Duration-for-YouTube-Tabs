import type { WatchSummary } from "../../../utils/watchLog";
import { OTHER_LANGUAGES } from "../../../utils/focusLanguages";
import { englishLanguageName, languageFlagHtml } from "../../../utils/languageFlags";
import { UNKNOWN_LANGUAGE } from "../facets";
import { languageColor as sharedLanguageColor, NO_LANGUAGE_COLOR } from "../../../utils/languageColor";
import { escapeHtml } from "../util";

export const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;

export function weekdayShort(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "short" });
}

export function longDate(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

export function timeAgoWords(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function languageMarkHtml(label: string, color: string): string {
  return languageFlagHtml(label) || `<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>`;
}

export function languageTagInnerHtml(label: string): string {
  if (!label) return "";
  return `${languageFlagHtml(label, "lang-flag lang-flag--xs")}${escapeHtml(englishLanguageName(label) ?? label)}`;
}

export function languageDot(color: string): string {
  return `<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>`;
}

export function languageColorMap(watch: WatchSummary): Map<string, string> {
  const colors = new Map<string, string>();
  watch.byLanguage.forEach((row) => colors.set(row.label, row.label === UNKNOWN_LANGUAGE || row.label === OTHER_LANGUAGES ? NO_LANGUAGE_COLOR : sharedLanguageColor(row.label)));
  return colors;
}

export function colorOfLanguage(colors: Map<string, string>, label: string): string {
  return colors.get(label) ?? (label === UNKNOWN_LANGUAGE ? NO_LANGUAGE_COLOR : sharedLanguageColor(label));
}
