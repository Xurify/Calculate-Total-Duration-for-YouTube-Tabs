import { VideoData, type SavedSessionTab } from "../../utils/storage";
import { formatTime, formatDurationWords, normalizeText } from "../../utils/format";
import { countItemsByVideoId, duplicateCountForUrl, type DuplicateSummary } from "../../utils/sessions";
import { app } from "./state";
import { facetCrumbText, facetMatchesSessionTab, facetMatchesVideo, hasAnyFacet } from "./facets";
import { orderedSections } from "./sections";
import { videoGroupKey } from "./sorting";
import { escapeHtml } from "./util";

export function duplicateBadgeHtml(url: string): string {
  const count = duplicateCountForUrl(app.scopeVideoIdCounts, url);
  if (count <= 1) return "";
  return `<span class="text-[10px] bg-warning/15 text-warning border border-warning/30 px-1.5 py-0.5 rounded font-bold shrink-0 tabular-nums" title="This video appears ${count} times in this view">×${count}</span>`;
}

function shouldShowWindowBadge(): boolean {
  return app.selectedSession == null && app.currentWindowId === "all" && app.windowGroups.length > 1;
}

function windowLabelForVideo(video: VideoData): string | null {
  if (!shouldShowWindowBadge() || video.windowId == null) return null;
  return app.windowGroups.find((group) => group.id === video.windowId)?.label ?? null;
}

export function windowBadgeHtml(video: VideoData): string {
  const label = windowLabelForVideo(video);
  if (!label) return "";
  return `<span class="text-[10px] bg-surface-elevated border border-border text-text-secondary px-1.5 py-0.5 rounded font-medium shrink-0 tabular-nums" title="Open in ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}


export function liveVideoStructurePart(video: VideoData): string {
  const groupKey =
    app.groupingMode === "channel" || app.groupingMode === "language" ? `|${videoGroupKey(video)}` : "";
  return `${video.id}|${video.windowId ?? ""}|${video.url}|${video.audible && !video.suspended ? 1 : 0}${groupKey}`;
}

function formatDuplicateStatsSuffix(summary: DuplicateSummary): string {
  if (summary.duplicateVideoCount === 0) return "";
  const videosLabel = summary.duplicateVideoCount === 1 ? "duplicate video" : "duplicate videos";
  const tabsLabel = summary.extraTabCount === 1 ? "extra tab" : "extra tabs";
  return ` · ${summary.duplicateVideoCount} ${videosLabel} (${summary.extraTabCount} ${tabsLabel})`;
}

export function formatViewStats(count: number, durationSec: number, summary: DuplicateSummary): string {
  if (count === 0) return "";
  const dupSuffix = formatDuplicateStatsSuffix(summary);
  if (app.showDuplicatesOnly && summary.duplicateVideoCount > 0) {
    return `${count} duplicate tab${count === 1 ? "" : "s"} · ${formatTime(durationSec)} total duration`;
  }
  return `${count} video${count === 1 ? "" : "s"}${dupSuffix} · ${formatDurationWords(durationSec)} in total`;
}

function refreshScopeVideoIdCountsFromVideos(videos: VideoData[]): void {
  app.scopeVideoIdCounts = countItemsByVideoId(videos, (video) => video.url);
}

function refreshScopeVideoIdCountsFromSessionTabs(tabs: SavedSessionTab[]): void {
  app.scopeVideoIdCounts = countItemsByVideoId(tabs, (tab) => tab.url ?? "");
}

export function filterVideosForDisplay(videos: VideoData[], options: { ignoreFacet?: boolean } = {}): VideoData[] {
  refreshScopeVideoIdCountsFromVideos(videos);
  let result = videos;
  if (!options.ignoreFacet && hasAnyFacet()) result = result.filter((video) => facetMatchesVideo(video));
  if (app.searchQuery) {
    const searchQueryNormalized = normalizeText(app.searchQuery);
    result = result.filter(
      (video) =>
        normalizeText(video.title).includes(searchQueryNormalized) ||
        normalizeText(video.channelName).includes(searchQueryNormalized)
    );
  }
  if (app.showDuplicatesOnly) {
    result = result.filter((video) => duplicateCountForUrl(app.scopeVideoIdCounts, video.url) > 1);
  }
  return result;
}

export function filterSessionTabsForDisplay(tabs: SavedSessionTab[], options: { ignoreFacet?: boolean } = {}): SavedSessionTab[] {
  refreshScopeVideoIdCountsFromSessionTabs(tabs);
  let result = tabs;
  if (!options.ignoreFacet && hasAnyFacet()) {
    const sections = orderedSections(app.selectedSession?.sections);
    result = result.filter((tab) => facetMatchesSessionTab(tab, sections));
  }
  if (app.searchQuery) {
    const searchNormalized = normalizeText(app.searchQuery);
    result = result.filter(
      (tab) =>
        normalizeText(tab.title ?? "").includes(searchNormalized) ||
        normalizeText(tab.channelName ?? "").includes(searchNormalized)
    );
  }
  if (app.showDuplicatesOnly) {
    result = result.filter((tab) => duplicateCountForUrl(app.scopeVideoIdCounts, tab.url ?? "") > 1);
  }
  return result;
}

export function updateDuplicatesFilterButton(summary: DuplicateSummary): void {
  const btn = document.getElementById("btn-filter-duplicates");
  const label = document.getElementById("btn-filter-duplicates-label");
  if (!btn || !label) return;

  const hasDuplicates = summary.duplicateVideoCount > 0;
  btn.classList.toggle("text-accent", app.showDuplicatesOnly);
  btn.classList.toggle("border-accent/40", app.showDuplicatesOnly);
  btn.classList.toggle("bg-accent/10", app.showDuplicatesOnly);
  btn.classList.toggle("text-text-muted", !app.showDuplicatesOnly);
  btn.classList.toggle("opacity-40", !hasDuplicates && !app.showDuplicatesOnly);
  btn.toggleAttribute("disabled", !hasDuplicates && !app.showDuplicatesOnly);

  label.textContent = hasDuplicates ? `Duplicates (${summary.duplicateVideoCount})` : "Duplicates";
  btn.title = hasDuplicates
    ? `${summary.duplicateVideoCount} video${summary.duplicateVideoCount === 1 ? "" : "s"} appear more than once (${summary.extraTabCount} extra tab${summary.extraTabCount === 1 ? "" : "s"}). Click to ${app.showDuplicatesOnly ? "show all" : "show duplicates only"}.`
    : "No duplicate videos in this view";
}

export function emptyListMessage(): string {
  const query = app.searchQuery.trim();
  if (query) {
    return `
      <div class="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div class="font-display text-xl text-text-primary">Nothing matches “${escapeHtml(query)}”</div>
        <div class="text-sm text-text-muted mt-1 max-w-sm">Search looks at titles and channel names${facetCrumbText() ? ` in ${escapeHtml(facetCrumbText())}` : ""}.</div>
        <button type="button" data-empty-action="clear-search" class="chip mt-4">Clear search</button>
      </div>
    `;
  }
  if (app.showDuplicatesOnly) {
    return `
      <div class="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div class="font-display text-xl text-text-primary">No duplicates here</div>
        <div class="text-sm text-text-muted mt-1">Every video in this view is open only once.</div>
      </div>
    `;
  }
  return `
      <div class="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div class="font-display text-xl text-text-primary">The desk is clear</div>
        <div class="text-sm text-text-muted mt-1 max-w-sm">Open YouTube videos and they will line up here with the time they take.</div>
      </div>
    `;
}
