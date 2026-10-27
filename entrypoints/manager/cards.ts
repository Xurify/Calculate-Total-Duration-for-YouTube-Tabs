import { VideoData, type SavedSessionTab } from "../../utils/storage";
import { formatCompact, formatDurationWords, formatOffset, getVideoIdFromUrl } from "../../utils/format";
import { app } from "./state";
import { deskAvatarHtml } from "./avatars";
import { planIsPartial, plannedOrder, plannedTabIds } from "./planner";
import { playbackRate } from "./playback";
import { tabCardDnDHtml } from "./sections";
import { selectedSessionTabUrls, selectedTabIds } from "./state";
import { getThumbnailSrc } from "./tabs";
import { plural } from "./time/html";
import { escapeHtml } from "./util";
import { duplicateBadgeHtml, windowBadgeHtml } from "./view-filter";

function queueThumbHtml(videoId: string | null, draggableOff: boolean): string {
  const thumbQuality = app.thumbnailQuality === "high" ? "hqdefault.jpg" : "mqdefault.jpg";
  const src = getThumbnailSrc(videoId, thumbQuality);
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
            <div class="video-chapters-list hidden mt-1.5 space-y-1 pl-2.5 border-l-2 border-accent/30 text-xs">
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
              ${deskAvatarHtml(video.channelName)}
              <span class="manager-card-channel truncate">${escapeHtml(video.channelName)}</span>
              <span class="opacity-60">·</span>
              <span class="manager-card-time whitespace-nowrap"><span class="manager-card-time-current ${watchedPercent > 0 ? "text-text-primary" : "text-text-muted"}">${formatCompact(video.currentTime)}</span> of <span class="manager-card-time-total">${formatCompact(video.seconds)}</span></span>
              ${plannedTabIds.has(video.id) ? `<span class="text-accent font-medium whitespace-nowrap">${planIsPartial ? "in plan, partly" : `in plan ${plannedOrder.indexOf(video.id) + 1} of ${plannedOrder.length}`}</span>` : ""}
              ${stateLabel}
              <span class="manager-card-language text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-bold uppercase shrink-0 ${languageLabel ? "" : "hidden"}">${escapeHtml(languageLabel)}</span>
              ${windowBadgeHtml(video)}
              ${duplicateBadgeHtml(video.url)}
            </div>
            ${chaptersHtml}
          </div>
          <div class="queue-actions">
            <button type="button" draggable="false" class="queue-action jump-btn" title="Go to tab" aria-label="Go to tab">${QUEUE_ICON_OPEN}</button>
            <button type="button" draggable="false" class="queue-action queue-action--danger close-btn" title="Close tab" aria-label="Close tab">${QUEUE_ICON_CLOSE}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

export function renderSessionGrid(tabs: SavedSessionTab[], sectionColorIndex?: number | "unsorted"): string {
  if (tabs.length === 0) return "";
  const thumbQuality = app.thumbnailQuality === "high" ? "hqdefault.jpg" : "mqdefault.jpg";
  const dnd = tabCardDnDHtml(sectionColorIndex);
  const imgDragOff = sectionColorIndex !== undefined ? ` draggable="false"` : "";
  const cardsHtml = tabs.map((tab) => {
    const videoId = getVideoIdFromUrl(tab.url);
    const thumbnailUrl = getThumbnailSrc(videoId, thumbQuality);
    const imgAttr = `src="${thumbnailUrl}"`;
    const title = tab.title ?? "Untitled";
    const channel = tab.channelName ?? "";
    const sec = tab.seconds ?? 0;
    const isSelected = selectedSessionTabUrls.has(tab.url);
    const urlAttr = escapeHtml(tab.url);
    return `
      <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-[background-color,border-color] ${isSelected ? "bg-surface-hover border-border ring-1 ring-accent/50" : ""}${dnd.extraClass}" data-session-tab-url="${urlAttr}"${dnd.draggableAttr}>
        <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden session-video-click-target cursor-pointer">
          ${thumbnailUrl
        ? `<img ${imgAttr} class="manager-card-thumb w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" decoding="async" alt=""${imgDragOff} />`
        : `<div class="w-full h-full flex items-center justify-center text-text-muted/20"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>`
      }
          <div class="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-medium text-white backdrop-blur-sm tabular-nums">
            ${formatCompact(sec)}
          </div>
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
            <div class="w-11 h-11 rounded-full bg-black/45 flex items-center justify-center backdrop-blur-[2px] ring-1 ring-white/20 shadow-md">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" class="shrink-0 -translate-x-px" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity ${isSelected ? "opacity-100" : ""} session-selection-toggle flex items-center justify-center w-5 h-5">
            <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" aria-label="Select ${escapeHtml(title)}" ${isSelected ? "checked" : ""}>
            <svg class="absolute w-2.5 h-2.5 text-on-accent opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div class="absolute top-1 right-1 z-10 flex gap-1 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 transition-opacity duration-200">
            <button type="button" draggable="false" class="w-7 h-7 flex items-center justify-center hover:bg-black/60 bg-black/40 text-white rounded-md backdrop-blur-sm transition-[background-color] active:scale-[0.96] session-open-new-tab" title="Open in new tab">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
            </button>
            <button type="button" draggable="false" class="w-7 h-7 flex items-center justify-center hover:bg-danger/80 bg-black/40 text-white rounded-md backdrop-blur-sm transition-[background-color] active:scale-[0.96] session-remove-btn" title="Remove from session">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
            </button>
          </div>
        </div>
        <div class="p-2 session-video-click-target cursor-pointer">
          <h3 class="text-xs font-medium text-text-primary line-clamp-2 leading-snug mb-1 min-h-[2.5em]" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
          <div class="flex items-center justify-between gap-2">
            <div class="text-[10px] text-text-muted flex items-center gap-1.5 min-w-0">${deskAvatarHtml(tab.channelName)}<span class="truncate">${escapeHtml(channel)}</span></div>
            <div class="flex items-center gap-1 shrink-0">
              ${duplicateBadgeHtml(tab.url)}
              ${tab.languageName ? `<div class="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-bold uppercase shrink-0">${escapeHtml(tab.languageName.split('(')[0].trim())}</div>` : ''}
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");
  return `<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 p-1">${cardsHtml}</div>`;
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
              ${languageLabel ? `<span class="text-[10px] bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-bold uppercase shrink-0">${escapeHtml(languageLabel)}</span>` : ""}
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

export function renderVideoGrid(videos: VideoData[], sectionColorIndex?: number | "unsorted"): string {
  if (videos.length === 0) return '';

  const thumbQuality = app.thumbnailQuality === 'high' ? 'hqdefault.jpg' : 'mqdefault.jpg';
  const dnd = tabCardDnDHtml(sectionColorIndex);
  const imgDragOff = sectionColorIndex !== undefined ? ` draggable="false"` : "";
  const cardsHtml = videos.map(video => {
    const isSelected = selectedTabIds.has(video.id);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
    const videoId = getVideoIdFromUrl(video.url);
    const thumbnailUrl = getThumbnailSrc(videoId, thumbQuality);
    const imgAttr = `src="${thumbnailUrl}"`;

    return `
            <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-[background-color,border-color] ${isSelected ? 'bg-surface-hover border-border ring-1 ring-accent/50' : ''}${dnd.extraClass}" data-id="${video.id}"${dnd.draggableAttr}>
                <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden video-click-target cursor-pointer">
                    ${thumbnailUrl
        ? `<img ${imgAttr} class="manager-card-thumb w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" decoding="async" alt=""${imgDragOff} />`
        : `<div class="w-full h-full flex items-center justify-center text-text-muted/20"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>`
      }
                    <div class="manager-card-duration absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-medium text-white backdrop-blur-sm tabular-nums">
                        ${video.isLive ? 'LIVE' : formatCompact(video.seconds)}
                    </div>

                    <div class="manager-card-progress-wrap absolute bottom-0 left-0 right-0 h-[3px] bg-surface/30 transition-opacity" style="opacity: ${!video.isLive && video.seconds > 0 && watchedPercent > 0 ? 1 : 0}">
                        <div class="manager-card-progress h-full bg-accent" style="width: ${watchedPercent}%"></div>
                    </div>

                    <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                        <div class="w-11 h-11 rounded-full bg-black/45 flex items-center justify-center backdrop-blur-[2px] ring-1 ring-white/20 shadow-md">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" class="shrink-0 -translate-x-px" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                    </div>

                    <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity ${isSelected ? 'opacity-100' : ''} selection-toggle flex items-center justify-center w-5 h-5">
                        <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" aria-label="Select ${escapeHtml(video.title)}" ${isSelected ? 'checked' : ''}>
                        <svg class="absolute w-2.5 h-2.5 text-on-accent opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>

                    <div class="absolute top-1 right-1 z-10 flex gap-1 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 transition-opacity duration-200">
                         <button type="button" draggable="false" class="w-7 h-7 flex items-center justify-center bg-black/40 hover:bg-accent text-white rounded-md backdrop-blur-sm border border-white/10 hover:border-accent transition-[background-color,border-color] duration-200 active:scale-[0.96] jump-btn" title="Go to tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                         </button>
                         <button type="button" draggable="false" class="w-7 h-7 flex items-center justify-center bg-black/40 hover:bg-danger text-white rounded-md backdrop-blur-sm border border-white/10 hover:border-danger transition-[background-color,border-color] duration-200 active:scale-[0.96] close-btn" title="Close tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                         </button>
                    </div>
                </div>

                <div class="p-2 video-click-target cursor-pointer">
                    <h3 class="manager-card-title text-xs font-medium text-text-primary line-clamp-2 leading-snug mb-1 min-h-[2.5em]" title="${escapeHtml(video.title)}">${escapeHtml(video.title)}</h3>
                    <div class="flex items-center justify-between text-[10px] text-text-muted gap-2">
                        <span class="flex items-center gap-1.5 min-w-0">${deskAvatarHtml(video.channelName)}<span class="manager-card-channel truncate hover:text-text-secondary transition-colors">${escapeHtml(video.channelName)}</span></span>
                        <div class="flex items-center gap-1 shrink-0">
                          ${windowBadgeHtml(video)}
                          ${duplicateBadgeHtml(video.url)}
                          ${video.languageName ? `<span class="manager-card-language bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-bold uppercase shrink-0">${escapeHtml(video.languageName.split('(')[0].trim())}</span>` : `<span class="manager-card-language hidden"></span>`}
                        </div>
                    </div>
                    ${
                      video.chapters && video.chapters.length > 0
                        ? `
                          <div class="video-chapters-container mt-1.5 pt-1.5 border-t border-border/40">
                            <button type="button" class="video-chapters-toggle text-[10px] font-semibold text-accent hover:text-accent-hover flex items-center gap-1 transition-colors cursor-pointer py-0.5" aria-expanded="false">
                              <svg class="chapter-toggle-arrow shrink-0 transition-transform" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
                              <span>${plural(video.chapters.length, "chapter")}</span>
                            </button>
                            <div class="video-chapters-list hidden mt-1 space-y-0.5 pl-2 border-l-2 border-accent/30 text-[11px] max-h-36 overflow-y-auto custom-scrollbar">
                              ${video.chapters
                                .map(
                                  (chapter) => `
                                <button type="button" class="video-chapter-item w-full text-left border-0 bg-transparent flex items-center justify-between py-0.5 px-1 rounded hover:bg-surface-hover/70 cursor-pointer group/chapter transition-colors" data-video-id="${video.id}" data-time="${chapter.startSeconds}" title="Play from ${formatCompact(chapter.startSeconds)}">
                                  <span class="truncate mr-1 font-medium text-text-secondary group-hover/chapter:text-accent transition-colors text-[10px]">${escapeHtml(chapter.title)}</span>
                                  <span class="tabular-nums text-[10px] text-text-muted shrink-0">${formatCompact(chapter.startSeconds)}</span>
                                </button>
                              `
                                )
                                .join("")}
                            </div>
                          </div>
                        `
                        : ""
                    }
                </div>
            </div>
        `;
  }).join('');

  return `<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 p-1">${cardsHtml}</div>`;
}
