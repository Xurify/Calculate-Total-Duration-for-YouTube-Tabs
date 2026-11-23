import { VideoData, type SavedSessionTab } from "../../utils/storage";
import { formatCompact, formatDurationWords, formatOffset, getVideoIdFromUrl } from "../../utils/format";
import { app } from "./state";
import { deskAvatarHtml } from "./avatars";
import { playbackRate, remainingOf } from "./playback";
import { tabCardDnDHtml } from "./sections";
import { selectedSessionTabUrls, selectedTabIds } from "./state";
import { getThumbnailSrc } from "./tabs";
import { languageTagInnerHtml, plural } from "./time/html";
import { escapeHtml } from "./util";
import { duplicateBadgeHtml, windowBadgeHtml } from "./view-filter";

function queueThumbHtml(videoId: string | null, draggableOff: boolean): string {
  const src = getThumbnailSrc(videoId, "mqdefault.jpg");
  if (!src) return "";
  return `<img src="${src}" class="manager-card-thumb w-full h-full object-cover" loading="lazy" decoding="async" alt=""${draggableOff ? ` draggable="false"` : ""} />`;
}

function queueCheckboxHtml(toggleClass: string, checked: boolean, title: string): string {
  return `
    <div class="relative flex items-center justify-center w-5 h-5 shrink-0 cursor-pointer ${toggleClass}">
      <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-text-muted checked:bg-accent checked:border-accent transition-colors cursor-pointer" aria-label="Select ${escapeHtml(title)}" ${checked ? "checked" : ""}>
      <svg class="absolute w-2.5 h-2.5 text-on-accent opacity-0 peer-checked:opacity-100 pointer-events-none" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>`;
}

const QUEUE_ICON_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
const QUEUE_ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const QUEUE_ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

