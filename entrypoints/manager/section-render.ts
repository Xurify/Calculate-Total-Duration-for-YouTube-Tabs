import { VideoData, type SavedSessionTab, type SessionSection } from "../../utils/storage";
import { formatTime } from "../../utils/format";
import { app } from "./state";
import { deskAvatarHtml } from "./avatars";
import { renderSessionGrid, renderSessionList, renderVideoGrid, renderVideoList } from "./cards";
import { sectionRailVar } from "./palette";
import {
  partitionLiveVideosBySection,
  partitionSessionTabsBySection,
  SECTION_COLLAPSE_PREFIX,
  UNSORTED_COLLAPSE_KEY,
} from "./sections";
import {
  orderLiveGroupEntries,
  orderSessionGroupEntries,
  sessionTabGroupKey,
  sortSessionTabsForDisplay,
  sortVideosForDisplay,
  videoGroupKey,
} from "./sorting";
import { collapsedGroups, selectedTabIds } from "./state";
import { plural } from "./time/html";
import { escapeHtml } from "./util";

function renderSectionHeaderHtml(options: {
  title: string;
  emoji?: string;
  subtitle?: string;
  countLabel: string;
  durationLabel: string;
  collapseKey: string;
  colorIndex: number | "unsorted";
  sectionId?: string;
}): string {
  const isCollapsed = collapsedGroups.has(options.collapseKey);
  const rail = sectionRailVar(options.colorIndex);
  const dataSectionAttr = options.sectionId ? ` data-section-id="${escapeHtml(options.sectionId)}"` : "";
  return `
    <div class="queue-section-head" style="--section-rail: ${rail}">
      <button type="button" class="section-collapse-toggle p-1 rounded-md hover:bg-surface-hover/60 text-text-muted transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}" data-section-collapse="${escapeHtml(options.collapseKey)}" aria-expanded="${isCollapsed ? "false" : "true"}" aria-label="Show or hide ${escapeHtml(options.title)}">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      <div class="queue-section-line">
        <span class="queue-section-dot" style="background: ${rail}" aria-hidden="true"></span>
        <h3 class="queue-section-title cursor-default section-title-target"${dataSectionAttr}>${escapeHtml(options.title)}</h3>
        ${options.countLabel.startsWith("0 ")
          ? `<span class="session-stat-pill italic">empty</span>`
          : `<span class="session-stat-pill">${escapeHtml(options.countLabel)}</span><span class="session-stat-pill">${escapeHtml(options.durationLabel)}</span>`}
      </div>
    </div>
  `;
}

function renderSectionEmptyPlaceholder(colorIndex: number): string {
  const rail = sectionRailVar(colorIndex);
  return `
    <div class="section-empty-hint" style="--section-rail: ${rail}">Empty. Drag a video here, or right-click one and choose Move to pile.</div>
  `;
}

export function nestedChannelCollapseKey(scopeId: string, channel: string): string {
  return `sg:${scopeId}:${channel}`;
}

