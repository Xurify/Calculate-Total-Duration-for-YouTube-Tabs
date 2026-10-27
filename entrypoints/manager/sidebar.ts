import { VideoData, getSavedSessions } from "../../utils/storage";
import { formatDurationWords } from "../../utils/format";
import { app } from "./state";
import { clearFacets } from "./facets";
import { sectionRailVar } from "./palette";
import { leftSuffix, remainingOf } from "./playback";
import { getLiveVideosForCurrentView, render } from "./render";
import {
  openAddSectionModal,
  orderedSections,
  partitionLiveVideosBySection,
  partitionSessionTabsBySection,
} from "./sections";
import { updateSelectionUI } from "./selection";
import { refreshSavedSessionsSidebar } from "./sessions-sidebar";
import { sortSessionTabsForDisplay, sortVideosForDisplay } from "./sorting";
import { selectedSessionTabUrls, selectedTabIds } from "./state";
import { plural } from "./time/html";
import { escapeHtml, positionFixedMenu } from "./util";
import { filterSessionTabsForDisplay } from "./view-filter";

export function renderSidebar() {
  const container = document.getElementById("window-list-windows");
  if (!container) return;

  const totalDuration = app.allVideos.reduce((accumulator, video) => accumulator + video.seconds, 0);
  const totalTabs = app.allVideos.length;

  syncTopNavState();

  const fingerprint = [
    String(app.isReadingListView),
    String(app.selectedSession?.id ?? ""),
    String(app.currentWindowId),
    String(totalTabs),
    String(totalDuration),
    app.windowGroups.map((group) => `${group.id}:${group.label}:${group.duration}:${group.tabs.length}`).join("|"),
  ].join("\x1f");

  if (fingerprint === app.lastSidebarFingerprint) return;
  app.lastSidebarFingerprint = fingerprint;

  if (!app.isSessionsView) {
    document.getElementById("global-stats-count")!.textContent = `${plural(totalTabs, "video")} · ${formatDurationWords(totalDuration)}`;
  }

  const liveView = !app.isReadingListView && app.selectedSession == null;
  const isAllActive = app.currentWindowId === 'all' && liveView;
  let html = `
    <button type="button" class="sidebar-item window-chip ${isAllActive ? "bg-surface-hover" : ""}" data-sidebar-type="all">All windows · ${totalTabs}</button>
  `;

  app.windowGroups.forEach((group) => {
    const isActive = app.currentWindowId === group.id && liveView;
    html += `
      <button type="button" class="sidebar-item window-chip ${isActive ? "bg-surface-hover" : ""}" data-sidebar-type="window" data-window-id="${group.id}" title="${formatDurationWords(group.duration)}">${escapeHtml(group.label)} · ${group.tabs.length}</button>
    `;
  });

  container.innerHTML = html;
}

export function syncTopNavState(): void {
  const states: [string, boolean][] = [
    ["nav-desk", !app.isReadingListView && !app.isSessionsView && !app.isTimeView && !app.isPracticeView && app.selectedSession == null],
    ["nav-reading-list", app.isReadingListView],
    ["nav-sessions", app.isSessionsView || app.selectedSession != null],
    ["nav-time", app.isTimeView],
    ["nav-practice", app.isPracticeView],
  ];
  for (const [id, active] of states) {
    const element = document.getElementById(id);
    element?.classList.toggle("bg-surface-hover", active);
    element?.classList.toggle("text-text-primary", active);
  }
  document.getElementById("windows-block")?.classList.toggle("hidden", app.isReadingListView || app.isSessionsView || app.isTimeView || app.isPracticeView || app.selectedSession != null);
}

export function setDeskHero(options: { kicker: string; title: string; value: string; suffix: string }): void {
  const kicker = document.getElementById("desk-kicker");
  const value = document.getElementById("desk-time-value");
  const suffix = document.getElementById("desk-time-suffix");
  if (kicker && kicker.textContent !== options.kicker) kicker.textContent = options.kicker;
  if (value && value.textContent !== options.value) value.textContent = options.value;
  if (suffix && suffix.textContent !== options.suffix) suffix.textContent = options.suffix;
}

export function liveHeroTime(videos: VideoData[]): { value: string; suffix: string } {
  if (videos.length === 0) return app.searchQuery.trim() ? { value: "No", suffix: "matches" } : { value: "No", suffix: "videos open" };
  return { value: formatDurationWords(liveRemainingSeconds(videos)), suffix: leftSuffix() };
}

function liveRemainingSeconds(videos: VideoData[]): number {
  return videos.reduce((sum, video) => sum + remainingOf(video), 0);
}

