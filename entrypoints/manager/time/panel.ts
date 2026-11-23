import { mountCustomSelect } from "../custom-select";
import { pillarColor, type SiteRule, type TimeTrackingPrefs } from "../../../utils/timeLog";
import {
  actionSelectOptions,
  formatMinutesWords,
  pillarChoices,
  pillarSelectOptions,
  pillarTitleOf,
  type TimeSummaryResponse,
} from "../../../utils/timeUi";
import {
  formatDurationInput,
  isGoal,
  languageKey,
  MAX_LIMIT_MINUTES,
  parseDurationMinutes,
  ruleKey,
  type LanguageLimit,
} from "../../../utils/languageLimits";
import { focusHoursRows, focusWatchSummary, OTHER_LANGUAGES } from "../../../utils/focusLanguages";
import { durationFieldMinutes, wireCombobox, wireSteppers } from "../../../utils/controls";
import { app } from "../state";
import { showConfirm } from "../dialogs";
import { UNKNOWN_LANGUAGE } from "../facets";
import { openSettings } from "../settings";
import { setDeskHero } from "../sidebar";
import { openExportModal, wireExportModal } from "./export";
import { languageDot, plural, timeAgoWords } from "./html";
import { hoursEditHtml, languagesTableHtml } from "./progress";
import { addRuleFormHtml, dailyRulesHtml, plainRules, sameRule, saveDailyRules } from "./rules";
import { dayChartHtml } from "./watch-sections";
import { showToast } from "../toast";
import { downloadText, escapeHtml } from "../util";

/* ───────────────────────── History: minutes, languages, goals ───────────────────────── */

export let timeRange: 7 | 30 | 90 = 7;
export let lastTimeResponse: TimeSummaryResponse | null = null;
/** Every watched language, before the ones outside Settings' list fold into "Other". */
let watchedLanguageLabels: string[] = [];
let timePanelWired = false;
export let newRuleKind: "goal" | "limit" = "goal";
let ruleSaveTimer: ReturnType<typeof setTimeout> | null = null;
const RULE_SAVE_DELAY_MS = 600;
/** Kept across repaints, so the edit area stays open while the rest of the page refreshes. */
let goalsOpen = false;

let timeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let lastTimeRefreshAt = 0;
const TIME_REFRESH_MIN_MS = 2000;
const TIME_SLOTS = ["range", "watch", "languages", "rules", "add", "hours", "tracking", "mandala"] as const;
type TimeSlot = (typeof TIME_SLOTS)[number];
const paintedTimeSlots = new Map<TimeSlot, string>();

const RANGE_CHOICES: { days: 7 | 30 | 90; label: string }[] = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
];