function renderSessionTabsInnerHtml(
  tabs: SavedSessionTab[],
  sectionColor: number | "unsorted",
  collapseScopeId: string
): string {
  if (tabs.length === 0) return "";
  if (app.groupingMode === "none") {
    const sorted = sortSessionTabsForDisplay(tabs);
    return app.layoutMode === "grid" ? renderSessionGrid(sorted, sectionColor) : renderSessionList(sorted, sectionColor);
  }
  const groups = new Map<string, SavedSessionTab[]>();
  tabs.forEach((tab) => {
    const name = sessionTabGroupKey(tab);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(tab);
  });
  return orderSessionGroupEntries(Array.from(groups.entries()))
    .map(([groupName, tabList]) => {
      const ck = nestedChannelCollapseKey(collapseScopeId, groupName);
      const isCollapsed = collapsedGroups.has(ck);
      const groupDuration = tabList.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const sortedTabs = sortSessionTabsForDisplay(tabList);
      const gridOrList =
        app.layoutMode === "grid" ? renderSessionGrid(sortedTabs, sectionColor) : renderSessionList(sortedTabs, sectionColor);
      return `
            <div class="mb-3">
              <div class="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface-hover/30 group/header select-none">
                <button type="button" class="p-1 rounded hover:bg-surface-hover text-text-muted transition-transform duration-200 nested-group-toggle ${isCollapsed ? "-rotate-90" : ""}" data-nested-group="${escapeHtml(ck)}">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
                <div class="flex-1 min-w-0 flex items-center gap-2 font-medium text-xs text-text-secondary nested-group-toggle cursor-pointer" data-nested-group="${escapeHtml(ck)}">${app.groupingMode === "channel" ? deskAvatarHtml(groupName, "w-5 h-5 text-[9px]") : ""}<span class="truncate">${escapeHtml(groupName)}</span></div>
                <div class="aggregate-group-stats text-[10px] text-text-muted tabular-nums flex items-center gap-2" data-group-name="${escapeHtml(groupName)}">
                  <span>${plural(tabList.length, "video")}</span>
                  <span class="w-px h-3 bg-border"></span>
                  <span>${formatTime(groupDuration)}</span>
                </div>
              </div>
              <div class="space-y-1 ml-10 border-l border-border/60 pl-2 mt-1 ${isCollapsed ? "hidden" : ""}" data-nested-group-body="${escapeHtml(ck)}">
                ${gridOrList}
              </div>
            </div>
          `;
    })
    .join("");
}

function renderLiveVideosInnerHtml(
  videos: VideoData[],
  sectionColor: number | "unsorted",
  collapseScopeId: string
): string {
  if (videos.length === 0) return "";
  if (app.groupingMode === "none") {
    const sortedVideos = sortVideosForDisplay(videos);
    return app.layoutMode === "grid" ? renderVideoGrid(sortedVideos, sectionColor) : renderVideoList(sortedVideos, sectionColor);
  }
  const groups = new Map<string, VideoData[]>();
  videos.forEach((video) => {
    const name = videoGroupKey(video);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(video);
  });
  return orderLiveGroupEntries(Array.from(groups.entries()))
    .map(([groupName, groupVideos]) => {
      const ck = nestedChannelCollapseKey(collapseScopeId, groupName);
      const isCollapsed = collapsedGroups.has(ck);
      const groupDuration = groupVideos.reduce((accumulator, video) => accumulator + video.seconds, 0);
      const sortedGroupVideos = sortVideosForDisplay(groupVideos);
      const allSelected = groupVideos.every((video) => selectedTabIds.has(video.id));
      const someSelected = !allSelected && groupVideos.some((video) => selectedTabIds.has(video.id));
      const inner =
        app.layoutMode === "grid" ? renderVideoGrid(sortedGroupVideos, sectionColor) : renderVideoList(sortedGroupVideos, sectionColor);
      return `
            <div class="mb-3">
                <div class="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface-hover/30 group/header select-none">
                    <button type="button" class="p-1 rounded hover:bg-surface-hover text-text-muted transition-transform duration-200 nested-group-toggle ${isCollapsed ? "-rotate-90" : ""}" data-nested-group="${escapeHtml(ck)}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    <div class="relative flex items-center justify-center w-4 h-4 cursor-pointer nested-group-selection-toggle" data-nested-group-scope="${escapeHtml(collapseScopeId)}" data-nested-group-name="${escapeHtml(groupName)}">
                      <input type="checkbox" class="peer appearance-none w-3.5 h-3.5 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${allSelected ? "checked" : ""} ${someSelected ? "indeterminate" : ""}>
                       <svg class="absolute w-2 h-2 text-on-accent opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                       <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 ${someSelected && !allSelected ? "opacity-100" : ""}">
                          <div class="w-2 h-0.5 bg-accent"></div>
                       </div>
                    </div>
                    <div class="flex-1 min-w-0 flex items-center gap-2 font-medium text-xs text-text-secondary nested-group-toggle cursor-pointer" data-nested-group="${escapeHtml(ck)}">${app.groupingMode === "channel" ? deskAvatarHtml(groupName, "w-5 h-5 text-[9px]") : ""}<span class="truncate">${escapeHtml(groupName)}</span></div>
                    <div class="aggregate-group-stats text-[10px] text-text-muted tabular-nums flex items-center gap-2" data-group-name="${escapeHtml(groupName)}">
                        <span>${plural(groupVideos.length, "video")}</span>
                        <span class="w-px h-3 bg-border"></span>
                        <span>${formatTime(groupDuration)}</span>
                    </div>
                </div>
                <div class="space-y-1 ml-10 border-l border-border/60 pl-2 mt-1 ${isCollapsed ? "hidden" : ""}" data-nested-group-body="${escapeHtml(ck)}">
                    ${inner}
                </div>
            </div>
          `;
    })
    .join("");
}

