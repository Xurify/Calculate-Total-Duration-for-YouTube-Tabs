import type { VideoData } from "../../utils/storage";
import { formatDurationWords, getVideoIdFromUrl } from "../../utils/format";
import { languageKey, type LanguageTodayRow } from "../../utils/languageLimits";
import { app } from "./state";
import { languageColor, showContinueWatching, toggleFacet, videoLanguageLabel, DETECTING_LANGUAGE, UNKNOWN_LANGUAGE } from "./facets";
import { remainingOf } from "./playback";
import { focusLiveVideoTab } from "./session-actions";
import { openStudySessionModal } from "./study-session";
import { escapeHtml } from "./util";

export const TODAY_SNAPSHOT_KEY = "today-snapshot";
const ROWS_STALE_MS = 15_000;
const BUDGET_KEY = "today-budget";
const LENGTHS = [20, 45, 90] as const;
const QUEUE_SHOWN = 8;

type Budget = "goals" | (typeof LENGTHS)[number];

let todayRows: LanguageTodayRow[] = [];
let rowsFetchedAt = 0;
let rowsInFlight = false;
let plannedIds: number[] = [];
let lastHtml = "";

interface LanguageLine {
  label: string;
  key: string;
  videos: VideoData[];
  remaining: number;
  usedSeconds: number;
  goalSeconds: number | null;
}

interface PlanItem {
  video: VideoData;
  seconds: number;
  language: string;
}

function playable(video: VideoData): boolean {
  return !video.isLive && !video.excluded && remainingOf(video) > 0;
}

/** Started videos first, so a session finishes what was begun before opening anything new. */
function queueOrder(videos: VideoData[]): VideoData[] {
  return [...videos.filter((video) => video.currentTime > 0), ...videos.filter((video) => video.currentTime <= 0)];
}

function languageLines(): LanguageLine[] {
  const byKey = new Map<string, LanguageLine>();
  for (const video of app.allVideos) {
    if (!playable(video)) continue;
    const label = videoLanguageLabel(video);
    if (label === DETECTING_LANGUAGE) continue;
    const key = label === UNKNOWN_LANGUAGE ? label : languageKey(label);
    const line = byKey.get(key) ?? { label, key, videos: [], remaining: 0, usedSeconds: 0, goalSeconds: null };
    line.videos.push(video);
    line.remaining += remainingOf(video);
    byKey.set(key, line);
  }
  for (const row of todayRows) {
    const key = languageKey(row.language);
    const line = byKey.get(key) ?? { label: row.language, key, videos: [], remaining: 0, usedSeconds: 0, goalSeconds: null };
    line.usedSeconds = row.usedSeconds;
    if (row.kind === "goal" && row.minutes != null) line.goalSeconds = row.minutes * 60;
    byKey.set(key, line);
  }
  const behindShare = (line: LanguageLine) => (line.goalSeconds ? Math.max(0, line.goalSeconds - line.usedSeconds) / line.goalSeconds : -1);
  return [...byKey.values()].sort((a, b) => behindShare(b) - behindShare(a) || b.remaining - a.remaining || a.label.localeCompare(b.label));
}

function goalLeft(line: LanguageLine): number {
  return line.goalSeconds == null ? 0 : Math.max(0, line.goalSeconds - line.usedSeconds);
}

function loadBudget(): Budget | null {
  try {
    const raw = localStorage.getItem(BUDGET_KEY);
    if (raw === "goals") return "goals";
    const minutes = Number(raw);
    return (LENGTHS as readonly number[]).includes(minutes) ? (minutes as Budget) : null;
  } catch {
    return null;
  }
}

let chosenBudget: Budget | null = loadBudget();

/** Goals while any language is behind and nothing else was picked; a picked length sticks. */
function effectiveBudget(lines: LanguageLine[]): Budget {
  const behind = lines.some((line) => goalLeft(line) > 0 && line.videos.length > 0);
  if (chosenBudget === "goals" || chosenBudget == null) return behind ? "goals" : 45;
  return chosenBudget;
}

/**
 * Goals: each behind language gets its missing minutes from its own videos. A length: behind languages
 * go first, then the rest of the desk in tab order, until the minutes run out. A video longer than what
 * is left still goes in when nothing else has, so a short gap never leaves the plan empty.
 */
