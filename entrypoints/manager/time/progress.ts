import { formatMinutesWords, type TimeSummaryResponse } from "../../../utils/timeUi";
import type { WatchSummary } from "../../../utils/watchLog";
import { isGoal, languageKey, type LanguageLimitUsage } from "../../../utils/languageLimits";
import { durationFieldHtml } from "../../../utils/controls";
import type { LanguageHoursRow } from "../../../utils/languageHours";
import { UNKNOWN_LANGUAGE } from "../facets";
import { colorOfLanguage, languageColorMap, languageMarkHtml } from "./html";
import { escapeHtml } from "../util";

const EMPTY = `<span class="text-text-muted">—</span>`;

function hoursWords(hours: number): string {
  return hours < 10 ? `${(Math.floor(hours * 10) / 10).toLocaleString()} h` : `${Math.floor(hours).toLocaleString()} h`;
}

function goalCellHtml(rules: LanguageLimitUsage[], todaySeconds: number): string {
  const lines = rules.map((rule) => {
    const target = rule.minutes * 60;
    if (isGoal(rule)) {
      const met = todaySeconds >= target;
      return `<span class="block whitespace-nowrap tabular-nums">${formatMinutesWords(target)}${met ? ` <span class="text-success text-xs">✓ Done</span>` : ""}</span>`;
    }
    return `<span class="block whitespace-nowrap text-xs text-text-muted">At most ${formatMinutesWords(target)}</span>`;
  });
  return lines.length > 0 ? lines.join("") : EMPTY;
}

/** One row per language that was watched in the range, has a goal or limit, or has listening hours. */
export function languagesTableHtml(data: TimeSummaryResponse, range: number): string {
  const { watch, limits, hours = [] } = data;
  const colors = languageColorMap(watch);
  const todayByKey = new Map(Object.entries(watch.days[watch.days.length - 1]?.languages ?? {}).map(([label, seconds]) => [languageKey(label), seconds]));
  const rangeByKey = new Map(watch.byLanguage.map((row) => [languageKey(row.label), row]));
  const hoursByKey = new Map(hours.map((row) => [languageKey(row.language), row]));
  const rulesByKey = new Map<string, LanguageLimitUsage[]>();
  for (const rule of limits) {
    const key = languageKey(rule.language);
    rulesByKey.set(key, [...(rulesByKey.get(key) ?? []), rule]);
  }

  const labels = new Map<string, string>();
  for (const label of [...watch.byLanguage.map((row) => row.label), ...limits.map((rule) => rule.language), ...hours.map((row) => row.language)]) {
    if (label !== UNKNOWN_LANGUAGE && !labels.has(languageKey(label))) labels.set(languageKey(label), label);
  }
  if (labels.size === 0) return `<p class="text-sm text-text-muted m-0">Nothing watched yet.</p>`;

  const keys = [...labels.keys()].sort(
    (first, second) =>
      (rangeByKey.get(second)?.seconds ?? 0) - (rangeByKey.get(first)?.seconds ?? 0) ||
      (hoursByKey.get(second)?.hours ?? 0) - (hoursByKey.get(first)?.hours ?? 0) ||
      labels.get(first)!.localeCompare(labels.get(second)!)
  );
  const rowsHtml = keys
    .map((key) => {
      const label = labels.get(key)!;
      const todaySeconds = todayByKey.get(key) ?? 0;
      const rangeSeconds = rangeByKey.get(key)?.seconds ?? 0;
      const allHours = hoursByKey.get(key)?.hours ?? 0;
      return `<tr class="border-t border-border/60">
        <th scope="row" class="py-2.5 pr-3 text-left font-normal min-w-0">
          <span class="flex items-center gap-2 font-medium text-text-primary min-w-0">${languageMarkHtml(label, colorOfLanguage(colors, label))}<span class="truncate">${escapeHtml(label)}</span></span>
        </th>
        <td class="py-2.5 pr-3 text-right tabular-nums whitespace-nowrap text-text-secondary">${todaySeconds > 0 ? formatMinutesWords(todaySeconds) : EMPTY}</td>
        <td class="py-2.5 pr-3 text-right whitespace-nowrap text-text-secondary">${goalCellHtml(rulesByKey.get(key) ?? [], todaySeconds)}</td>
        <td class="py-2.5 pr-3 text-right tabular-nums whitespace-nowrap text-text-secondary">${rangeSeconds > 0 ? formatMinutesWords(rangeSeconds) : EMPTY}</td>
        <td class="py-2.5 text-right tabular-nums whitespace-nowrap text-text-secondary">${allHours > 0 ? hoursWords(allHours) : EMPTY}</td>
      </tr>`;
    })
    .join("");
  const head = "font-semibold pb-2 pr-3 text-[11px] uppercase tracking-[0.1em] text-text-muted";
  return `<div class="overflow-x-auto">
    <table class="w-full border-collapse text-sm">
      <caption class="sr-only">Languages with today's time, daily goal, time in the selected range and all-time hours</caption>
      <thead><tr>
        <th scope="col" class="${head} text-left">Language</th>
        <th scope="col" class="${head} text-right">Today</th>
        <th scope="col" class="${head} text-right">Daily goal</th>
        <th scope="col" class="${head} text-right">Last ${range} days</th>
        <th scope="col" class="${head} text-right">All time</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>`;
}

/** The hours-of-listening forms, kept inside the collapsed "Edit goals" area. */
export function hoursEditHtml(rows: LanguageHoursRow[], watch: WatchSummary): string {
  if (rows.length === 0) return "";
  const colors = languageColorMap(watch);
  const forms = rows
    .map((row) => {
      const key = escapeHtml(languageKey(row.language));
      const language = escapeHtml(row.language);
      return `<div class="flex flex-col gap-2 py-3 border-t border-border/60">
        <span class="flex items-center gap-2 text-sm font-medium text-text-primary min-w-0">${languageMarkHtml(row.language, colorOfLanguage(colors, row.language))}<span class="truncate">${language}</span></span>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <form class="hours-add flex items-center gap-2" data-language="${language}">
            ${durationFieldHtml({ name: "amount", bareUnit: "h", step: 30, required: true, placeholder: "e.g. 3 h", ariaLabel: `Listening time to add for ${row.language}` })}
            <button type="submit" class="chip h-8 text-xs">Add time</button>
          </form>
          <form class="hours-form flex items-center gap-2" data-language="${language}">
            <label class="text-xs text-text-secondary" for="hours-${key}">Hours before the extension</label>
            <input id="hours-${key}" name="hours" type="number" min="0" max="20000" step="0.5" value="${row.earlierHours || ""}" placeholder="0" class="ui-field w-24 tabular-nums" />
            <button type="submit" class="chip h-8 text-xs">Save</button>
          </form>
        </div>
      </div>`;
    })
    .join("");
  return `<div class="flex flex-col">
    <h3 class="text-sm font-semibold text-text-secondary m-0">Listening hours</h3>
    ${forms}
    <p class="text-xs text-text-muted m-0 pt-2">Hours before the extension count toward the all-time total.</p>
  </div>`;
}
