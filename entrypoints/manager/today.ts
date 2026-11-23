import type { VideoData } from "../../utils/storage";
import { formatDurationWords, getVideoIdFromUrl } from "../../utils/format";
import { languageKey, type LanguageTodayRow } from "../../utils/languageLimits";
import { app } from "./state";
import { languageColor, showContinueWatching, videoLanguageLabel, DETECTING_LANGUAGE, UNKNOWN_LANGUAGE } from "./facets";
import { remainingOf } from "./playback";
import { focusLiveVideoTab } from "./session-actions";
import { openStudySessionModal } from "./study-session";
import { escapeHtml } from "./util";

export const TODAY_SNAPSHOT_KEY = "today-snapshot";
const ROWS_STALE_MS = 15_000;
const NO_GOAL_BUDGET_SECONDS = 45 * 60;

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

/** Fills each language's missing goal time from its own videos; a video longer than what is left still goes in once, so a short gap never blocks the plan. */
function planFor(lines: LanguageLine[]): { ids: number[]; seconds: number; parts: { label: string; seconds: number }[] } {
  const behind = lines.filter((line) => goalLeft(line) > 0 && line.videos.length > 0);
  const ids: number[] = [];
  const parts: { label: string; seconds: number }[] = [];
  let seconds = 0;
  const take = (videos: VideoData[], budget: number, label: string) => {
    let used = 0;
    for (const video of queueOrder(videos)) {
      if (used >= budget) break;
      const left = remainingOf(video);
      if (used > 0 && used + left > budget) continue;
      ids.push(video.id);
      used += Math.min(left, budget - used);
    }
    if (used > 0) parts.push({ label, seconds: used });
    seconds += used;
  };
  if (behind.length > 0) {
    for (const line of behind) take(line.videos, goalLeft(line), line.label);
  } else {
    take(app.allVideos.filter(playable), NO_GOAL_BUDGET_SECONDS, "");
  }
  return { ids, seconds, parts };
}

function thumbHtml(video: VideoData | undefined, color: string): string {
  const id = video ? getVideoIdFromUrl(video.url) : null;
  const image = id ? `<img src="https://i.ytimg.com/vi/${id}/mqdefault.jpg" alt="" loading="lazy" draggable="false" />` : "";
  return `<span class="today-thumb" style="--lang: ${color}">${image}</span>`;
}

function lineHtml(line: LanguageLine): string {
  const color = languageColor(line.label);
  const next = queueOrder(line.videos)[0];
  const used = Math.round(line.usedSeconds / 60);
  let today: string;
  let meter = "";
  if (line.goalSeconds != null) {
    const goal = Math.round(line.goalSeconds / 60);
    const share = Math.min(100, Math.round((line.usedSeconds / line.goalSeconds) * 100));
    today = `${used} of ${goal} min${line.usedSeconds >= line.goalSeconds ? ", done" : ""}`;
    meter = `<span class="today-meter" role="img" aria-label="${escapeHtml(`${line.label}: ${today}`)}"><span style="width: ${share}%; background: ${color}"></span></span>`;
  } else {
    today = used > 0 ? `${used} min today, no goal` : "No goal";
  }
  const nextHtml = next
    ? `${thumbHtml(next, color)}<span class="min-w-0"><span class="today-next-title">${escapeHtml(next.title)}</span><span class="today-next-meta">${formatDurationWords(remainingOf(next))}${next.currentTime > 0 ? " left" : ""} · ${line.videos.length === 1 ? "1 video" : `${line.videos.length} videos`}, ${formatDurationWords(line.remaining)} in all</span></span>`
    : `<span class="today-next-meta">No ${escapeHtml(line.label)} videos open</span>`;
  return `
    <div class="today-line">
      <div>
        <div class="today-lang"><span class="facet-dot" style="background: ${color}" aria-hidden="true"></span>${escapeHtml(line.label)}</div>
        <div class="today-used">${escapeHtml(today)}</div>
        ${meter}
      </div>
      <div class="today-next">${nextHtml}</div>
      ${next ? `<button type="button" class="chip" data-today-play="${next.id}" aria-label="Play ${escapeHtml(next.title)}">Play</button>` : `<span></span>`}
    </div>`;
}

function foldHtml(go: string, label: string, meta: string): string {
  return `<button type="button" class="today-fold" data-today-go="${go}"><span>${escapeHtml(label)}</span><span class="today-fold-meta">${escapeHtml(meta)}</span><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>`;
}

