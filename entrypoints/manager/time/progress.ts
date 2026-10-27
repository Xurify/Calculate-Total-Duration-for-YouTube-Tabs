import { dateKeyOf } from "../../../utils/timeLog";
import { formatMinutesWords } from "../../../utils/timeUi";
import type { WatchSummary } from "../../../utils/watchLog";
import { isGoal, languageKey } from "../../../utils/languageLimits";
import { CALENDAR_WEEKS, type GoalStreaks } from "../../../utils/goals";
import { MILESTONE_HOURS, type LanguageHoursRow } from "../../../utils/languageHours";
import { durationFieldHtml } from "../../../utils/controls";
import {
  colorOfLanguage,
  languageColorMap,
  languageMarkHtml,
  longDate,
  plural,
  timeSectionHeading,
  WEEKDAY_NAMES,
} from "./html";
import { escapeHtml } from "../util";

export function streakSectionHtml(streaks: GoalStreaks, watch: WatchSummary): string {
  const colors = languageColorMap(watch);
  const byRules = streaks.mode === "rules";
  const goals = streaks.rules.filter((rule) => isGoal(rule)).length;
  const what = !byRules ? "Days with at least a minute watched" : goals > 0 ? "Days that reached every goal and kept every limit" : "Days that kept every limit";
  const statusWords: Record<string, string> = {
    all: byRules ? "Everything kept" : "Watched",
    some: "Some goals reached",
    none: byRules ? "Not kept" : "Nothing watched",
    before: "Before your history",
    future: "",
  };
  const weeks: string[] = [];
  for (let week = 0; week < CALENDAR_WEEKS; week++) {
    const days = streaks.calendar.slice(week * 7, week * 7 + 7);
    weeks.push(
      `<div class="flex flex-col gap-1.5">${days
        .map((day) => {
          const today = day.key === dateKeyOf(Date.now());
          const words = today && day.status !== "all" ? "Today, still open" : statusWords[day.status];
          return `<span class="streak-day streak-day--${day.status}${today ? " streak-day--today" : ""}"${day.status === "future" ? "" : ` title="${escapeHtml(`${longDate(day.key)}${words ? `\n${words}` : ""}`)}"`}></span>`;
        })
        .join("")}</div>`
    );
  }
  const dayLabels = WEEKDAY_NAMES.map((name) => `<span class="h-[26px] leading-[26px] text-[11px] text-text-muted">${name}</span>`).join("");
  const rulesHtml = streaks.rules
    .map(
      (rule) => `<li class="flex items-center gap-2.5 py-2 border-b border-border/60 text-sm">
        ${languageMarkHtml(rule.language, colorOfLanguage(colors, rule.language))}
        <span class="flex-1 min-w-0 truncate text-text-primary">${escapeHtml(rule.language)} <span class="text-text-muted">${isGoal(rule) ? "goal" : "limit kept"}</span></span>
        <span class="font-display text-lg tabular-nums text-text-primary">${rule.current}</span>
        <span class="w-9 text-xs text-text-muted">${rule.current === 1 ? "day" : "days"}</span>
      </li>`
    )
    .join("");
  const legend = (byRules ? (["all", "some", "none"] as const) : (["all", "none"] as const))
    .map((status) => `<span class="flex items-center gap-1.5"><span class="streak-day streak-day--${status} legend-swatch"></span>${statusWords[status]}</span>`)
    .join("");
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Streak", "", "streak")}
    <div class="streak-card">
      <div class="flex flex-col gap-4 min-w-0">
        <div>
          <div class="flex items-baseline gap-2"><span class="font-display text-[56px] leading-none tabular-nums text-text-primary">${streaks.current}</span><span class="font-display text-2xl text-text-secondary">${streaks.current === 1 ? "day" : "days"} in a row</span></div>
          <p class="text-xs text-text-muted mt-1.5 mb-0">${escapeHtml(what)} · best ${plural(streaks.longest, "day")}</p>
        </div>
        <div class="flex gap-1.5"><div class="flex flex-col gap-1.5 pr-1">${dayLabels}</div>${weeks.join("")}</div>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">${legend}<span class="flex items-center gap-1.5"><span class="streak-day streak-day--today legend-swatch"></span>Today</span></div>
      </div>
      ${
        rulesHtml
          ? `<div class="min-w-0 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-6"><div class="text-xs text-text-muted mb-1">Each goal and limit</div><ul class="m-0 p-0 list-none">${rulesHtml}</ul></div>`
          : `<div class="min-w-0 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-6 text-sm text-text-muted self-center">Add a daily goal above and the streak counts the days you reach it.</div>`
      }
    </div>
  </section>`;
}

function hoursWords(hours: number): string {
  return hours < 10 ? `${(Math.floor(hours * 10) / 10).toLocaleString()} h` : `${Math.floor(hours).toLocaleString()} h`;
}

function paceWords(row: LanguageHoursRow): string {
  if (row.next === null) return `Every milestone reached. ${formatMinutesWords(row.dailySeconds)} a day lately.`;
  const left = `${hoursWords(Math.max(0.1, row.next - row.hours))} more to reach ${row.next} h`;
  if (row.daysToNext === null) return `${left}. Listen a little each day to see when you'll get there.`;
  const when = row.daysToNext <= 1 ? "about a day" : row.daysToNext < 14 ? `about ${row.daysToNext} days` : row.daysToNext < 60 ? `about ${Math.round(row.daysToNext / 7)} weeks` : `about ${Math.round(row.daysToNext / 30)} months`;
  return `${left}, ${when} at ${formatMinutesWords(row.dailySeconds)} a day.`;
}

