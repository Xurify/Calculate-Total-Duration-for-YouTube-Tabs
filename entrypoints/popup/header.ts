import { formatDurationWords } from "../../utils/format";
import { popup } from "./state";
import { todayWatchSummary } from "./languages";

/** Called every second; unchanged text is left alone so the header doesn't relayout on each tick. */
export function updateHeaderStats(totalRemaining: number, videoCount: number): void {
  const empty = popup.videoData.length === 0;
  setText(document.getElementById("stat-remaining"), empty ? "No videos" : formatDurationWords(totalRemaining));
  document.getElementById("stat-remaining-suffix")?.classList.toggle("hidden", empty);

  const studyButton = document.getElementById("popup-stage-study") as HTMLButtonElement | null;
  if (studyButton && studyButton.disabled !== empty) {
    studyButton.disabled = empty;
    studyButton.title = empty ? "Open a YouTube video first" : "Start a focused study session from this window's tabs";
  }

  const summaryEl = document.getElementById("stat-summary");
  if (summaryEl) {
    summaryEl.classList.toggle("hidden", empty);
    setText(summaryEl, empty ? "" : summaryLine(videoCount));
  }
}

function summaryLine(videoCount: number): string {
  const videos = `${videoCount} video${videoCount === 1 ? "" : "s"}`;
  const today = todayWatchSummary();
  if (today.hasGoal) {
    return `${videos} · today ${Math.floor(today.goalUsedSeconds / 60)} of ${today.goalMinutes} min toward your goals`;
  }
  if (today.usedSeconds > 0) return `${videos} · ${formatDurationWords(today.usedSeconds)} watched today`;
  return videos;
}

function setText(element: HTMLElement | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}
