import { VideoData } from "../../utils/storage";
import { formatDurationWords } from "../../utils/format";
import { app } from "./state";
import { facetCrumbText } from "./facets";
import { remainingOf } from "./playback";
import { getLiveVideosForCurrentView } from "./render";
import { sortVideosForDisplay } from "./sorting";

export let plannedTabIds = new Set<number>();
/** Plan order, so the list can show it. */
export let plannedOrder: number[] = [];
export let planIsPartial = false;

function planCandidates(): VideoData[] {
  return getLiveVideosForCurrentView().filter((video) => !video.isLive && !video.excluded);
}

/** Started videos first (finish what you began), then the current sort; take what fits the budget. */
function computePlan(): { ids: number[]; seconds: number; partial: VideoData | null } {
  const candidates = sortVideosForDisplay(planCandidates());
  const ordered = [
    ...candidates.filter((video) => video.currentTime > 0),
    ...candidates.filter((video) => video.currentTime <= 0),
  ];
  const budget = app.planBudgetMinutes == null ? Number.POSITIVE_INFINITY : app.planBudgetMinutes * 60;
  const ids: number[] = [];
  let seconds = 0;
  for (const video of ordered) {
    const remaining = remainingOf(video);
    if (remaining <= 0 || remaining > budget) continue;
    if (seconds + remaining > budget) continue;
    ids.push(video.id);
    seconds += remaining;
  }
  if (ids.length === 0) {
    const first = ordered.find((video) => remainingOf(video) > 0) ?? null;
    if (first) return { ids: [first.id], seconds: Math.min(budget, remainingOf(first)), partial: first };
  }
  return { ids, seconds, partial: null };
}

export function renderPlanner(): void {
  const planner = document.getElementById("planner");
  const startButton = document.getElementById("btn-start-plan") as HTMLButtonElement | null;
  const startLabel = document.getElementById("btn-start-plan-label");
  const summary = document.getElementById("plan-summary");
  if (!planner || !startButton || !summary) return;

  const live =
    !app.isReadingListView && !app.isSessionsView && !app.isTimeView && !app.isPracticeView && app.selectedSession == null && getLiveVideosForCurrentView().length > 0;
  planner.classList.toggle("hidden", !live);
  planner.classList.toggle("flex", live);
  if (!live) {
    plannedTabIds = new Set();
    plannedOrder = [];
    planIsPartial = false;
    return;
  }

  document.querySelectorAll<HTMLButtonElement>(".budget-chip").forEach((chip) => {
    const value = chip.dataset.budget === "all" ? null : Number(chip.dataset.budget);
    chip.setAttribute("aria-pressed", String(value === app.planBudgetMinutes));
  });

  const plan = computePlan();
  plannedTabIds = new Set(plan.ids);
  plannedOrder = plan.ids;
  planIsPartial = plan.partial != null;
  const count = plan.ids.length;
  const scope = facetCrumbText();
  if (plan.partial) {
    summary.textContent = `Nothing fits whole. Start “${plan.partial.title}” and stop after ${formatDurationWords(plan.seconds)} of ${formatDurationWords(remainingOf(plan.partial))}.`;
  } else {
    summary.textContent =
      count === 0
        ? "Nothing in this list to plan."
        : `${count} ${count === 1 ? "video" : "videos"}, ${formatDurationWords(plan.seconds)}${scope ? ` from ${scope}` : ""}. Started videos go first when you start this plan.`;
  }
  if (startLabel) startLabel.textContent = count === 0 ? "Start" : `Start ${formatDurationWords(plan.seconds)}`;
  startButton.disabled = count === 0;
  startButton.classList.toggle("opacity-50", count === 0);

  document.querySelectorAll<HTMLElement>("#tab-list [data-id]").forEach((row) => {
    const id = parseInt(row.dataset.id || "0", 10);
    row.classList.toggle("queue-row--planned", plannedTabIds.has(id));
  });
}