function pileCardHtml(options: {
  key: string;
  title: string;
  colorIndex: number | "unsorted";
  count: number;
  seconds: number;
  watchedPercent: number | null;
  next: string | null;
}): string {
  const rail = sectionRailVar(options.colorIndex);
  const unsorted = options.colorIndex === "unsorted";
  const watched = options.watchedPercent != null && options.watchedPercent >= 1 ? ` · ${Math.round(options.watchedPercent)}%` : "";
  const stat = options.count === 0 ? "empty" : `${options.count} · ${formatDurationWords(options.seconds)}${watched}`;
  const next = options.next && options.count > 1 ? `<div class="pile-next">next: ${escapeHtml(options.next)}</div>` : "";
  return `
    <button type="button" class="pile${unsorted ? " pile--unsorted" : ""}" data-section-wrapper="${escapeHtml(options.key)}" data-pile-jump="${escapeHtml(options.key)}" style="--section-rail: ${rail}">
      <div class="pile-line">
        <span class="pile-dot" aria-hidden="true"></span>
        <span class="pile-title${unsorted ? " text-text-secondary" : ""}">${escapeHtml(options.title)}</span>
        <span class="pile-leader" aria-hidden="true"></span>
        <span class="pile-stat">${stat}</span>
      </div>
      ${next}
    </button>
  `;
}

function renderPilesColumn(): void {
  const list = document.getElementById("piles-list");
  const block = document.getElementById("piles-block");
  if (!list || !block) return;
  block.classList.toggle("hidden", app.isReadingListView);
  if (app.isReadingListView) return;

  const cards: string[] = [];
  if (app.selectedSession) {
    const sections = orderedSections(app.selectedSession.sections);
    const tabs = filterSessionTabsForDisplay(app.selectedSession.tabs ?? []);
    const { blocks, unsorted } = partitionSessionTabsBySection(tabs, sections);
    for (const { section, tabs: sectionTabs } of blocks) {
      const sorted = sortSessionTabsForDisplay(sectionTabs);
      cards.push(pileCardHtml({
        key: section.id,
        title: section.name,
        colorIndex: section.colorIndex ?? 0,
        count: sectionTabs.length,
        seconds: sectionTabs.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0),
        watchedPercent: null,
        next: sorted[0]?.title ?? null,
      }));
    }
    if (sections.length > 0) {
      cards.push(pileCardHtml({
        key: "__unsorted",
        title: "Unsorted",
        colorIndex: "unsorted",
        count: unsorted.length,
        seconds: unsorted.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0),
        watchedPercent: null,
        next: null,
      }));
    }
  } else {
    const sections = orderedSections(app.liveTabSectionsState.sections);
    const videos = getLiveVideosForCurrentView();
    const { blocks, unsorted } = partitionLiveVideosBySection(videos, sections, app.liveTabSectionsState.assignments);
    for (const { section, videos: sectionVideos } of blocks) {
      const total = sectionVideos.reduce((sum, video) => sum + video.seconds, 0);
      const watched = sectionVideos.reduce((sum, video) => sum + (video.isLive ? 0 : Math.min(video.currentTime, video.seconds)), 0);
      const sorted = sortVideosForDisplay(sectionVideos);
      cards.push(pileCardHtml({
        key: section.id,
        title: section.name,
        colorIndex: section.colorIndex ?? 0,
        count: sectionVideos.length,
        seconds: total,
        watchedPercent: total > 0 ? (watched / total) * 100 : 0,
        next: sorted.find((video) => !video.audible)?.title ?? sorted[0]?.title ?? null,
      }));
    }
    if (sections.length > 0) {
      cards.push(pileCardHtml({
        key: "__unsorted",
        title: "Unsorted",
        colorIndex: "unsorted",
        count: unsorted.length,
        seconds: unsorted.reduce((sum, video) => sum + video.seconds, 0),
        watchedPercent: null,
        next: null,
      }));
    }
  }

  if (cards.length === 0) {
    cards.push(`
      <button type="button" class="pile pile--empty" data-pile-create="1">
        <span class="text-sm text-text-muted italic">No piles yet. Make one for grammar, podcasts, or a course.</span>
      </button>
    `);
  }

  const html = cards.join("");
  if (list.innerHTML !== html) list.innerHTML = html;
}

