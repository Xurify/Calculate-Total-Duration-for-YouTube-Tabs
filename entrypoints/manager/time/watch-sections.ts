import type { TimeTrackingPrefs } from "../../../utils/timeLog";
import { formatMinutesWords } from "../../../utils/timeUi";
import type { WatchSummary } from "../../../utils/watchLog";
import { colorOfLanguage, languageColorMap, longDate, weekdayShort } from "./html";
import { timeRange } from "./panel";
import { escapeHtml } from "../util";

/** Minutes watched per day, stacked by language. The summary is what a screen reader gets in place of the bars. */
export function dayChartHtml(watch: WatchSummary, prefs: TimeTrackingPrefs): string {
  if (watch.total.playedSeconds <= 0) {
    return `<p class="text-sm text-text-muted m-0">${prefs.watchHistory ? "Nothing watched yet." : "Watch history is off."}</p>`;
  }
  const colors = languageColorMap(watch);
  const peakDay = Math.max(60, ...watch.days.map((day) => day.seconds));
  const dense = watch.days.length > 30;
  const order = watch.byLanguage.map((row) => row.label);
  const bars = watch.days
    .map((day, index) => {
      const segments = order
        .filter((label) => (day.languages[label] ?? 0) > 0)
        .map((label) => `<div class="w-full shrink-0 ${dense ? "" : "rounded-[3px]"}" style="height:${((day.languages[label] / peakDay) * 100).toFixed(2)}%;background:${colorOfLanguage(colors, label)}"></div>`)
        .join("");
      const breakdown = order.filter((label) => (day.languages[label] ?? 0) >= 60).map((label) => `${label}: ${formatMinutesWords(day.languages[label])}`);
      const tip = [`${longDate(day.key)}: ${formatMinutesWords(day.seconds)}`, ...breakdown].join("\n");
      const label = timeRange === 7 ? weekdayShort(day.key) : !dense || index % 15 === 0 ? day.key.slice(dense ? 5 : 8) : "";
      return `<div class="flex flex-col items-center gap-1.5 min-w-0" title="${escapeHtml(tip)}">
        <div class="w-full h-40 flex flex-col-reverse ${dense ? "" : "gap-[2px]"} rounded-md bg-surface-elevated overflow-hidden">${segments}</div>
        <span class="text-[11px] text-text-muted tabular-nums whitespace-nowrap">${label || "&nbsp;"}</span>
        ${dense ? "" : `<span class="font-display text-[13px] text-text-secondary tabular-nums whitespace-nowrap">${day.seconds >= 60 ? formatMinutesWords(day.seconds) : "·"}</span>`}
      </div>`;
    })
    .join("");
  const busiest = watch.days.reduce((best, day) => (day.seconds > best.seconds ? day : best), watch.days[0]);
  const summary = [
    `Minutes watched per day, by language. ${formatMinutesWords(watch.total.playedSeconds)} in total.`,
    busiest.seconds >= 60 ? `Most on ${longDate(busiest.key)}, ${formatMinutesWords(busiest.seconds)}.` : "",
    watch.byLanguage.length > 0 ? `Languages: ${watch.byLanguage.map((row) => `${row.label} ${formatMinutesWords(row.seconds)}`).join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const legend = watch.byLanguage
    .map((row) => `<span class="flex items-center gap-1.5"><span class="legend-swatch" style="background:${colorOfLanguage(colors, row.label)}" aria-hidden="true"></span>${escapeHtml(row.label)}</span>`)
    .join("");
  return `<section class="flex flex-col gap-3 time-card">
    <h2 class="font-display text-[22px] font-medium m-0">Minutes watched per day, by language</h2>
    <div class="grid ${dense ? "gap-px" : "gap-2"}" style="grid-template-columns: repeat(${watch.days.length}, minmax(0, 1fr))" role="img" aria-label="${escapeHtml(summary)}">${bars}</div>
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">${legend}</div>
  </section>`;
}