function planFor(lines: LanguageLine[], budget: Budget): PlanItem[] {
  const items: PlanItem[] = [];
  const taken = new Set<number>();
  const take = (videos: VideoData[], seconds: number, language: (video: VideoData) => string): number => {
    let used = 0;
    for (const video of queueOrder(videos)) {
      if (used >= seconds) break;
      if (taken.has(video.id)) continue;
      const left = remainingOf(video);
      if (used > 0 && used + left > seconds) continue;
      const portion = Math.min(left, seconds - used);
      items.push({ video, seconds: portion, language: language(video) });
      taken.add(video.id);
      used += portion;
    }
    return used;
  };
  const behind = lines.filter((line) => goalLeft(line) > 0 && line.videos.length > 0);
  if (budget === "goals") {
    for (const line of behind) take(line.videos, goalLeft(line), () => line.label);
    return items;
  }
  let left = budget * 60;
  for (const line of behind) {
    if (left <= 0) break;
    left -= take(line.videos, Math.min(left, goalLeft(line)), () => line.label);
  }
  if (left > 0) take(app.allVideos.filter(playable), left, (video) => videoLanguageLabel(video));
  return items;
}

function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function minutesText(seconds: number): string {
  return formatDurationWords(Math.max(60, Math.round(seconds / 60) * 60));
}

