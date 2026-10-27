import type { TimeTrackingPrefs } from "../../../utils/timeLog";
import { formatMinutesWords } from "../../../utils/timeUi";
import type { WatchSummary } from "../../../utils/watchLog";
import { isGoal, ruleKey, type LanguageLimit, type LanguageLimitUsage } from "../../../utils/languageLimits";
import { durationFieldHtml } from "../../../utils/controls";
import { colorOfLanguage, languageColorMap, languageMarkHtml, timeSectionHeading, TRASH_ICON } from "./html";
import { lastTimeResponse, newRuleKind, renderTimePanel } from "./panel";
import { escapeHtml } from "../util";

function ruleStatusHtml(rule: LanguageLimitUsage): string {
  const target = rule.minutes * 60;
  if (isGoal(rule)) {
    return rule.usedSeconds >= target
      ? `<span class="text-success font-medium">✓ Done</span>`
      : `<span class="text-text-muted">${formatMinutesWords(target - rule.usedSeconds)} to go</span>`;
  }
  return rule.usedSeconds > target
    ? `<span class="text-danger font-medium">${formatMinutesWords(rule.usedSeconds - target)} over</span>`
    : `<span class="text-text-muted">${formatMinutesWords(target - rule.usedSeconds)} left</span>`;
}

export function dailyRulesHtml(rules: LanguageLimitUsage[], watch: WatchSummary, prefs: TimeTrackingPrefs): string {
  const colors = languageColorMap(watch);
  const ordered = [...rules].sort((first, second) => Number(isGoal(second)) - Number(isGoal(first)));
  const rowsHtml = ordered
    .map((rule) => {
      const share = Math.min(1, rule.usedSeconds / (rule.minutes * 60));
      const barColor = isGoal(rule)
        ? rule.level === "met"
          ? "var(--color-success)"
          : colorOfLanguage(colors, rule.language)
        : rule.level === "over"
          ? "var(--color-danger)"
          : rule.level === "near"
            ? "var(--color-warning)"
            : "var(--color-accent)";
      const kindWord = isGoal(rule) ? "goal" : "limit";
      return `<li class="grid grid-cols-[minmax(0,10rem)_4.5rem_minmax(0,1fr)_8.5rem_auto_7.5rem_auto] items-center gap-3 text-sm" data-rule="${escapeHtml(ruleKey(rule))}">
        <span class="truncate font-medium text-text-primary flex items-center gap-2">${languageMarkHtml(rule.language, colorOfLanguage(colors, rule.language))}<span class="truncate">${escapeHtml(rule.language)}</span></span>
        <span class="rule-kind${isGoal(rule) ? " rule-kind--goal" : ""}">${isGoal(rule) ? "At least" : "At most"}</span>
        <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex" role="meter" aria-valuemin="0" aria-valuemax="${rule.minutes}" aria-valuenow="${Math.floor(rule.usedSeconds / 60)}" aria-label="${escapeHtml(rule.language)} ${kindWord} today"><span class="h-full rounded-full transition-[width] duration-500" style="width:${Math.max(share > 0 ? 2 : 0, share * 100)}%;background:${barColor}"></span></span>
        <span class="text-right text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(rule.usedSeconds)} <span class="text-text-muted">of</span></span>
        ${durationFieldHtml({ minutes: rule.minutes, className: "time-rule-minutes", required: true, ariaLabel: `Daily time for the ${rule.language} ${kindWord}`, attributes: { "data-language": rule.language, "data-kind": rule.kind ?? "" } })}
        <span class="text-xs whitespace-nowrap">${ruleStatusHtml(rule)}</span>
        <button type="button" class="time-rule-delete icon-btn w-8 h-8 hover:text-danger" data-language="${escapeHtml(rule.language)}" data-kind="${escapeHtml(rule.kind ?? "")}" title="Remove the ${escapeHtml(rule.language)} ${kindWord}">${TRASH_ICON}</button>
      </li>`;
    })
    .join("");
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Daily goals and limits", "", "goal")}
    <p class="text-xs text-text-muted m-0">A goal is the least you want in a language each day, a limit the most. The player shows a note when a goal is reached and when a limit is close or passed. Time is real time, so 2× speed counts half.${prefs.watchHistory ? "" : " Goals and limits need YouTube history, which is off."}</p>
    ${rowsHtml ? `<ul class="m-0 p-0 list-none flex flex-col gap-2.5">${rowsHtml}</ul>` : ""}
  </section>`;
}

/** Painted once per visit, apart from the live rows above it, so a refresh never touches what is being typed. */
export function addRuleFormHtml(): string {
  return `<form id="time-rule-add" class="flex flex-wrap items-center gap-2 -mt-3">
      <span class="ui-segmented" role="group" aria-label="Kind">
        <button type="button" class="time-rule-kind budget-chip text-xs" data-kind="goal" aria-pressed="${newRuleKind === "goal"}">At least</button>
        <button type="button" class="time-rule-kind budget-chip text-xs" data-kind="limit" aria-pressed="${newRuleKind === "limit"}">At most</button>
      </span>
      <span class="ui-combobox"><input type="text" id="time-rule-language" name="language" required maxlength="80" placeholder="Language, e.g. Slovak" class="ui-field w-48" aria-label="Language" /></span>
      ${durationFieldHtml({ name: "minutes", minutes: 30, required: true, suffix: "a day", ariaLabel: "Time per day" })}
      <button type="submit" class="chip chip--accent h-8 text-xs">Add ${newRuleKind === "goal" ? "goal" : "limit"}</button>
    </form>`;
}

export async function saveDailyRules(rules: LanguageLimit[]): Promise<void> {
  await browser.runtime.sendMessage({ action: "set-language-limits", limits: rules });
  await renderTimePanel();
}

export function plainRules(): LanguageLimit[] {
  return (lastTimeResponse?.limits ?? []).map(({ language, minutes, kind }) => (kind ? { language, minutes, kind } : { language, minutes }));
}

export function sameRule(rule: LanguageLimit, language: string | undefined, kind: string | undefined): boolean {
  return rule.language === language && (rule.kind ?? "") === (kind ?? "");
}
