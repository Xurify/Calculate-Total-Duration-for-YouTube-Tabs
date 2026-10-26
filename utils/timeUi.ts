import type { CachedMandalaSummary } from "./storage";
import type { RuleMatch, SiteRule, TimeSummary, TimeTrackingPrefs } from "./timeLog";
import type { LiveTabSectionsState } from "./storage";
import type { LanguageLimitUsage } from "./languageLimits";
import type { GoalStreaks } from "./goals";
import type { WatchSummary } from "./watchLog";
import type { LanguageHoursRow } from "./languageHours";

/** What the popup and the desk ask the background for, and what comes back. */
export interface TimeSummaryResponse {
  summary: TimeSummary;
  watch: WatchSummary;
  limits: LanguageLimitUsage[];
  streaks: GoalStreaks;
  hours?: LanguageHoursRow[];
  prefs: TimeTrackingPrefs;
  rules: SiteRule[];
  mandala: CachedMandalaSummary | null;
  piles: LiveTabSectionsState | null;
  errorMessage?: string;
}

export interface CurrentSiteResponse {
  match: RuleMatch | null;
  todayMinutes: number;
  runningSeconds: number;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function pillarTitleOf(summary: CachedMandalaSummary | null, pillarIndex: number): string {
  return summary?.pillars.find((pillar) => pillar.index === pillarIndex)?.title || `Pillar ${pillarIndex + 1}`;
}

/** The pillars a rule can point at: the named ones, or all eight while the chart is still blank. */
export function pillarChoices(summary: CachedMandalaSummary | null): { index: number; title: string }[] {
  const named = (summary?.pillars ?? []).filter((pillar) => pillar.named !== false && pillar.actionCount > 0);
  if (named.length > 0) return named.map((pillar) => ({ index: pillar.index, title: pillar.title }));
  return Array.from({ length: 8 }, (_item, index) => ({ index, title: pillarTitleOf(summary, index) }));
}

export interface SelectOption {
  value: string;
  label: string;
}

export function pillarSelectOptions(summary: CachedMandalaSummary | null): SelectOption[] {
  return pillarChoices(summary).map((pillar) => ({ value: String(pillar.index), label: pillar.title }));
}

export function actionSelectOptions(summary: CachedMandalaSummary | null, pillarIndex: number): SelectOption[] {
  const actions = summary?.pillars.find((pillar) => pillar.index === pillarIndex)?.actions ?? [];
  const routineFirst = [...actions].sort((first, second) => Number(second.kind === "routine") - Number(first.kind === "routine"));
  return [
    { value: "", label: "Let Mandala pick (its routine)" },
    ...routineFirst.map((action) => ({ value: action.id, label: `${action.text}${action.kind === "routine" ? " · routine" : ""}` })),
  ];
}

export function matchWords(match: RuleMatch, summary: CachedMandalaSummary | null): string {
  const pillar = pillarTitleOf(summary, match.pillarIndex);
  const action = match.actionId ? summary?.pillars.find((each) => each.index === match.pillarIndex)?.actions?.find((each) => each.id === match.actionId)?.text : undefined;
  const by = match.source === "shelf" ? "on the shelf" : match.source === "pile" ? "by its pile" : match.source === "prefix" ? "by this page" : "by this site";
  return action ? `${pillar} · ${action} (${by})` : `${pillar} (${by})`;
}

export function formatMinutesWords(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