function countText(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function heroHtml(lines: LanguageLine[]): string {
  const videos = app.allVideos.filter(playable);
  const deskTotal = videos.reduce((sum, video) => sum + remainingOf(video), 0);
  if (app.allVideos.length === 0) {
    return `<h1 class="today-title">The desk is clear</h1><p class="today-lede">Open YouTube videos in any window and they line up here, with a plan for today.</p>`;
  }
  const deskLine = `${countText(videos.length, "video", "videos")} on the desk, ${formatDurationWords(deskTotal)} in all.`;
  const goals = lines.filter((line) => line.goalSeconds != null);
  if (goals.length === 0) {
    return `<h1 class="today-title">${escapeHtml(formatDurationWords(deskTotal))} on the desk</h1><p class="today-lede">${escapeHtml(`${countText(videos.length, "video", "videos")}. Set daily goals in History and this page plans around them.`)}</p>`;
  }
  const missing = goals.reduce((sum, line) => sum + goalLeft(line), 0);
  if (missing <= 0) return `<h1 class="today-title">Today’s goals are done</h1><p class="today-lede">${escapeHtml(`Anything more is a bonus. ${deskLine}`)}</p>`;
  const behind = goals.filter((line) => goalLeft(line) > 0).map((line) => line.label);
  const done = goals.filter((line) => goalLeft(line) <= 0).map((line) => line.label);
  const parts = [`${listText(behind)} ${behind.length === 1 ? "is" : "are"} behind.`];
  if (done.length > 0) parts.push(`${listText(done)} ${done.length === 1 ? "is" : "are"} done.`);
  parts.push(deskLine);
  return `<h1 class="today-title">${escapeHtml(minutesText(missing))} to go today</h1><p class="today-lede">${escapeHtml(parts.join(" "))}</p>`;
}

function thumbHtml(video: VideoData, color: string): string {
  const id = getVideoIdFromUrl(video.url);
  const image = id ? `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy" draggable="false" />` : "";
  return `<span class="today-thumb" style="--lang: ${color}">${image}</span>`;
}

function sessionHtml(lines: LanguageLine[], budget: Budget, plan: PlanItem[]): string {
  const hasGoals = lines.some((line) => goalLeft(line) > 0 && line.videos.length > 0);
  const choices: { value: Budget; label: string }[] = [
    ...(hasGoals ? [{ value: "goals" as Budget, label: "Goals" }] : []),
    ...LENGTHS.map((minutes) => ({ value: minutes as Budget, label: `${minutes} min` })),
  ];
  const lengths = `<div class="today-lengths" role="group" aria-label="Session length">${choices
    .map((choice) => `<button type="button" data-today-budget="${choice.value}" aria-pressed="${choice.value === budget}">${choice.label}</button>`)
    .join("")}</div>`;
  const head = `<div class="today-session-head"><h2 id="today-session-h" class="today-h2">Next session</h2>${lengths}</div>`;
  if (plan.length === 0) {
    return `<section class="today-session" aria-labelledby="today-session-h">${head}<p class="today-empty">Nothing on the desk fits. Open a video, or pick a longer session.</p></section>`;
  }
  let offset = 0;
  const rows = plan.slice(0, QUEUE_SHOWN).map((item, index) => {
    const at = index === 0 ? "now" : `+${Math.max(1, Math.ceil(offset / 60))} min`;
    offset += item.seconds;
    const color = languageColor(item.language);
    const full = remainingOf(item.video);
    const length = item.seconds + 30 < full ? `first ${minutesText(item.seconds)} of ${minutesText(full)}` : `${minutesText(item.seconds)}${item.video.currentTime > 0 ? " left" : ""}`;
    return `<li class="today-q"><span class="today-at">${at}</span><button type="button" class="today-q-main" data-today-play="${item.video.id}" aria-label="${escapeHtml(`Go to ${item.video.title}`)}">${thumbHtml(item.video, color)}<span class="today-q-text"><span class="today-q-title" title="${escapeHtml(item.video.title)}">${escapeHtml(item.video.title)}</span><span class="today-q-meta"><span class="today-dot" style="--lang: ${color}" aria-hidden="true"></span>${escapeHtml(item.language)} · ${escapeHtml(length)}</span></span></button></li>`;
  });
  const more = plan.length > QUEUE_SHOWN ? `<li class="today-q-more">and ${plan.length - QUEUE_SHOWN} more</li>` : "";
  const total = plan.reduce((sum, item) => sum + item.seconds, 0);
  return `<section class="today-session" aria-labelledby="today-session-h">
    ${head}
    <ol class="today-queue">${rows.join("")}${more}</ol>
    <div class="today-session-foot">
      <button type="button" class="today-start" data-today-start aria-keyshortcuts="p">Start ${escapeHtml(minutesText(total))} session</button>
      <span class="today-note">${countText(plan.length, "video", "videos")}, in this order</span>
    </div>
  </section>`;
}

function languagesHtml(lines: LanguageLine[]): string {
  if (lines.length === 0) return "";
  const rows = lines.map((line) => {
    const color = languageColor(line.label);
    const used = Math.round(line.usedSeconds / 60);
    let figure: string;
    let detail: string;
    let meter = "";
    if (line.goalSeconds != null) {
      const goal = Math.round(line.goalSeconds / 60);
      const left = goalLeft(line);
      figure = left > 0 ? `<span class="today-l-fig">${Math.ceil(left / 60)}</span> min to go` : `<span class="today-l-done">Done</span>`;
      detail = `${used} of ${goal} min`;
      meter = `<span class="today-meter" aria-hidden="true"><span style="width: ${Math.min(100, (line.usedSeconds / line.goalSeconds) * 100)}%; background: ${color}"></span></span>`;
    } else {
      figure = `<span class="today-l-none">No goal</span>`;
      detail = used > 0 ? `${used} min today` : "Nothing yet today";
    }
    const open = line.videos.length > 0 ? `${countText(line.videos.length, "video", "videos")} open` : "none open";
    return `<li><button type="button" class="today-l" data-today-lang="${escapeHtml(line.label)}"${line.videos.length === 0 ? " disabled" : ""}>
      <span class="today-l-name"><span class="today-dot" style="--lang: ${color}" aria-hidden="true"></span>${escapeHtml(line.label)}</span>
      <span class="today-l-right">${figure}</span>
      ${meter}
      <span class="today-l-sub">${escapeHtml(`${detail} · ${open}`)}</span>
    </button></li>`;
  });
  return `<section aria-labelledby="today-lang-h"><h2 id="today-lang-h" class="today-h2">Languages</h2><ul class="today-langs">${rows.join("")}</ul></section>`;
}

function deskLinksHtml(): string {
  const started = app.allVideos.filter((video) => !video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds);
  const links: [string, string, number][] = [];
  if (started.length > 0) links.push(["continue", "Continue watching", started.length]);
  if (app.allVideos.length > 0) links.push(["all", "All videos", app.allVideos.length]);
  links.push(["sessions", "Saved sessions", app.savedSessionsCount], ["reading-list", "Reading list", app.readingListItems.length]);
  return `<section aria-labelledby="today-desk-h"><h2 id="today-desk-h" class="today-h2">On the desk</h2><ul class="today-links">${links
    .map(([go, label, count]) => `<li><button type="button" data-today-go="${go}"><span>${escapeHtml(label)}</span><span class="today-leader" aria-hidden="true"></span><span class="today-count">${count}</span></button></li>`)
    .join("")}</ul></section>`;
}

function refreshRows(): void {
  if (rowsInFlight || Date.now() - rowsFetchedAt < ROWS_STALE_MS) return;
  rowsInFlight = true;
  void browser.runtime
    .sendMessage({ action: "get-language-today" })
    .then((response: { rows?: LanguageTodayRow[] } | undefined) => {
      todayRows = response?.rows ?? [];
    })
    .catch(() => {})
    .finally(() => {
      rowsInFlight = false;
      rowsFetchedAt = Date.now();
      if (app.isTodayView) renderTodayPanel();
    });
}

export function renderTodayPanel(): void {
  const panel = document.getElementById("today-panel");
  if (!panel) return;
  refreshRows();
  const lines = languageLines();
  const budget = effectiveBudget(lines);
  const plan = app.allVideos.length > 0 ? planFor(lines, budget) : [];
  plannedIds = plan.map((item) => item.video.id);
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

  const html = `
    <div class="today">
      <header class="today-hero">
        <p class="today-date">${escapeHtml(date)}</p>
        ${heroHtml(lines)}
      </header>
      <div class="today-grid">
        ${app.allVideos.length > 0 ? sessionHtml(lines, budget, plan) : ""}
        <div class="today-side">
          ${languagesHtml(lines)}
          ${deskLinksHtml()}
        </div>
      </div>
    </div>`;
  if (html === lastHtml) return;
  lastHtml = html;
  // A re-render replaces the buttons, so keep keyboard focus on the length the person just picked.
  const focusedBudget = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.todayBudget : undefined;
  panel.innerHTML = html;
  if (focusedBudget) panel.querySelector<HTMLElement>(`[data-today-budget="${focusedBudget}"]`)?.focus();
  panel.setAttribute("aria-busy", "false");
  try {
    localStorage.setItem(TODAY_SNAPSHOT_KEY, html);
  } catch {
    // Private windows can refuse storage; the page still renders, it only loses the instant first paint.
  }
}

export function startTodayPlan(): void {
  if (plannedIds.length > 0) openStudySessionModal(plannedIds);
}

export function wireTodayPanel(): void {
  document.getElementById("today-panel")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-today-start]")) {
      startTodayPlan();
      return;
    }
    const budget = target.closest<HTMLElement>("[data-today-budget]")?.dataset.todayBudget;
    if (budget) {
      chosenBudget = budget === "goals" ? "goals" : (Number(budget) as Budget);
      try {
        localStorage.setItem(BUDGET_KEY, budget);
      } catch {
        // Only the remembered choice is lost.
      }
      renderTodayPanel();
      return;
    }
    const play = target.closest<HTMLElement>("[data-today-play]");
    if (play) {
      const video = app.allVideos.find((candidate) => candidate.id === Number(play.dataset.todayPlay));
      if (video) void focusLiveVideoTab(video);
      return;
    }
    const language = target.closest<HTMLElement>("[data-today-lang]")?.dataset.todayLang;
    if (language) {
      document.getElementById("nav-desk")?.click();
      toggleFacet("language", language);
      return;
    }
    const go = target.closest<HTMLElement>("[data-today-go]")?.dataset.todayGo;
    if (!go) return;
    if (go === "continue") {
      document.getElementById("nav-desk")?.click();
      showContinueWatching();
      return;
    }
    if (go === "all") {
      document.getElementById("nav-desk")?.click();
      return;
    }
    document.querySelector<HTMLElement>(`#source-nav [data-sidebar-type="${go}"]`)?.click();
  });
}