function buildSessionSectionedHtml(tabsToShow: SavedSessionTab[], sections: SessionSection[]): string {
  const { blocks, unsorted } = partitionSessionTabsBySection(tabsToShow, sections);
  const parts: string[] = [];
  for (const { section, tabs } of blocks) {
    const ck = `${SECTION_COLLAPSE_PREFIX}${section.id}`;
    const color = section.colorIndex ?? 0;
    const dur = tabs.reduce((s, t) => s + (t.seconds ?? 0), 0);
    const header = renderSectionHeaderHtml({
      title: section.name,
      emoji: section.emoji,
      collapseKey: ck,
      countLabel: plural(tabs.length, "video"),
      durationLabel: formatTime(dur),
      colorIndex: color,
      sectionId: section.id,
    });
    const collapsed = collapsedGroups.has(ck);
    const body =
      tabs.length === 0
        ? renderSectionEmptyPlaceholder(color)
        : renderSessionTabsInnerHtml(tabs, color, section.id);
    parts.push(`
      <div class="queue-section" data-section-wrapper="${escapeHtml(section.id)}">
        ${header}
        <div class="pl-1 ${collapsed ? "hidden" : ""}" data-section-body="${escapeHtml(section.id)}">
          ${body}
        </div>
      </div>
    `);
  }
  {
    const ck = UNSORTED_COLLAPSE_KEY;
    const dur = unsorted.reduce((s, t) => s + (t.seconds ?? 0), 0);
    const header = renderSectionHeaderHtml({
      title: "Unsorted",
      emoji: "✦",
      subtitle: "Videos not in any pile yet",
      collapseKey: ck,
      countLabel: plural(unsorted.length, "video"),
      durationLabel: formatTime(dur),
      colorIndex: "unsorted",
    });
    const collapsed = collapsedGroups.has(ck);
    const body =
      unsorted.length === 0 ? "" : renderSessionTabsInnerHtml(unsorted, "unsorted", "__unsorted");
    parts.push(`
      <div class="queue-section" data-section-wrapper="__unsorted">
        ${header}
        <div class="pl-1 ${collapsed ? "hidden" : ""}" data-section-body="__unsorted">
          ${body}
        </div>
      </div>
    `);
  }
  return parts.join("");
}

function sectionCollapseKeyToBodyId(collapseKey: string): string {
  if (collapseKey.startsWith(SECTION_COLLAPSE_PREFIX)) {
    return collapseKey.slice(SECTION_COLLAPSE_PREFIX.length);
  }
  return collapseKey;
}

export function applySectionCollapseDom(collapseKey: string, collapsed: boolean): void {
  const tabList = document.getElementById("tab-list");
  if (!tabList) return;
  const bodyId = sectionCollapseKeyToBodyId(collapseKey);
  const body = tabList.querySelector(`[data-section-body="${bodyId}"]`) as HTMLElement | null;
  if (body) body.classList.toggle("hidden", collapsed);
  tabList.querySelectorAll(".section-collapse-toggle[data-section-collapse]").forEach((el) => {
    const h = el as HTMLElement;
    if (h.dataset.sectionCollapse === collapseKey) {
      h.classList.toggle("-rotate-90", collapsed);
      h.setAttribute("aria-expanded", collapsed ? "false" : "true");
    }
  });
}