export function wireSidebarClicks() {
  document.getElementById("piles-list")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-pile-create]")) {
      openAddSectionModal();
      return;
    }
    const pile = target.closest<HTMLElement>("[data-pile-jump]");
    const key = pile?.dataset.pileJump;
    if (!key) return;
    const wrapper = Array.from(document.querySelectorAll<HTMLElement>("#tab-list [data-section-wrapper]")).find(
      (element) => element.getAttribute("data-section-wrapper") === key
    );
    wrapper?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.getElementById("saved-sessions-sidebar")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-empty-save-session]")) {
      document.getElementById("btn-save-session")?.click();
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-session-action]");
    if (!button) return;
    const card = button.closest<HTMLElement>("[data-session-id]");
    const sessionId = card?.dataset.sessionId;
    if (!card || !sessionId) return;
    event.stopPropagation();
    app.sidebarContextTarget = { type: "session", sessionId };
    const action = button.dataset.sessionAction;
    if (action === "restore") {
      document.getElementById("ctx-open-tabs")?.click();
    } else if (action === "add") {
      document.getElementById("ctx-add-to-session")?.click();
    } else if (action === "more") {
      const rect = button.getBoundingClientRect();
      card.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom + 4 }));
    }
  });

  document.body.addEventListener("click", async (event) => {
    const item = (event.target as HTMLElement).closest(".sidebar-item");
    if (!item) return;
    const type = item.getAttribute("data-sidebar-type");
    if (type === "practice") {
      app.isPracticeView = true;
      app.isTimeView = false;
      app.isSessionsView = false;
      app.isReadingListView = false;
      app.selectedSession = null;
      selectedSessionTabUrls.clear();
      selectedTabIds.clear();
      updateSelectionUI();
      render();
      return;
    }
    app.isPracticeView = false;
    if (type === "time") {
      app.isTimeView = true;
      app.isSessionsView = false;
      app.isReadingListView = false;
      app.selectedSession = null;
      selectedSessionTabUrls.clear();
      selectedTabIds.clear();
      updateSelectionUI();
      refreshSavedSessionsSidebar();
      render();
      return;
    }
    app.isTimeView = false;
    if (type === "sessions") {
      app.isSessionsView = true;
      app.isReadingListView = false;
      app.selectedSession = null;
      selectedSessionTabUrls.clear();
      selectedTabIds.clear();
      updateSelectionUI();
      refreshSavedSessionsSidebar();
      render();
      return;
    }
    app.isSessionsView = false;
    clearFacets();
    app.focusedRowKey = null;
    if (type === "all") {
      app.isReadingListView = false;
      app.selectedSession = null;
      selectedSessionTabUrls.clear();
      app.currentWindowId = "all";
      refreshSavedSessionsSidebar();
      render();
    } else if (type === "reading-list") {
      app.isReadingListView = true;
      app.selectedSession = null;
      selectedSessionTabUrls.clear();
      app.currentWindowId = "all";
      selectedTabIds.clear();
      updateSelectionUI();
      refreshSavedSessionsSidebar();
      render();
    } else if (type === "window") {
      app.isReadingListView = false;
      app.selectedSession = null;
      selectedSessionTabUrls.clear();
      const id = item.getAttribute("data-window-id");
      if (id) {
        app.currentWindowId = parseInt(id, 10);
        refreshSavedSessionsSidebar();
        render();
      }
    } else if (type === "session") {
      app.isReadingListView = false;
      const id = item.getAttribute("data-session-id");
      if (!id) return;
      const sessions = await getSavedSessions();
      const session = sessions.find((saved) => saved.id === id);
      if (session) {
        app.selectedSession = session;
        selectedSessionTabUrls.clear();
        refreshSavedSessionsSidebar();
        render();
      }
    }
  });

  document.body.addEventListener("contextmenu", (event) => {
    const item = (event.target as HTMLElement).closest(".sidebar-item");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const type = item.getAttribute("data-sidebar-type") as "all" | "window" | "session" | null;
    if (!type) return;
    const menu = document.getElementById("sidebar-context-menu");
    if (!menu) return;
    app.sidebarContextTarget = null;
    const groupSave = document.getElementById("ctx-group-save");
    const groupSession = document.getElementById("ctx-group-session");
    groupSave?.classList.add("hidden");
    groupSession?.classList.add("hidden");
    if (type === "all" || type === "window") {
      app.sidebarContextTarget = type === "all" ? { type: "all" } : { type: "window", windowId: parseInt(item.getAttribute("data-window-id") || "0", 10) };
      groupSave?.classList.remove("hidden");
    } else if (type === "session") {
      app.sidebarContextTarget = { type: "session", sessionId: item.getAttribute("data-session-id") || undefined };
      groupSession?.classList.remove("hidden");
      const addBtn = document.getElementById("ctx-add-to-session");
      const hasLiveTabs = app.allVideos.length > 0;
      addBtn?.classList.toggle("hidden", !hasLiveTabs);
      document.getElementById("ctx-divider-edit")?.classList.toggle("hidden", !hasLiveTabs);
      const pinLabel = document.getElementById("ctx-pin-label");
      const pinned = item.getAttribute("data-pinned") === "1";
      if (pinLabel) pinLabel.textContent = pinned ? "Unpin" : "Pin";
    }
    menu.classList.remove("hidden");
    positionFixedMenu(menu, event.clientX, event.clientY);
  });
}