/** Equal steps between milestones, so the early ones are not squeezed into a sliver of the bar. */
function milestoneTrackHtml(row: LanguageHoursRow, color: string): string {
  const steps = MILESTONE_HOURS.length;
  const passed = MILESTONE_HOURS.filter((milestone) => row.hours >= milestone).length;
  const fill = row.next === null ? 100 : ((passed + row.progress) / steps) * 100;
  const state = (milestone: number) => (row.hours >= milestone ? "reached" : milestone === row.next ? "next" : "");
  const marks = MILESTONE_HOURS.map((milestone, index) => {
    const kind = state(milestone);
    return `<span class="hours-mark${kind ? ` hours-mark--${kind}` : ""}" style="left:${((index + 1) / steps) * 100}%"></span>`;
  }).join("");
  const labels = MILESTONE_HOURS.map((milestone, index) => {
    const kind = state(milestone);
    return `<span${kind ? ` class="is-${kind}"` : ""} style="left:${((index + 1) / steps) * 100}%">${milestone}</span>`;
  }).join("");
  return `<div role="img" aria-label="${escapeHtml(`${hoursWords(row.hours)} of listening. Milestones at ${MILESTONE_HOURS.join(", ")} hours.`)}" style="--hours-color:${color}">
    <div class="hours-track"><span class="hours-fill" style="width:${fill.toFixed(1)}%"></span>${marks}</div>
    <div class="hours-scale" aria-hidden="true"><span style="left:0">0</span>${labels}</div>
  </div>`;
}

export function languageHoursSectionHtml(rows: LanguageHoursRow[], watch: WatchSummary): string {
  if (rows.length === 0) return "";
  const colors = languageColorMap(watch);
  const cards = rows
    .map((row) => {
      const color = colorOfLanguage(colors, row.language);
      return `<article class="hours-card">
        <header class="flex items-center gap-2 text-sm font-medium text-text-primary">${languageMarkHtml(row.language, color)}<span class="truncate">${escapeHtml(row.language)}</span>
          ${row.reached > 0 ? `<span class="rule-kind rule-kind--goal ml-auto" title="The last milestone you reached">${row.reached} h reached</span>` : ""}
        </header>
        <div class="flex items-baseline gap-2"><span class="font-display text-[44px] leading-none tabular-nums text-text-primary">${escapeHtml(hoursWords(row.hours))}</span><span class="text-sm text-text-muted">of listening</span></div>
        ${milestoneTrackHtml(row, color === "var(--color-border-hover)" ? "var(--color-accent)" : color)}
        <p class="text-xs text-text-secondary m-0">${escapeHtml(paceWords(row))}</p>
        <form class="hours-add flex items-center gap-2" data-language="${escapeHtml(row.language)}">
          ${durationFieldHtml({ name: "amount", bareUnit: "h", step: 30, required: true, placeholder: "e.g. 3 h", ariaLabel: `Listening time to add for ${row.language}` })}
          <button type="submit" class="chip h-8 text-xs">Add time</button>
        </form>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
          <span>${row.earlierHours > 0 ? `Includes ${escapeHtml(hoursWords(row.earlierHours))} from before` : "Counted since Study Harvester was installed"}</span>
          <button type="button" class="hours-edit link-btn whitespace-nowrap" data-language="${escapeHtml(row.language)}">${row.earlierHours > 0 ? "Change" : "Set hours from before"}</button>
        </div>
        <form class="hours-form hidden items-center gap-2" data-language="${escapeHtml(row.language)}">
          <label class="text-xs text-text-secondary" for="hours-${escapeHtml(languageKey(row.language))}">Hours before</label>
          <input id="hours-${escapeHtml(languageKey(row.language))}" name="hours" type="number" min="0" max="20000" step="0.5" value="${row.earlierHours || ""}" placeholder="0" class="ui-field w-24 tabular-nums" />
          <button type="submit" class="chip h-8 text-xs">Save</button>
          <button type="button" class="hours-cancel chip h-8 text-xs">Cancel</button>
        </form>
      </article>`;
    })
    .join("");
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Hours of listening", `<span class="text-xs text-text-muted">All time</span>`, "clock")}
    <div class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">${cards}</div>
    <p class="text-xs text-text-muted m-0">Milestones at ${MILESTONE_HOURS.join(", ")} h are rough markers that comprehensible-input learners count by, not levels. Languages with a daily goal show here.</p>
  </section>`;
}
