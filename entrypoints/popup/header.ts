import { formatTime, formatDurationWords } from "../../utils/format";
import { queryReadingList } from "../../utils/readingList";
import { popup } from "./state";
import { renderPopupLanguages } from "./languages";

export function updateHeaderStats(
  totalSeconds: number,
  totalRemaining: number,
  videoCount: number,
  totalWatched = 0
) {
  // Called every second; unchanged text is left alone so the header doesn't relayout on each tick.
  const empty = popup.videoData.length === 0;
  setText(document.getElementById("stat-remaining"), empty ? "No videos" : formatDurationWords(totalRemaining));
  document.getElementById("stat-remaining-suffix")?.classList.toggle("hidden", empty);
  document.getElementById("stat-watched")?.classList.toggle("invisible", empty);
  const studyButton = document.getElementById("popup-stage-study") as HTMLButtonElement | null;
  if (studyButton && studyButton.disabled !== empty) {
    studyButton.disabled = empty;
    studyButton.title = empty ? "Open a YouTube video first" : "Start a focused study session from this window's tabs";
  }
  setText(document.getElementById("stat-total"), formatTime(totalSeconds));
  const countEl = document.getElementById("stat-video-count");
  const countHtml = empty ? "" : `<span class="font-semibold text-text-primary">${videoCount} video${videoCount === 1 ? "" : "s"}</span> · ${formatDurationWords(totalSeconds)} total`;
  if (countEl && countEl.dataset.html !== countHtml) {
    countEl.dataset.html = countHtml;
    countEl.innerHTML = countHtml;
  }

  const percent = totalSeconds > 0 ? (totalWatched / totalSeconds) * 100 : 0;
  const watchedPctEl = document.getElementById("stat-watched-pct");
  if (watchedPctEl) {
    const rounded = Math.round(percent);
    setText(watchedPctEl, rounded >= 100 ? "Done" : `${rounded} %`);
    watchedPctEl.title = `${formatDurationWords(totalWatched)} watched`;
  }
  renderPopupLanguages();

  const btnTab = document.getElementById("sort-order");
  const btnLen = document.getElementById("sort-duration");
  btnTab?.setAttribute("aria-pressed", String(!popup.sortByDuration));
  btnLen?.setAttribute("aria-pressed", String(popup.sortByDuration));

  if (readingCount != null) showReadingCount(readingCount);
}

function setText(element: HTMLElement | null, text: string): void {
  if (element && element.textContent !== text) element.textContent = text;
}

let readingCount: number | null = null;

function showReadingCount(count: number): void {
  const badgeElement = document.getElementById("popup-reading-count");
  if (badgeElement) badgeElement.textContent = String(count);
  document
    .getElementById("popup-reading-list")
    ?.setAttribute("aria-label", `Reading list, ${count} ${count === 1 ? "item" : "items"}`);
}

/** The reading list doesn't change while the popup is open, so it's read once instead of on every render. */
export function loadReadingCount(): void {
  void queryReadingList(false).then((items) => {
    readingCount = items.length;
    showReadingCount(readingCount);
  });
}