function headline(lines: LanguageLine[], planSeconds: number): { title: string; text: string } {
  const videos = app.allVideos.filter(playable);
  const deskTotal = videos.reduce((sum, video) => sum + remainingOf(video), 0);
  const deskLine = `The desk holds ${videos.length === 1 ? "1 video" : `${videos.length} videos`}, ${formatDurationWords(deskTotal)} in all.`;
  const goals = lines.filter((line) => line.goalSeconds != null);
  if (goals.length === 0) return { title: `${formatDurationWords(deskTotal)} on the desk`, text: "Set daily goals in History and this page plans around them." };
  const missing = goals.reduce((sum, line) => sum + goalLeft(line), 0);
  if (missing <= 0) return { title: "Today’s goals are done", text: deskLine };
  const behind = goals.filter((line) => goalLeft(line) > 0).map((line) => line.label);
  const done = goals.filter((line) => goalLeft(line) <= 0).map((line) => line.label);
  const behindText = `${listText(behind)} ${behind.length === 1 ? "is" : "are"} behind on ${behind.length === 1 ? "its goal" : "their goals"}.`;
  const doneText = done.length > 0 ? ` ${listText(done)} ${done.length === 1 ? "is" : "are"} done.` : "";
  const noVideos = planSeconds <= 0 ? " None of their videos are open." : "";
  return { title: `${formatDurationWords(missing)} to go today`, text: `${behindText}${doneText}${noVideos} ${deskLine}` };
}

function listText(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
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
  const plan = planFor(lines);
  plannedIds = plan.ids;
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  const started = app.allVideos.filter((video) => !video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds);

  let body: string;
  if (app.allVideos.length === 0) {
    body = `<h1 class="today-title">The desk is clear</h1><p class="today-text">Open YouTube videos and they line up here, sorted by language, with a plan for today.</p>`;
  } else {
    const { title, text } = headline(lines, plan.seconds);
    const planText = plan.parts.some((part) => part.label)
      ? plan.parts.map((part) => `${part.label} ${formatDurationWords(part.seconds)}`).join(", then ")
      : plan.ids.length > 0
        ? `${plan.ids.length === 1 ? "1 video" : `${plan.ids.length} videos`} in tab order`
        : "";
    const start =
      plan.ids.length > 0
        ? `<div class="today-start"><button type="button" class="btn-primary h-11 px-5 text-[15px]" data-today-start aria-keyshortcuts="p"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>Start ${escapeHtml(formatDurationWords(plan.seconds))} session</button><span class="today-text m-0">${escapeHtml(planText)}</span></div>`
        : "";
    body = `
      <h1 class="today-title">${escapeHtml(title)}</h1>
      <p class="today-text">${escapeHtml(text)}</p>
      ${start}
      ${lines.length > 0 ? `<section aria-labelledby="today-lang-h" class="mt-14"><h2 id="today-lang-h" class="today-h2">Today by language</h2>${lines.map(lineHtml).join("")}</section>` : ""}`;
  }
  const folds = [
    started.length > 0 ? foldHtml("continue", "Continue watching", `${started.length === 1 ? "1 video" : `${started.length} videos`} · ${formatDurationWords(started.reduce((sum, video) => sum + remainingOf(video), 0))} left`) : "",
    app.allVideos.length > 0 ? foldHtml("all", "All videos", `${app.allVideos.length === 1 ? "1 video" : `${app.allVideos.length} videos`}`) : "",
    app.savedSessionsCount > 0 ? foldHtml("sessions", "Saved sessions", app.savedSessionsCount === 1 ? "1 session" : `${app.savedSessionsCount} sessions`) : "",
    app.readingListItems.length > 0 ? foldHtml("reading-list", "Reading list", app.readingListItems.length === 1 ? "1 page" : `${app.readingListItems.length} pages`) : "",
  ].join("");

  const html = `
    <div class="today-column">
      <p class="today-date">${escapeHtml(date)}</p>
      ${body}
      ${folds ? `<section aria-labelledby="today-more-h" class="mt-12"><h2 id="today-more-h" class="today-h2">Also on the desk</h2>${folds}</section>` : ""}
    </div>`;
  if (html === lastHtml) return;
  lastHtml = html;
  panel.innerHTML = html;
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
    const play = target.closest<HTMLElement>("[data-today-play]");
    if (play) {
      const video = app.allVideos.find((candidate) => candidate.id === Number(play.dataset.todayPlay));
      if (video) void focusLiveVideoTab(video);
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
