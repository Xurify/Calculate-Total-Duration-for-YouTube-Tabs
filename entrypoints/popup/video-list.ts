import { VideoData } from "../../utils/storage";
import { formatCompact, formatDurationWords, formatStartsIn } from "../../utils/format";
import { languageFlagHtml } from "../../utils/languageFlags";
import { escapeHtml as escapeText } from "../../utils/timeUi";
import { popup } from "./state";
import { isOverLimitToday, popupLanguageLabel } from "./languages";
import { getConfirmedNowPlayingVideos, getThumbnailUrl, isTabActivelyPlaying } from "./now-playing";

export function resetVideoListFingerprint(): void {
  popup.lastVideoListFingerprint = "";
}

/** Rows that fit in the popup without scrolling load their thumbnails at once; lazy ones wait for layout. */
const EAGER_THUMBS = 8;

const ROW_CLASSES =
  "group relative flex h-10 shrink-0 items-center gap-2.5 overflow-hidden px-2 rounded-[10px] transition-[background-color,opacity] duration-200";

function rowMetaHtml(video: VideoData, overLimit: boolean): string {
  const parts: string[] = [];
  const language = popupLanguageLabel(video);
  if (language) parts.push(`${languageFlagHtml(video.language || language, "lang-flag lang-flag--xs")}${escapeText(language)}`);
  if (!video.isLive) {
    if (video.seconds > 0) parts.push(formatDurationWords(video.seconds));
    else if (video.suspended) parts.push(`<span class="text-warning">Suspended</span>`);
    else parts.push(`<span class="text-text-muted">Loading…</span>`);
  }
  const separator = `<span class="opacity-50" aria-hidden="true">·</span>`;
  const limit = overLimit ? `${separator}<span class="text-danger">over today’s limit</span>` : "";
  return `${parts.join(separator)}${limit ? ` ${limit}` : ""}`;
}

function updateVideoListItem(item: HTMLElement, video: VideoData): void {
  const isNowPlaying = isTabActivelyPlaying(video);
  const overLimit = isOverLimitToday(video);
  // Runs every second for every row while the popup is open; most rows haven't changed since the last tick.
  const signature = [
    isNowPlaying,
    video.active,
    video.excluded,
    video.suspended,
    video.isLive,
    video.seconds,
    video.title,
    video.language,
    video.languageName,
    overLimit,
  ].join("|");
  if (item.dataset.signature === signature) return;
  item.dataset.signature = signature;

  const isActiveTab = video.active && !isNowPlaying;
  const stateClasses = isNowPlaying
    ? "bg-accent/8"
    : isActiveTab
      ? "bg-surface-hover/50 hover:bg-surface-hover/70"
      : "hover:bg-surface-hover/60";
  item.className = `${ROW_CLASSES} ${stateClasses} ${video.excluded ? "opacity-40 grayscale" : "opacity-100"}`;

  const thumbEl = item.querySelector(".meta-thumb") as HTMLImageElement;
  const thumbUrl = getThumbnailUrl(video.url);
  if (thumbUrl) {
    if (thumbEl.getAttribute("src") !== thumbUrl) thumbEl.src = thumbUrl;
    thumbEl.classList.remove("hidden");
  } else {
    thumbEl.removeAttribute("src");
    thumbEl.classList.add("hidden");
  }

  const titleEl = item.querySelector(".meta-title") as HTMLElement;
  titleEl.innerText = video.title;
  titleEl.title = video.title;

  item.querySelector(".meta-line")!.innerHTML = rowMetaHtml(video, overLimit);

  const badgeEl = item.querySelector(".meta-duration-badge") as HTMLElement;
  if (video.isLive) {
    badgeEl.innerHTML = `<span class="px-1 py-px rounded text-[10px] font-bold bg-youtube text-on-accent">LIVE</span>`;
    badgeEl.classList.remove("hidden");
  } else if (video.seconds > 0) {
    badgeEl.innerText = formatCompact(video.seconds);
    badgeEl.classList.remove("hidden");
  } else if (video.suspended) {
    badgeEl.innerText = "—";
    badgeEl.classList.remove("hidden");
  } else {
    badgeEl.classList.add("hidden");
  }

  const controls = item.querySelector(".meta-controls") as HTMLElement;
  const controlsKey = `${video.suspended ? 1 : 0}|${video.excluded ? 1 : 0}`;
  if (item.dataset.controlsKey !== controlsKey) {
    item.dataset.controlsKey = controlsKey;
    controls.innerHTML = `
          <button type="button" class="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-text-muted border-0 bg-transparent cursor-pointer transition-colors hover:bg-surface-hover hover:text-text-primary active:scale-[0.96] jump-btn" title="Go to tab" aria-label="Go to tab">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          </button>
          ${
            video.suspended
              ? `<button type="button" title="Load this tab so its length can be read" class="shrink-0 text-[11px] px-2 h-7 rounded-md bg-warning/15 text-warning border-0 cursor-pointer transition-colors hover:bg-warning/25 font-semibold active:scale-[0.96] wake-up-btn">Wake</button>`
              : ""
          }
          <button type="button" title="${video.excluded ? "Add this video back to the total" : "Leave this video out of the total"}" class="shrink-0 text-[11px] px-2 h-7 rounded-md text-text-muted border-0 bg-transparent cursor-pointer transition-colors hover:bg-surface-hover hover:text-text-primary font-medium active:scale-[0.96] toggle-btn">${
            video.excluded ? "Count it" : "Skip"
          }</button>
      `;
  }
}

