import { isYoutubeWatchOrShortsUrl } from "../../utils/format";
import { queryReadingList, type ReadingListItem } from "../../utils/readingList";
import { app } from "./state";
import { escapeHtml } from "./util";

export async function loadReadingList(): Promise<void> {
  app.readingListItems = await queryReadingList(false);
  const badgeElement = document.getElementById("reading-list-badge");
  if (badgeElement) {
    badgeElement.textContent = String(app.readingListItems.length);
  }
}

function extractDomain(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return rawUrl;
  }
}

function formatAddedAgo(timestampMs: number): string {
  if (!timestampMs) return "";
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSeconds < 60) return "Just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(timestampMs).toLocaleDateString();
}

export function renderReadingListCard(item: ReadingListItem): string {
  const isYouTube = isYoutubeWatchOrShortsUrl(item.url);
  const domain = extractDomain(item.url);
  const addedTime = formatAddedAgo(item.creationTime);

  const domainBadgeHtml = isYouTube
    ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-youtube/12 text-youtube border border-youtube/30">
        <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        YouTube Study
      </span>`
    : `<span class="text-[10px] bg-surface-elevated border border-border text-text-secondary px-2 py-0.5 rounded-full font-medium">
        ${escapeHtml(domain)}
      </span>`;

  const timeHtml = addedTime
    ? `<span class="text-[10px] text-text-muted tabular-nums">${escapeHtml(addedTime)}</span>`
    : "";

  return `
    <div class="reading-list-card group p-3.5 rounded-xl border border-border bg-surface hover:bg-surface-elevated/70 hover:border-border-hover transition-all flex items-center justify-between gap-4" data-reading-list-url="${escapeHtml(item.url)}">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 mb-1.5">
          ${domainBadgeHtml}
          ${timeHtml}
        </div>
        <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" class="reading-list-title text-sm font-semibold text-text-primary hover:text-accent transition-colors truncate block" title="${escapeHtml(item.title || item.url)}">
          ${escapeHtml(item.title || item.url)}
        </a>
        <div class="text-[11px] text-text-muted truncate mt-0.5 tabular-nums opacity-60">${escapeHtml(item.url)}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button type="button" class="reading-list-open-btn px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-surface-elevated text-text-secondary hover:text-text-primary text-xs font-semibold border border-border flex items-center gap-1.5 transition-colors cursor-pointer active:scale-95" title="Open in new tab">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          <span>Open</span>
        </button>
        <button type="button" class="reading-list-remove-btn w-8 h-8 rounded-lg hover:bg-danger/10 text-text-muted hover:text-danger flex items-center justify-center transition-colors border border-transparent hover:border-danger/20 cursor-pointer active:scale-95" title="Remove from reading list">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `;
}