function findNestedGroupBodyEl(nestedKey: string): HTMLElement | null {
  const tabList = document.getElementById("tab-list");
  if (!tabList) return null;
  return Array.from(tabList.querySelectorAll("[data-nested-group-body]")).find(
    (el) => el.getAttribute("data-nested-group-body") === nestedKey
  ) as HTMLElement | null;
}

export function applyNestedGroupCollapseDom(nestedKey: string, collapsed: boolean): void {
  const tabList = document.getElementById("tab-list");
  if (!tabList) return;
  const body = findNestedGroupBodyEl(nestedKey);
  if (body) body.classList.toggle("hidden", collapsed);
  tabList.querySelectorAll("button.nested-group-toggle").forEach((el) => {
    const h = el as HTMLElement;
    if (h.dataset.nestedGroup === nestedKey) {
      h.classList.toggle("-rotate-90", collapsed);
    }
  });
}

export function applyFlatChannelGroupCollapseDom(channel: string, collapsed: boolean): void {
  const tabList = document.getElementById("tab-list");
  if (!tabList) return;
  const body = Array.from(tabList.querySelectorAll("[data-flat-group-body]")).find(
    (element) => element.getAttribute("data-flat-group-body") === channel
  ) as HTMLElement | null;
  if (body) {
    body.classList.toggle("hidden", collapsed);
  }
  tabList.querySelectorAll("button.group-toggle").forEach((element) => {
    const buttonElement = element as HTMLElement;
    if (buttonElement.dataset.group === channel) {
      buttonElement.classList.toggle("-rotate-90", collapsed);
    }
  });
}

function wireSectionLayoutInteractivity(_container: HTMLElement) {
  /* Collapse/expand uses delegated click + DOM updates (apply*CollapseDom); no per-render listeners. */
}

function buildLiveSectionedHtml(videosToShow: VideoData[], sections: SessionSection[], assignments: Record<string, string>): string {
  const { blocks, unsorted } = partitionLiveVideosBySection(videosToShow, sections, assignments);
  const parts: string[] = [];
  for (const { section, videos } of blocks) {
    const ck = `${SECTION_COLLAPSE_PREFIX}${section.id}`;
    const color = section.colorIndex ?? 0;
    const dur = videos.reduce((s, v) => s + v.seconds, 0);
    const header = renderSectionHeaderHtml({
      title: section.name,
      emoji: section.emoji,
      collapseKey: ck,
      countLabel: plural(videos.length, "video"),
      durationLabel: formatTime(dur),
      colorIndex: color,
      sectionId: section.id,
    });
    const collapsed = collapsedGroups.has(ck);
    const body =
      videos.length === 0
        ? renderSectionEmptyPlaceholder(color)
        : renderLiveVideosInnerHtml(videos, color, section.id);
    parts.push(`
      <div class="queue-section" data-section-wrapper="${escapeHtml(section.id)}">
        ${header}
        <div class="pl-1 ${collapsed ? "hidden" : ""}" data-section-body="${escapeHtml(section.id)}">
          ${body}
        </div>
      </div>
    `);
  }
  {
    const ck = UNSORTED_COLLAPSE_KEY;
    const dur = unsorted.reduce((s, v) => s + v.seconds, 0);
    const header = renderSectionHeaderHtml({
      title: "Unsorted",
      emoji: "✦",
      subtitle: "Videos not in any pile yet",
      collapseKey: ck,
      countLabel: plural(unsorted.length, "video"),
      durationLabel: formatTime(dur),
      colorIndex: "unsorted",
    });
    const collapsed = collapsedGroups.has(ck);
    const body = unsorted.length === 0 ? "" : renderLiveVideosInnerHtml(unsorted, "unsorted", "__unsorted");
    parts.push(`
      <div class="queue-section" data-section-wrapper="__unsorted">
        ${header}
        <div class="pl-1 ${collapsed ? "hidden" : ""}" data-section-body="__unsorted">
          ${body}
        </div>
      </div>
    `);
  }
  return parts.join("");
}
