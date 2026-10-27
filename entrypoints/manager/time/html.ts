import type { WatchSummary } from "../../../utils/watchLog";
import { englishLanguageName, languageFlagHtml } from "../../../utils/languageFlags";
import { UNKNOWN_LANGUAGE } from "../facets";
import { languageColor as sharedLanguageColor, NO_LANGUAGE_COLOR } from "../../../utils/languageColor";
import { escapeHtml } from "../util";

export const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
export const CHEVRON_RIGHT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-text-muted transition-transform" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

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

export function hourWords(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

export function shareWords(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

export function speedWords(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, "")}×`;
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const TIME_ICON_PATHS = {
  videos: `<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/>`,
  speed: `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`,
  subtitles: `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>`,
  background: `<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>`,
  streak: `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
  ads: `<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>`,
  day: `<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>`,
  languages: `<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`,
  channels: `<rect x="2" y="7" width="20" height="15" rx="2"/><path d="m17 2-5 5-5-5"/>`,
  list: `<path d="M12 12H3M16 6H3M12 18H3"/><path d="m16 12 5 3-5 3v-6z"/>`,
  limit: `<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>`,
  goal: `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>`,
  export: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`,
};

type TimeIcon = keyof typeof TIME_ICON_PATHS;

function timeIconHtml(icon: TimeIcon, size: number, className = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 ${className}" aria-hidden="true">${TIME_ICON_PATHS[icon]}</svg>`;
}

export function timeSectionHeading(title: string, extra = "", icon?: TimeIcon): string {
  return `<div class="flex items-center gap-3 flex-wrap"><h2 class="font-display text-[22px] font-medium m-0 flex-1 flex items-center gap-2">${icon ? timeIconHtml(icon, 18, "text-text-muted") : ""}${escapeHtml(title)}</h2>${extra}</div>`;
}

export function languageMarkHtml(label: string, color: string): string {
  return languageFlagHtml(label) || `<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>`;
}

export const WEEKDAY_NAMES = Array.from({ length: 7 }, (_item, index) => new Date(2024, 0, 1 + index).toLocaleDateString(undefined, { weekday: "short" }));

export function watchStatTile(label: string, value: string, note: string, icon: TimeIcon): string {
  return `<div class="flex flex-col gap-0.5 min-w-0 rounded-[10px] border border-border bg-surface-elevated px-4 py-3">
    <span class="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] text-text-muted">${timeIconHtml(icon, 13)}${escapeHtml(label)}</span>
    <span class="font-display text-[26px] leading-tight text-text-primary tabular-nums truncate">${escapeHtml(value)}</span>
    <span class="text-xs text-text-muted truncate min-h-4">${escapeHtml(note)}</span>
  </div>`;
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
  watch.byLanguage.forEach((row) => colors.set(row.label, row.label === UNKNOWN_LANGUAGE ? NO_LANGUAGE_COLOR : sharedLanguageColor(row.label)));
  return colors;
}

export function colorOfLanguage(colors: Map<string, string>, label: string): string {
  return colors.get(label) ?? (label === UNKNOWN_LANGUAGE ? NO_LANGUAGE_COLOR : sharedLanguageColor(label));
}