export function renderVideoList(videos: VideoData[], sectionColorIndex?: number | "unsorted"): string {
  const dnd = tabCardDnDHtml(sectionColorIndex);
  const imgDragOff = sectionColorIndex !== undefined;
  let elapsed = 0;
  return videos.map(video => {
    const isSelected = selectedTabIds.has(video.id);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
    const isNow = video.audible && !video.suspended;
    const offsetLabel = isNow ? "now" : formatOffset(elapsed);
    if (!isNow && !video.isLive) elapsed += Math.max(0, video.seconds - video.currentTime) / playbackRate;
    const rowClass = `queue-row group${isNow ? " queue-row--now" : ""}${isSelected ? " queue-row--selected" : ""}${dnd.extraClass}`;
    const languageLabel = video.languageName ? video.languageName.split("(")[0].trim() : "";
    const stateLabel = video.suspended
      ? `<span class="text-warning">Suspended tab</span>`
      : video.isLive
        ? `<span class="text-youtube font-semibold">Live</span>`
        : "";
    const chaptersHtml =
      video.chapters && video.chapters.length > 0
        ? `
          <div class="video-chapters-container mt-2 pt-2 border-t border-border/40">
            <button type="button" class="video-chapters-toggle text-[11px] font-semibold text-accent hover:text-accent-hover flex items-center gap-1.5 transition-colors cursor-pointer py-0.5" aria-expanded="false">
              <svg class="chapter-toggle-arrow shrink-0 transition-transform" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
              <span>${plural(video.chapters.length, "chapter")}</span>
            </button>
            <div class="video-chapters-list hidden mt-1.5 space-y-1 text-xs">
              ${video.chapters
                .map(
                  (chapter) => `
                <button type="button" class="video-chapter-item w-full text-left border-0 bg-transparent flex items-center justify-between py-1 px-1.5 rounded hover:bg-surface-hover/70 cursor-pointer group/chapter transition-colors" data-video-id="${video.id}" data-time="${chapter.startSeconds}" title="Play from ${formatCompact(chapter.startSeconds)}">
                  <span class="truncate mr-3 font-medium text-text-secondary group-hover/chapter:text-accent transition-colors">${escapeHtml(chapter.title)}</span>
                  <span class="tabular-nums text-[11px] text-text-muted shrink-0">${formatCompact(chapter.startSeconds)}${chapter.durationSeconds ? ` · ${formatDurationWords(chapter.durationSeconds)}` : ""}</span>
                </button>
              `
                )
                .join("")}
            </div>
          </div>
        `
        : "";

    return `
      <div class="${rowClass}" data-id="${video.id}"${dnd.draggableAttr}>
        <div class="queue-offset" title="When this video starts if you watch the list in order">${offsetLabel}</div>
        <div class="queue-body">
          ${queueCheckboxHtml("selection-toggle", isSelected, video.title)}
          <div class="queue-thumb video-click-target cursor-pointer">
            ${queueThumbHtml(getVideoIdFromUrl(video.url), imgDragOff)}
            <div class="manager-card-duration absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-medium text-white tabular-nums">${video.isLive ? "LIVE" : formatCompact(video.seconds)}</div>
            <div class="manager-card-progress-wrap absolute bottom-0 left-0 right-0 h-[3px] bg-black/30 transition-opacity" style="opacity: ${!video.isLive && video.seconds > 0 && watchedPercent > 0 ? 1 : 0}">
              <div class="manager-card-progress h-full bg-accent" style="width: ${watchedPercent}%"></div>
            </div>
          </div>
          <div class="flex-1 min-w-0 cursor-pointer video-click-target">
            <h3 class="manager-card-title queue-title" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
            <div class="queue-meta">
              <span class="manager-card-language lang-tag ${languageLabel ? "" : "hidden"}">${languageTagInnerHtml(languageLabel)}</span>
              <span class="opacity-60">·</span>
              <span class="manager-card-channel truncate">${escapeHtml(video.channelName)}</span>
              ${stateLabel}
              ${windowBadgeHtml(video)}
              ${duplicateBadgeHtml(video.url)}
            </div>
            ${chaptersHtml}
          </div>
          <span class="queue-left manager-card-left">${video.isLive ? "" : formatDurationWords(remainingOf(video))}${!video.isLive && video.currentTime > 0 ? " left" : ""}</span>
          <div class="queue-actions">
            <button type="button" draggable="false" class="queue-action jump-btn" title="Go to tab" aria-label="Go to tab">${QUEUE_ICON_OPEN}</button>
            <button type="button" draggable="false" class="queue-action queue-action--danger close-btn" title="Close tab" aria-label="Close tab">${QUEUE_ICON_CLOSE}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}


export function renderSessionList(tabs: SavedSessionTab[], sectionColorIndex?: number | "unsorted"): string {
  const dnd = tabCardDnDHtml(sectionColorIndex);
  const imgDragOff = sectionColorIndex !== undefined;
  let elapsed = 0;
  return tabs.map((tab) => {
    const title = tab.title ?? "Untitled";
    const channel = tab.channelName ?? "";
    const sec = tab.seconds ?? 0;
    const isSelected = selectedSessionTabUrls.has(tab.url);
    const urlAttr = escapeHtml(tab.url);
    const offsetLabel = formatOffset(elapsed);
    elapsed += sec;
    const languageLabel = tab.languageName ? tab.languageName.split("(")[0].trim() : "";
    return `
      <div class="queue-row group${isSelected ? " queue-row--selected" : ""}${dnd.extraClass}" data-session-tab-url="${urlAttr}"${dnd.draggableAttr}>
        <div class="queue-offset" title="When this video starts if you watch the list in order">${offsetLabel}</div>
        <div class="queue-body">
          ${queueCheckboxHtml("session-selection-toggle", isSelected, title)}
          <div class="queue-thumb session-video-click-target cursor-pointer">
            ${queueThumbHtml(getVideoIdFromUrl(tab.url), imgDragOff)}
            <div class="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-medium text-white tabular-nums">${formatCompact(sec)}</div>
          </div>
          <div class="flex-1 min-w-0 session-video-click-target cursor-pointer">
            <h3 class="queue-title" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
            <div class="queue-meta">
              ${deskAvatarHtml(tab.channelName)}
              <span class="truncate">${escapeHtml(channel)}</span>
              ${languageLabel ? `<span class="lang-tag">${languageTagInnerHtml(languageLabel)}</span>` : ""}
              ${duplicateBadgeHtml(tab.url)}
            </div>
          </div>
          <div class="queue-actions">
            <button type="button" draggable="false" class="queue-action session-open-new-tab" title="Open in new tab" aria-label="Open in new tab">${QUEUE_ICON_OPEN}</button>
            <button type="button" draggable="false" class="queue-action queue-action--danger session-remove-btn" title="Remove from session" aria-label="Remove from session">${QUEUE_ICON_TRASH}</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