export function updateVideoListCardsFromState(): void {
  document.querySelectorAll("#video-list [data-id]").forEach((card) => {
    const id = parseInt((card as HTMLElement).dataset.id || "0", 10);
    const video = popup.videoData.find((entry) => entry.id === id);
    if (!video) return;
    updateVideoListItem(card as HTMLElement, video);
  });
  updateQueueOffsets();
}

/** "Next" / "in 10 min" for each video, counting down the queue as if it plays straight through. */
function updateQueueOffsets(): void {
  const container = document.getElementById("video-list");
  if (!container) return;
  const playing = getConfirmedNowPlayingVideos()[0];
  let elapsed = playing && !playing.isLive ? Math.max(0, playing.seconds - playing.currentTime) : 0;
  for (const child of Array.from(container.children) as HTMLElement[]) {
    const video = popup.videoData.find((entry) => entry.id === parseInt(child.dataset.id || "0", 10));
    const inEl = child.querySelector(".meta-offset-in") as HTMLElement | null;
    if (!video || !inEl) continue;
    const countsTowardQueue = !video.excluded && !video.isLive && !isTabActivelyPlaying(video);
    const label = countsTowardQueue ? formatStartsIn(elapsed) : "";
    if (inEl.textContent !== label) inEl.textContent = label;
    child.querySelector(".meta-offset")?.classList.toggle("meta-offset--next", label === "Next");
    if (countsTowardQueue) elapsed += Math.max(0, video.seconds - video.currentTime);
  }
}

export function updateVideoList(videos: VideoData[]) {
  const container = document.getElementById("video-list")!;
  const currentIds = new Set(videos.map((v) => v.id));

  Array.from(container.children).forEach((child) => {
    const id = parseInt((child as HTMLElement).dataset.id || "0");
    if (!currentIds.has(id)) child.remove();
  });

  videos.forEach((video, index) => {
    let item = document.getElementById(`video-item-${video.id}`);

    if (!item) {
      item = document.createElement("div");
      item.id = `video-item-${video.id}`;
      item.dataset.id = video.id.toString();
      item.className = ROW_CLASSES;
      item.innerHTML = `
            <div class="relative shrink-0 w-14 aspect-video rounded overflow-hidden bg-surface-hover">
              <img class="meta-thumb w-full h-full object-cover hidden" alt="" width="56" height="32" loading="${index < EAGER_THUMBS ? "eager" : "lazy"}" />
              <div class="meta-duration-badge absolute bottom-[2px] right-[2px] px-[3px] py-px rounded-[3px] text-[9.5px] font-medium bg-black/80 text-white tabular-nums leading-none"></div>
            </div>
            <div class="flex-1 min-w-0 flex flex-col justify-center gap-px">
              <div class="meta-title text-[12.5px] font-medium text-text-primary truncate leading-snug"></div>
              <div class="meta-line flex items-center gap-1.5 min-w-0 overflow-hidden whitespace-nowrap text-[11px] text-text-muted leading-tight"></div>
            </div>
            <div class="meta-offset shrink-0 flex flex-col items-end leading-tight tabular-nums whitespace-nowrap">
              <span class="meta-offset-in text-[12px] font-semibold text-text-primary"></span>
            </div>
            <div class="meta-controls absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity bg-surface-elevated rounded-lg p-0.5 shadow-lg ring-1 ring-border"></div>
          `;

      container.appendChild(item);
    }

    updateVideoListItem(item, video);

    const referenceNode = container.children[index];
    if (referenceNode !== item) {
      container.insertBefore(item, referenceNode ?? null);
    }
  });
  updateQueueOffsets();
}