function mandalaSectionHtml(data: TimeSummaryResponse): string {
  const { summary, rules, mandala, piles } = data;

  const pillarRows = summary.byPillar
    .map((totals, pillarIndex) => ({ pillarIndex, ...totals, total: totals.active + totals.passive }))
    .filter((row) => row.total > 0)
    .sort((first, second) => second.total - first.total);
  const longest = pillarRows[0]?.total ?? 1;
  const pillarsHtml = pillarRows.length
    ? pillarRows
        .map(
          (row) => `<li class="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <span class="truncate font-medium text-text-primary flex items-center gap-2">${languageDot(pillarColor(row.pillarIndex))}${escapeHtml(pillarTitleOf(mandala, row.pillarIndex))}</span>
            <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex"><span class="h-full" style="width:${Math.max(2, (row.active / longest) * 100)}%;background:${pillarColor(row.pillarIndex)}"></span><span class="h-full opacity-40" style="width:${(row.passive / longest) * 100}%;background:${pillarColor(row.pillarIndex)}"></span></span>
            <span class="text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(row.active)}${row.passive > 0 ? ` <span class="text-text-muted">+ ${formatMinutesWords(row.passive)}</span>` : ""}</span>
          </li>`
        )
        .join("")
    : `<li class="text-sm text-text-muted">Nothing counted yet.</li>`;

  const sitesHtml = summary.bySite.length
    ? summary.bySite
        .map((site) => {
          const rule = rules.find((each) => each.kind === "host" && (site.host === each.pattern || site.host.endsWith(`.${each.pattern}`)));
          return `<tr class="border-t border-border/60">
            <td class="py-2 pr-3 text-sm text-text-primary truncate max-w-[18rem]" title="${escapeHtml(site.host)}">${escapeHtml(site.host)}</td>
            <td class="py-2 pr-3"><div class="time-select" data-select="site-pillar" data-host="${escapeHtml(site.host)}" data-rule-id="${escapeHtml(rule?.id ?? "")}" data-value="${site.pillarIndex ?? ""}" data-label="Pillar for ${escapeHtml(site.host)}"></div></td>
            <td class="py-2 pr-3 text-sm text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(site.active)}</td>
            <td class="py-2 pr-3 text-sm text-text-muted tabular-nums whitespace-nowrap">${site.passive > 0 ? formatMinutesWords(site.passive) : "·"}</td>
            <td class="py-2 pr-3 text-xs text-text-muted whitespace-nowrap">${timeAgoWords(site.lastAt)}</td>
            <td class="py-2 text-right">${rule ? `<button type="button" class="time-rule-remove chip h-7 px-2.5 text-xs chip--danger" data-rule-id="${escapeHtml(rule.id)}">Stop counting</button>` : ""}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="py-3 text-sm text-text-muted">No sites yet.</td></tr>`;

  const pileRows = (piles?.sections ?? [])
    .map((section) => {
      const rule = rules.find((each) => each.kind === "pile" && each.pattern === section.id);
      return `<li class="flex items-center gap-3 text-sm">
        <span class="flex-1 min-w-0 truncate text-text-primary">${section.emoji ? `${escapeHtml(section.emoji)} ` : ""}${escapeHtml(section.name)}</span>
        <div class="time-select" data-select="pile-pillar" data-section-id="${escapeHtml(section.id)}" data-section-name="${escapeHtml(section.name)}" data-rule-id="${escapeHtml(rule?.id ?? "")}" data-value="${rule ? rule.pillarIndex : ""}" data-label="Pillar for the pile ${escapeHtml(section.name)}"></div>
        ${rule ? `<div class="time-select" data-select="pile-action" data-section-id="${escapeHtml(section.id)}" data-pillar="${rule.pillarIndex}" data-value="${escapeHtml(rule.actionId ?? "")}" data-label="Action for the pile ${escapeHtml(section.name)}"></div>` : ""}
      </li>`;
    })
    .join("");

  const prefixHtml = rules
    .filter((rule) => rule.kind === "prefix")
    .map(
      (rule) => `<li class="flex items-center gap-3 text-sm">
        ${languageDot(pillarColor(rule.pillarIndex))}
        <span class="flex-1 min-w-0 truncate text-text-primary" title="${escapeHtml(rule.pattern)}">${escapeHtml(rule.label || rule.pattern)}</span>
        <span class="text-xs text-text-muted">${escapeHtml(pillarTitleOf(mandala, rule.pillarIndex))}</span>
        <button type="button" class="time-rule-remove chip h-7 px-2.5 text-xs chip--danger" data-rule-id="${escapeHtml(rule.id)}">Stop counting</button>
      </li>`
    )
    .join("");

  const pendingHtml =
    summary.pendingMinutes > 0
      ? `<div class="flex items-center gap-3 rounded-[10px] border border-border bg-surface-elevated px-4 py-3 text-sm text-text-secondary"><span class="flex-1">${summary.pendingMinutes} min not sent yet</span><button type="button" id="time-open-mandala" class="chip h-8 text-xs">Open Mandala</button></div>`
      : "";
  const noPillars = !mandala || pillarChoices(mandala).every((pillar) => !mandala.pillars.find((each) => each.index === pillar.index)?.named);
  const counted = summary.total.active + summary.total.passive;
  const inUse = rules.length > 0 || counted > 0 || summary.pendingMinutes > 0;

  return `
    <details class="time-card group flex flex-col gap-4"${inUse ? " open" : ""}>
      <summary class="flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <h3 class="text-sm font-semibold text-text-secondary m-0 flex items-center gap-2">Mandala<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-text-muted transition-transform group-open:rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></h3>
        ${counted > 0 ? `<span class="text-sm text-text-muted tabular-nums">${formatMinutesWords(counted)}</span>` : ""}
      </summary>
      <div class="flex flex-col gap-4 mt-4">
      ${pendingHtml}
      ${noPillars ? `<p class="text-sm text-text-muted m-0">Open Mandala once to load your pillar names.</p>` : ""}
      <h3 class="text-sm font-semibold text-text-secondary m-0">By pillar</h3>
      <ul class="m-0 p-0 list-none flex flex-col gap-2">${pillarsHtml}</ul>
      <h3 class="text-sm font-semibold text-text-secondary m-0 mt-2">Sites</h3>
      <table class="w-full border-collapse"><thead><tr class="text-[11px] uppercase tracking-[0.1em] text-text-muted text-left"><th class="font-semibold pb-1 pr-3">Site</th><th class="font-semibold pb-1 pr-3">Counts for</th><th class="font-semibold pb-1 pr-3">Active</th><th class="font-semibold pb-1 pr-3">Background</th><th class="font-semibold pb-1 pr-3">Last</th><th></th></tr></thead><tbody>${sitesHtml}</tbody></table>
      ${prefixHtml ? `<h3 class="text-sm font-semibold text-text-secondary m-0 mt-2">Pages</h3><ul class="m-0 p-0 list-none flex flex-col gap-2">${prefixHtml}</ul>` : ""}
      <h3 class="text-sm font-semibold text-text-secondary m-0 mt-2">Piles</h3>
      ${pileRows ? `<ul class="m-0 p-0 list-none flex flex-col gap-2">${pileRows}</ul>` : `<p class="text-sm text-text-muted m-0">No piles yet.</p>`}
      </div>
    </details>
  `;
}

const IDLE_CHOICES = [30, 60, 120, 300];

function mountTimeSelects(panel: HTMLElement, data: TimeSummaryResponse): void {
  const saveRule = async (rule: Omit<SiteRule, "id" | "createdAt"> & { id?: string }) => {
    await browser.runtime.sendMessage({ action: "set-site-rule", rule });
    await renderTimePanel();
  };
  for (const root of panel.querySelectorAll<HTMLElement>(".time-select")) {
    const { select, value = "", label = "" } = root.dataset;
    if (select === "idle") {
      mountCustomSelect(root, {
        options: IDLE_CHOICES.map((seconds) => ({ value: String(seconds), label: seconds < 60 ? `${seconds} s` : `${seconds / 60} min` })),
        value,
        size: "field",
        ariaLabel: label,
        onChange: (next) => void saveTrackingPrefs(panel, { idleSeconds: Number(next) }),
      });
    } else if (select === "site-pillar") {
      const host = root.dataset.host ?? "";
      mountCustomSelect(root, {
        options: [...(value === "" ? [{ value: "", label: "Not counted" }] : []), ...pillarSelectOptions(data.mandala)],
        value,
        size: "field",
        ariaLabel: label,
        onChange: (next) => void (next ? saveRule({ id: root.dataset.ruleId || undefined, kind: "host", pattern: host, label: host, pillarIndex: Number(next) }) : undefined),
      });
    } else if (select === "pile-pillar") {
      mountCustomSelect(root, {
        options: [{ value: "", label: "Not counted" }, ...pillarSelectOptions(data.mandala)],
        value,
        size: "field",
        ariaLabel: label,
        onChange: async (next) => {
          if (!next) {
            if (root.dataset.ruleId) await browser.runtime.sendMessage({ action: "remove-site-rule", id: root.dataset.ruleId });
            await renderTimePanel();
            return;
          }
          await saveRule({ id: root.dataset.ruleId || undefined, kind: "pile", pattern: root.dataset.sectionId ?? "", label: root.dataset.sectionName ?? "", pillarIndex: Number(next) });
        },
      });
    } else if (select === "pile-action") {
      mountCustomSelect(root, {
        options: actionSelectOptions(data.mandala, Number(root.dataset.pillar)),
        value,
        size: "field",
        ariaLabel: label,
        onChange: async (next) => {
          const rule = data.rules.find((each) => each.kind === "pile" && each.pattern === root.dataset.sectionId);
          if (rule) await saveRule({ ...rule, actionId: next || undefined });
        },
      });
    }
  }
}

async function saveTrackingPrefs(panel: HTMLElement, change: Partial<TimeTrackingPrefs>): Promise<void> {
  const current = lastTimeResponse?.prefs;
  const prefs: TimeTrackingPrefs = {
    enabled: panel.querySelector<HTMLInputElement>("#time-enabled")?.checked ?? current?.enabled ?? true,
    idleSeconds: current?.idleSeconds ?? 60,
    watchHistory: panel.querySelector<HTMLInputElement>("#time-watch-history")?.checked ?? current?.watchHistory ?? true,
    ...change,
  };
  await browser.runtime.sendMessage({ action: "set-time-tracking-prefs", prefs });
  if (lastTimeResponse) lastTimeResponse.prefs = prefs;
  if (change.watchHistory !== undefined) await renderTimePanel();
}

export async function renderTimePanel(): Promise<void> {
  const panel = document.getElementById("time-panel");
  if (!panel) return;
  wireTimePanel(panel);
  if (timeRefreshTimer !== null) {
    clearTimeout(timeRefreshTimer);
    timeRefreshTimer = null;
  }
  lastTimeRefreshAt = Date.now();
  let data: TimeSummaryResponse;
  try {
    data = (await browser.runtime.sendMessage({ action: "get-time-summary", days: timeRange })) as TimeSummaryResponse;
    if (!data || data.errorMessage) throw new Error(data?.errorMessage || "No answer");
  } catch (error) {
    paintedTimeSlots.clear();
    panel.innerHTML = `<div class="flex flex-col items-start gap-3">
      <p class="text-sm text-text-secondary m-0">Your watch time could not be loaded. Nothing was lost. Try again in a moment.</p>
      <p class="text-xs text-text-muted m-0">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
      <button type="button" id="time-retry" class="chip">Try again</button>
    </div>`;
    setDeskHero({ kicker: "History", title: "", value: "Watch time", suffix: "didn't load" });
    panel.setAttribute("aria-busy", "false");
    return;
  }
  if (!app.isTimeView) return;
  watchedLanguageLabels = data.watch.byLanguage.map((row) => row.label);
  data.watch = focusWatchSummary(data.watch, app.focusLanguages);
  if (data.hours) data.hours = focusHoursRows(data.hours, app.focusLanguages);
  lastTimeResponse = data;
  const { watch } = data;
  const headerStats = document.getElementById("current-view-stats");
  if (headerStats) {
    const stats = watch.total.videos > 0 ? [plural(watch.total.videos, "video"), plural(watch.byLanguage.filter((row) => row.label !== OTHER_LANGUAGES).length, "language"), plural(watch.byChannel.length, "channel")].join(" · ") : "";
    if (headerStats.textContent !== stats) headerStats.textContent = stats;
  }
  setDeskHero({
    kicker: "History",
    title: "",
    value: formatMinutesWords(watch.total.playedSeconds),
    suffix: `in the last ${timeRange} days`,
  });
  paintTimePanel(panel, data);
  panel.setAttribute("aria-busy", "false");
}

/** Called for every desk render while the Time view is open; tab events come in bursts, so fetch at most every couple of seconds. */
export function scheduleTimeRefresh(): void {
  if (timeRefreshTimer !== null) return;
  const wait = Math.max(0, lastTimeRefreshAt + TIME_REFRESH_MIN_MS - Date.now());
  timeRefreshTimer = setTimeout(() => {
    timeRefreshTimer = null;
    if (app.isTimeView) void renderTimePanel();
  }, wait);
}

/** Static frame: the Edit goals area and the advanced section are not repainted, so their open state survives. */
function skeletonHtml(): string {
  return `<div data-time-slot="range" class="contents"></div>
    <div data-time-slot="watch" class="contents"></div>
    <section class="flex flex-col gap-4 time-card" aria-labelledby="time-languages-heading">
      <div class="flex items-center gap-3 flex-wrap">
        <h2 id="time-languages-heading" class="font-display text-[22px] font-medium m-0 flex-1">Languages</h2>
        <button type="button" id="time-edit-goals" class="chip h-8 text-xs" aria-expanded="${goalsOpen}" aria-controls="time-goals-edit">Edit goals</button>
      </div>
      <div data-time-slot="languages" class="contents"></div>
      <div id="time-goals-edit" class="time-goals-edit${goalsOpen ? "" : " hidden"}">
        <div class="flex justify-end"><button type="button" id="time-choose-languages" class="link-btn text-xs">Choose languages</button></div>
        <div data-time-slot="rules" class="contents"></div>
        <div data-time-slot="add" class="contents"></div>
        <div data-time-slot="hours" class="contents"></div>
      </div>
    </section>
    <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-text-muted">
      <span>Only time the player is actually playing counts.</span>
      <button type="button" id="time-export-csv" class="link-btn text-xs">Export as CSV</button>
    </div>
    <details class="history-advanced time-card group flex flex-col gap-4">
      <summary class="flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden"><h2 class="font-display text-[22px] font-medium m-0 flex-1">Tracking and Mandala</h2><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-text-muted transition-transform group-open:rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></summary>
      <div class="flex flex-col gap-6 mt-4">
        <div data-time-slot="tracking" class="contents"></div>
        <div data-time-slot="mandala" class="contents"></div>
      </div>
    </details>`;
}

function trackingHtml(prefs: TimeTrackingPrefs): string {
  return `<div class="flex flex-col gap-3">
      <h3 class="text-sm font-semibold text-text-secondary m-0">Tracking</h3>
      <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label class="flex items-center gap-2.5 text-sm text-text-primary cursor-pointer"><input type="checkbox" role="switch" id="time-watch-history" class="ui-switch"${prefs.watchHistory ? " checked" : ""} /> YouTube history</label>
        <label class="flex items-center gap-2.5 text-sm text-text-primary cursor-pointer"><input type="checkbox" role="switch" id="time-enabled" class="ui-switch"${prefs.enabled ? " checked" : ""} /> Mandala page time</label>
        <div class="flex items-center gap-2 text-sm text-text-secondary">Idle after <div class="time-select" data-select="idle" data-value="${prefs.idleSeconds}" data-label="Idle after"></div></div>
        <span class="flex-1"></span>
        <button type="button" id="time-export" class="chip h-8 text-xs" title="Everything, including Mandala page time, as JSON">Back up JSON</button>
        <button type="button" id="time-clear" class="chip h-8 text-xs chip--danger">Delete all time data</button>
      </div>
      <p class="text-xs text-text-muted m-0">Stored only in this browser.</p>
    </div>`;
}

function timeSlotHtml(slot: TimeSlot, data: TimeSummaryResponse): string {
  const { watch, prefs } = data;
  switch (slot) {
    case "range":
      return `<div class="flex justify-end"><span class="ui-segmented" role="group" aria-label="Time range">${RANGE_CHOICES.map(
        ({ days, label }) => `<button type="button" class="time-range budget-chip" data-days="${days}" aria-pressed="${timeRange === days}">${label}</button>`
      ).join("")}</span></div>`;
    case "watch":
      return dayChartHtml(watch, prefs);
    case "languages":
      return languagesTableHtml(data, timeRange);
    case "rules":
      return dailyRulesHtml(data.limits ?? [], watch, prefs);
    case "add":
      return addRuleFormHtml();
    case "hours":
      return hoursEditHtml(data.hours ?? [], watch);
    case "tracking":
      return trackingHtml(prefs);
    case "mandala":
      return mandalaSectionHtml(data);
  }
}

/** A slot the person is using (focus or an open menu) waits until they leave it. */
function timeSlotBusy(box: HTMLElement): boolean {
  return box.contains(document.activeElement) || box.querySelector("[aria-expanded=true]") !== null;
}

/**
 * Replaces only the slots whose markup changed, so live watch time ticking in does not redraw the
 * whole page, and the add form is drawn once per visit so typing in it is never interrupted.
 */
function paintTimePanel(panel: HTMLElement, data: TimeSummaryResponse): void {
  if (!panel.querySelector("[data-time-slot]")) {
    paintedTimeSlots.clear();
    panel.innerHTML = skeletonHtml();
  }
  for (const slot of TIME_SLOTS) {
    const box = panel.querySelector<HTMLElement>(`[data-time-slot="${slot}"]`);
    if (!box) continue;
    if (slot === "add" && paintedTimeSlots.has(slot)) continue;
    const html = timeSlotHtml(slot, data);
    if (paintedTimeSlots.get(slot) === html) continue;
    if (timeSlotBusy(box)) {
      if (slot === "rules") patchIdleRuleRows(box, html);
      continue;
    }
    const mandalaOpen = slot === "mandala" ? box.querySelector<HTMLDetailsElement>("details")?.open : undefined;
    box.innerHTML = html;
    paintedTimeSlots.set(slot, html);
    if (mandalaOpen !== undefined) {
      const details = box.querySelector<HTMLDetailsElement>("details");
      if (details) details.open = mandalaOpen;
    }
    mountTimeSelects(box, data);
    if (slot === "add") wireAddRuleLanguage(box);
  }
}

/** While one rule's time is being edited, the other rows still show today's progress. */
function patchIdleRuleRows(box: HTMLElement, html: string): void {
  const next = document.createElement("template");
  next.innerHTML = html;
  const fresh = [...next.content.querySelectorAll<HTMLElement>("li[data-rule]")];
  const rows = [...box.querySelectorAll<HTMLElement>("li[data-rule]")];
  if (fresh.length !== rows.length || fresh.some((row, index) => row.dataset.rule !== rows[index].dataset.rule)) return;
  rows.forEach((row, index) => {
    if (!row.contains(document.activeElement) && row.outerHTML !== fresh[index].outerHTML) row.replaceWith(fresh[index]);
  });
  paintedTimeSlots.delete("rules");
}

function wireAddRuleLanguage(box: HTMLElement): void {
  const languageInput = box.querySelector<HTMLInputElement>("#time-rule-language");
  if (!languageInput) return;
  wireCombobox(languageInput, () => {
    const taken = new Set((lastTimeResponse?.limits ?? []).filter((rule) => (newRuleKind === "goal") === isGoal(rule)).map((rule) => languageKey(rule.language)));
    return watchedLanguageLabels.filter((label) => label !== UNKNOWN_LANGUAGE && !taken.has(languageKey(label)));
  });
}

function wireTimePanel(panel: HTMLElement): void {
  if (timePanelWired) return;
  timePanelWired = true;
  wireSteppers(panel);
  wireExportModal();
  // Slots skipped while in use catch up once focus moves on.
  panel.addEventListener("focusout", () => {
    setTimeout(() => {
      if (app.isTimeView && lastTimeResponse) paintTimePanel(panel, lastTimeResponse);
    }, 0);
  });

  panel.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const range = target.closest<HTMLElement>(".time-range");
    if (range) {
      timeRange = RANGE_CHOICES.find((choice) => String(choice.days) === range.dataset.days)?.days ?? 7;
      await renderTimePanel();
      return;
    }
    if (target.closest("#time-edit-goals")) {
      goalsOpen = !goalsOpen;
      panel.querySelector("#time-edit-goals")?.setAttribute("aria-expanded", String(goalsOpen));
      panel.querySelector("#time-goals-edit")?.classList.toggle("hidden", !goalsOpen);
      return;
    }
    const kind = target.closest<HTMLElement>(".time-rule-kind");
    if (kind) {
      newRuleKind = kind.dataset.kind === "limit" ? "limit" : "goal";
      for (const button of panel.querySelectorAll<HTMLElement>(".time-rule-kind")) button.setAttribute("aria-pressed", String(button === kind));
      const submit = panel.querySelector<HTMLElement>("#time-rule-add [type=submit]");
      if (submit) submit.textContent = newRuleKind === "goal" ? "Add goal" : "Add limit";
      return;
    }
    const removeRule = target.closest<HTMLElement>(".time-rule-delete");
    if (removeRule) {
      await saveDailyRules(plainRules().filter((rule) => !sameRule(rule, removeRule.dataset.language, removeRule.dataset.kind)));
      return;
    }
    const remove = target.closest<HTMLElement>(".time-rule-remove");
    if (remove?.dataset.ruleId) {
      await browser.runtime.sendMessage({ action: "remove-site-rule", id: remove.dataset.ruleId });
      await renderTimePanel();
      return;
    }
    if (target.closest("#time-open-mandala")) {
      await browser.tabs.create({ url: "https://mandalamethod.vercel.app/" });
      return;
    }
    if (target.closest("#time-choose-languages")) {
      openSettings("settings-languages");
      return;
    }
    if (target.closest("#time-retry")) {
      await renderTimePanel();
      return;
    }
    if (target.closest("#time-export-csv")) {
      openExportModal();
      return;
    }
    if (target.closest("#time-export")) {
      const response = (await browser.runtime.sendMessage({ action: "export-time-log" })) as { json?: string };
      if (response?.json) downloadText(response.json, "application/json", `study-harvester-time-${new Date().toISOString().slice(0, 10)}.json`);
      return;
    }
    if (target.closest("#time-clear")) {
      const confirmed = await showConfirm({
        title: "Delete all time data",
        message: "Delete the YouTube watch history and every measured minute from this browser? Minutes that already reached Mandala stay there.",
        confirmLabel: "Delete",
        confirmDanger: true,
      });
      if (confirmed) {
        await browser.runtime.sendMessage({ action: "clear-time-log" });
        await renderTimePanel();
      }
    }
  });

  panel.addEventListener("submit", async (event) => {
    const form = event.target;
    if (form instanceof HTMLFormElement && form.classList.contains("hours-add")) {
      event.preventDefault();
      const field = form.querySelector<HTMLInputElement>(".duration-input");
      const minutes = field ? durationFieldMinutes(field) : null;
      const language = form.dataset.language ?? "";
      const before = lastTimeResponse?.hours?.find((row) => row.language === language)?.earlierHours ?? 0;
      if (!field || minutes === null || minutes < 1) return;
      await browser.runtime.sendMessage({ action: "set-earlier-hours", language, hours: before + minutes / 60 });
      field.value = "";
      // Focus would keep the card from repainting with the new total.
      field.blur();
      await renderTimePanel();
      showToast(`Added ${formatDurationInput(minutes)} to ${language}`, {
        label: "Undo",
        run: async () => {
          await browser.runtime.sendMessage({ action: "set-earlier-hours", language, hours: before });
          await renderTimePanel();
        },
      });
      return;
    }
    if (form instanceof HTMLFormElement && form.classList.contains("hours-form")) {
      event.preventDefault();
      const hours = Number(new FormData(form).get("hours"));
      await browser.runtime.sendMessage({ action: "set-earlier-hours", language: form.dataset.language ?? "", hours: Number.isFinite(hours) ? hours : 0 });
      await renderTimePanel();
      return;
    }
    if (!(form instanceof HTMLFormElement) || form.id !== "time-rule-add") return;
    event.preventDefault();
    const fields = new FormData(form);
    const language = String(fields.get("language") ?? "").trim();
    const minutes = parseDurationMinutes(String(fields.get("minutes") ?? ""));
    if (!language || minutes === null || minutes < 1 || minutes > MAX_LIMIT_MINUTES) return;
    // Pick up the label as the page spells it, so "english" still matches "English".
    const known = watchedLanguageLabels.find((label) => languageKey(label) === languageKey(language));
    const rule: LanguageLimit = newRuleKind === "goal" ? { language: known ?? language, minutes, kind: "goal" } : { language: known ?? language, minutes };
    const others = plainRules().filter((each) => ruleKey(each) !== ruleKey(rule));
    form.querySelector<HTMLInputElement>("#time-rule-language")!.value = "";
    await saveDailyRules([...others, rule]);
  });

  panel.addEventListener("change", async (event) => {
    const target = event.target as HTMLElement;
    if (target.id === "time-enabled" || target.id === "time-watch-history") {
      const checked = (target as HTMLInputElement).checked;
      await saveTrackingPrefs(panel, target.id === "time-enabled" ? { enabled: checked } : { watchHistory: checked });
      return;
    }
    if (target instanceof HTMLInputElement && target.classList.contains("time-rule-minutes")) {
      const minutes = parseDurationMinutes(target.value);
      if (!target.checkValidity() || minutes === null) return;
      // Each press of a stepper button fires change; saving after a pause keeps the panel from redrawing under the pointer.
      if (ruleSaveTimer !== null) clearTimeout(ruleSaveTimer);
      ruleSaveTimer = setTimeout(() => {
        ruleSaveTimer = null;
        void saveDailyRules(plainRules().map((rule) => (sameRule(rule, target.dataset.language, target.dataset.kind) ? { ...rule, minutes } : rule)));
      }, RULE_SAVE_DELAY_MS);
    }
  });
}
