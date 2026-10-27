import packageJson from "../../package.json";
import { VideoData } from "../../utils/storage";
import { formatTime, formatCompact, formatDurationWords } from "../../utils/format";
import { renderPracticePanel } from "./practice";
import { summarizeDuplicates } from "../../utils/sessions";
import { app } from "./state";
import { deskAvatarHtml } from "./avatars";
import { renderSessionGrid, renderSessionList, renderVideoGrid, renderVideoList } from "./cards";
import { saveDeskSnapshot } from "./desk-snapshot";
import { facetCrumbText, pruneStaleFacets, renderFacetCrumb, renderFacetRail, renderTimeBar } from "./facets";
import { tabListStructureFingerprint } from "./fingerprint";
import { applyRowFocus } from "./keyboard";
import { renderPlanner } from "./planner";
import { renderReadingListCard } from "./reading-list";
import { orderedSections, partitionLiveVideosBySection } from "./sections";
import { applyTabListCheckboxIndeterminateFromAttr, updateSelectionUI } from "./selection";
import { liveHeroTime, renderSidebar, setDeskHero, syncTopNavState } from "./sidebar";
import { sortSessionTabsForDisplay, sortVideosForDisplay, videoGroupKey } from "./sorting";
import { languageTagInnerHtml, plural } from "./time/html";
import { renderTimePanel, scheduleTimeRefresh } from "./time/panel";
import { showToast } from "./toast";
import {
  emptyListMessage,
  filterSessionTabsForDisplay,
  filterVideosForDisplay,
  formatViewStats,
  updateDuplicatesFilterButton,
} from "./view-filter";

let renderTimeout: ReturnType<typeof setTimeout> | null = null;

export function getLiveVideosForCurrentView(): VideoData[] {
  let baseVideos: VideoData[] = [];
  if (app.currentWindowId === "all") {
    baseVideos = app.allVideos;
  } else {
    const group = app.windowGroups.find((windowGroup) => windowGroup.id === app.currentWindowId);
    baseVideos = group ? group.tabs : [];
  }
  return filterVideosForDisplay(baseVideos);
}

export function updateCurrentViewStatsFromState(): void {
  if (app.selectedSession) return;
  const headerStats = document.getElementById("current-view-stats");
  if (!headerStats) return;
  const videosToShow = getLiveVideosForCurrentView();
  const duplicateSummary = summarizeDuplicates(app.scopeVideoIdCounts);
  const duration = videosToShow.reduce((accumulator, video) => accumulator + video.seconds, 0);
  headerStats.innerText = formatViewStats(videosToShow.length, duration, duplicateSummary);
  setDeskHero({
    kicker: facetCrumbText() || "On the desk",
    title: "",
    ...liveHeroTime(videosToShow),
  });
  renderTimeBar();
  renderPlanner();
}

export function updateTabListAggregateHeadersFromState(): void {
  if (app.selectedSession) return;
  const videosToShow = getLiveVideosForCurrentView();

  document.querySelectorAll("[data-section-wrapper]").forEach((wrapper) => {
    const sectionKey = wrapper.getAttribute("data-section-wrapper");
    if (!sectionKey) return;
    let sectionVideos: VideoData[] = [];
    if (sectionKey === "__unsorted") {
      const secs = orderedSections(app.liveTabSectionsState.sections);
      const { unsorted } = partitionLiveVideosBySection(
        videosToShow,
        secs,
        app.liveTabSectionsState.assignments
      );
      sectionVideos = unsorted;
    } else {
      const secs = orderedSections(app.liveTabSectionsState.sections);
      const section = secs.find((sec) => sec.id === sectionKey);
      if (!section) return;
      const { blocks } = partitionLiveVideosBySection(
        videosToShow,
        secs,
        app.liveTabSectionsState.assignments
      );
      sectionVideos = blocks.find((block) => block.section.id === sectionKey)?.videos ?? [];
    }
    const pills = wrapper.querySelectorAll(".session-stat-pill");
    if (pills.length >= 2) {
      pills[0]!.textContent = plural(sectionVideos.length, "video");
      pills[1]!.textContent = formatTime(sectionVideos.reduce((sum, video) => sum + video.seconds, 0));
    }
  });

  document.querySelectorAll(".aggregate-group-stats").forEach((statsEl) => {
    const groupName = (statsEl as HTMLElement).dataset.groupName;
    if (!groupName) return;
    const groupVideos = videosToShow.filter((video) => videoGroupKey(video) === groupName);
    const spans = statsEl.querySelectorAll("span");
    if (spans.length >= 3) {
      spans[0]!.textContent = plural(groupVideos.length, "video");
      spans[2]!.textContent = formatTime(groupVideos.reduce((accumulator, video) => accumulator + video.seconds, 0));
    }
  });
}

export function updateLiveTabListCardsFromState() {
  if (app.selectedSession) return;
  document.querySelectorAll("#tab-list [data-id]").forEach((card) => {
    const id = parseInt((card as HTMLElement).dataset.id || "0", 10);
    const video = app.allVideos.find((candidate) => candidate.id === id);
    if (!video) return;
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;

    const titleEl = card.querySelector(".manager-card-title");
    if (titleEl) {
      titleEl.textContent = video.title;
      (titleEl as HTMLElement).title = video.title;
    }
    const channelEl = card.querySelector(".manager-card-channel");
    if (channelEl && channelEl.textContent !== video.channelName) {
      channelEl.textContent = video.channelName;
      if (channelEl.previousElementSibling?.matches(".ui-avatar")) channelEl.previousElementSibling.remove();
      channelEl.insertAdjacentHTML("beforebegin", deskAvatarHtml(video.channelName));
    }

    const durEl = card.querySelector(".manager-card-duration");
    if (durEl) durEl.textContent = video.isLive ? "LIVE" : formatCompact(video.seconds);

    const progWrap = card.querySelector(".manager-card-progress-wrap") as HTMLElement | null;
    const progInner = card.querySelector(".manager-card-progress") as HTMLElement | null;
    if (progWrap && progInner) {
      if (video.isLive || video.seconds <= 0) {
        progWrap.style.opacity = "0";
        progInner.style.width = "0%";
      } else {
        progWrap.style.opacity = watchedPercent > 0 ? "1" : "0";
        progInner.style.width = `${watchedPercent}%`;
      }
    }

    const curEl = card.querySelector(".manager-card-time-current");
    const totEl = card.querySelector(".manager-card-time-total");
    const listBar = card.querySelector(".manager-card-list-progress") as HTMLElement | null;
    if (curEl && totEl) {
      curEl.textContent = formatCompact(video.currentTime);
      totEl.textContent = formatCompact(video.seconds);
      curEl.classList.toggle("text-text-primary", watchedPercent > 0);
      curEl.classList.toggle("text-text-muted", watchedPercent <= 0);
    }
    if (listBar) listBar.style.width = `${watchedPercent}%`;

    const languageLabel = video.languageName ? video.languageName.split("(")[0].trim() : "";
    const langEl = card.querySelector(".manager-card-language") as HTMLElement | null;
    if (langEl) {
      if (langEl.dataset.label !== languageLabel) {
        langEl.dataset.label = languageLabel;
        langEl.innerHTML = languageTagInnerHtml(languageLabel);
      }
      langEl.classList.toggle("hidden", !languageLabel);
    }
  });
}

function setTabListInnerHTML(container: HTMLElement, html: string): void {
  const prevTop = container.scrollTop;
  const prevLeft = container.scrollLeft;
  container.innerHTML = html;
  const applyScroll = () => {
    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.min(prevTop, maxTop);
    container.scrollLeft = prevLeft;
  };
  requestAnimationFrame(() => {
    applyScroll();
    requestAnimationFrame(applyScroll);
  });
}

function renderMain() {
  app.skippedTabListDom = false;
  app.tabListContainerInnerHtmlUpdated = false;
  const container = document.getElementById("tab-list");
  const headerTitle = document.getElementById("current-view-title");
  const headerStats = document.getElementById("current-view-stats");

  const btnSettings = document.getElementById("btn-settings");
  if (btnSettings) {
    if (app.isSettingsOpen) btnSettings.classList.add('text-accent', 'bg-surface-hover');
    else btnSettings.classList.remove('text-accent', 'bg-surface-hover');
  }

  const settingsModal = document.getElementById("settings-modal");
  if (settingsModal) {
    if (app.isSettingsOpen) {
      settingsModal.classList.remove("hidden", "fade-out");
      settingsModal.classList.add("flex", "items-center", "justify-center", "animate-in", "fade-in");
      if (!settingsModal.contains(document.activeElement)) (document.getElementById("close-settings") as HTMLElement | null)?.focus();
      const devVersion = document.getElementById("dev-version");
      if (devVersion) devVersion.textContent = `v${packageJson.version}`;
    } else {
      settingsModal.classList.add("hidden");
      settingsModal.classList.remove("flex", "items-center", "justify-center", "animate-in", "fade-in");
    }

    const btnQualityStd = document.getElementById("quality-standard");
    const btnQualityHigh = document.getElementById("quality-high");

    btnQualityStd?.setAttribute("aria-pressed", String(app.thumbnailQuality === "standard"));
    btnQualityHigh?.setAttribute("aria-pressed", String(app.thumbnailQuality !== "standard"));
  }
  const btnGroupNone = document.getElementById('view-list');
  const btnGroupChannel = document.getElementById('view-channel');
  const btnGroupLanguage = document.getElementById('view-language');

  if (btnGroupNone && btnGroupChannel && btnGroupLanguage) {
    [btnGroupNone, btnGroupChannel, btnGroupLanguage].forEach(btn => {
      btn.classList.remove('text-accent', 'bg-surface-hover');
      btn.classList.add('text-text-muted');
    });
    if (app.groupingMode === 'none') {
      btnGroupNone.classList.add('text-accent', 'bg-surface-hover');
      btnGroupNone.classList.remove('text-text-muted');
    } else if (app.groupingMode === 'channel') {
      btnGroupChannel.classList.add('text-accent', 'bg-surface-hover');
      btnGroupChannel.classList.remove('text-text-muted');
    } else if (app.groupingMode === 'language') {
      btnGroupLanguage.classList.add('text-accent', 'bg-surface-hover');
      btnGroupLanguage.classList.remove('text-text-muted');
    }
  }

  const btnLayoutList = document.getElementById('layout-list');
  const btnLayoutGrid = document.getElementById('layout-grid');

  if (btnLayoutList && btnLayoutGrid) {
    if (app.layoutMode === 'list') {
      btnLayoutList.classList.add('text-accent', 'bg-surface-hover');
      btnLayoutList.classList.remove('text-text-muted');
      btnLayoutGrid.classList.remove('text-accent', 'bg-surface-hover');
      btnLayoutGrid.classList.add('text-text-muted');
    } else {
      btnLayoutGrid.classList.add('text-accent', 'bg-surface-hover');
      btnLayoutGrid.classList.remove('text-text-muted');
      btnLayoutList.classList.remove('text-accent', 'bg-surface-hover');
      btnLayoutList.classList.add('text-text-muted');
    }
  }

  if (!container || !headerTitle || !headerStats) return;

  const enteringTime = app.isTimeView && !app.timeViewShown;
  app.timeViewShown = app.isTimeView;
  const viewToolbar = document.getElementById("view-toolbar");

  syncTopNavState();
  if (!app.isReadingListView && !app.isSessionsView && !app.isTimeView && !app.isPracticeView) pruneStaleFacets();
  renderFacetRail();
  renderTimeBar();
  renderFacetCrumb();
  renderPlanner();
  container.classList.toggle("hidden", app.isSessionsView || app.isTimeView || app.isPracticeView);

  const sessionsPanel = document.getElementById("sessions-panel");
  sessionsPanel?.classList.toggle("hidden", !app.isSessionsView);
  sessionsPanel?.classList.toggle("flex", app.isSessionsView);

  const timePanel = document.getElementById("time-panel");
  timePanel?.classList.toggle("hidden", !app.isTimeView);
  timePanel?.classList.toggle("flex", app.isTimeView);
  document.getElementById("time-bar-skeleton")?.classList.toggle("hidden", app.isTimeView || app.isPracticeView);

  const practicePanel = document.getElementById("practice-panel");
  practicePanel?.classList.toggle("hidden", !app.isPracticeView);
  practicePanel?.classList.toggle("flex", app.isPracticeView);

  if (app.isPracticeView && practicePanel) {
    if (viewToolbar) viewToolbar.classList.add("hidden");
    headerTitle.innerText = "in the speakers' own voices";
    headerStats.innerText = "";
    app.lastTabListFingerprint = "";
    void renderPracticePanel(practicePanel, {
      hero: setDeskHero,
      stats: (text) => {
        if (app.isPracticeView) headerStats.innerText = text;
      },
      toast: showToast,
    });
    return;
  }

  if (app.isTimeView) {
    if (!enteringTime) {
      scheduleTimeRefresh();
      return;
    }
    if (viewToolbar) viewToolbar.classList.add("hidden");
    headerTitle.innerText = "where the time went";
    headerStats.innerText = "";
    setDeskHero({ kicker: "Time", title: "", value: "…", suffix: "" });
    app.lastTabListFingerprint = "";
    void renderTimePanel();
    return;
  }

  if (app.isSessionsView) {
    if (viewToolbar) viewToolbar.classList.add("hidden");
    headerTitle.innerText = "sets of tabs kept for later";
    headerStats.innerText = "Open one to put it on the desk, or add today's tabs to it.";
    setDeskHero({
      kicker: "Saved sessions",
      title: "",
      value: String(app.savedSessionsCount),
      suffix: app.savedSessionsCount === 1 ? "session" : "sessions",
    });
    app.lastTabListFingerprint = "";
    return;
  }

  if (app.isReadingListView) {
    if (viewToolbar) viewToolbar.classList.add("hidden");
    headerTitle.innerText = "Chrome reading list";
    headerStats.innerText = "Articles and links you saved for later.";
    setDeskHero({
      kicker: "Reading list",
      title: "",
      value: String(app.readingListItems.length),
      suffix: app.readingListItems.length === 1 ? "unread article" : "unread articles",
    });

    const fingerprintReadingList = `reading-list:${app.readingListItems.length}:${app.readingListItems.map((item) => item.url).join("|")}`;
    if (fingerprintReadingList === app.lastTabListFingerprint) {
      app.skippedTabListDom = true;
      return;
    }

    if (app.readingListItems.length === 0) {
      app.tabListContainerInnerHtmlUpdated = true;
      setTabListInnerHTML(
        container,
        `<div class="flex flex-col items-center justify-center py-16 text-center text-text-muted px-4">
          <div class="w-12 h-12 rounded-xl bg-surface-elevated border border-border flex items-center justify-center mb-3 text-text-muted">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>
          </div>
          <p class="text-sm font-semibold text-text-primary">Your reading list is empty</p>
          <p class="text-xs text-text-muted max-w-sm mt-1 leading-relaxed">In Chrome, click the bookmark star and choose Add to reading list. Unread pages show up here, ready to sort into your study plan.</p>
        </div>`
      );
      app.lastTabListFingerprint = fingerprintReadingList;
      return;
    }

    const cardsHtml = app.readingListItems
      .map((item) => renderReadingListCard(item))
      .join("");

    app.tabListContainerInnerHtmlUpdated = true;
    setTabListInnerHTML(
      container,
      `<div class="space-y-2 pb-8 max-w-4xl">${cardsHtml}</div>`
    );
    app.lastTabListFingerprint = fingerprintReadingList;
    return;
  }

  if (app.selectedSession) {
    if (viewToolbar) viewToolbar.classList.remove("hidden");
    const session = app.selectedSession;
    const tabsToShow = filterSessionTabsForDisplay(session.tabs ?? []);
    const duplicateSummary = summarizeDuplicates(app.scopeVideoIdCounts);
    updateDuplicatesFilterButton(duplicateSummary);
    const totalSec = tabsToShow.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
    headerTitle.innerText = session.name;
    headerStats.innerText = formatViewStats(tabsToShow.length, totalSec, duplicateSummary);
    setDeskHero({ kicker: "Saved session", title: "", value: formatDurationWords(totalSec), suffix: "in total" });

    const fpSession = tabListStructureFingerprint();
    if (fpSession === app.lastTabListFingerprint) return;

    app.tabListContainerInnerHtmlUpdated = true;
    if (tabsToShow.length === 0) {
      setTabListInnerHTML(container, emptyListMessage());
    } else {
      const sorted = sortSessionTabsForDisplay(tabsToShow);
      setTabListInnerHTML(container, app.layoutMode === "grid" ? renderSessionGrid(sorted) : `<div class="queue-card">${renderSessionList(sorted)}</div>`);
    }
    applyRowFocus();
    app.lastTabListFingerprint = fpSession;
    return;
  }

  if (viewToolbar) viewToolbar.classList.remove("hidden");

  let baseVideos: VideoData[] = [];
  if (app.currentWindowId === 'all') {
    headerTitle.innerText = "All windows";
    baseVideos = app.allVideos;
  } else {
    const group = app.windowGroups.find(windowGroup => windowGroup.id === app.currentWindowId);
    if (group) {
      headerTitle.innerText = group.label;
      baseVideos = group.tabs;
    }
  }

  const videosToShow = filterVideosForDisplay(baseVideos);
  const duplicateSummary = summarizeDuplicates(app.scopeVideoIdCounts);
  updateDuplicatesFilterButton(duplicateSummary);
  const duration = videosToShow.reduce((accumulator, video) => accumulator + video.seconds, 0);
  headerStats.innerText = formatViewStats(videosToShow.length, duration, duplicateSummary);
  setDeskHero({
    kicker: facetCrumbText() || "On the desk",
    title: "",
    ...liveHeroTime(videosToShow),
  });

  const fpLive = tabListStructureFingerprint();
  if (fpLive === app.lastTabListFingerprint) {
    app.skippedTabListDom = true;
    return;
  }

  app.tabListContainerInnerHtmlUpdated = true;
  if (videosToShow.length === 0) {
    setTabListInnerHTML(container, emptyListMessage());
  } else {
    const sortedVideos = sortVideosForDisplay(videosToShow);
    setTabListInnerHTML(container, app.layoutMode === "grid" ? renderVideoGrid(sortedVideos) : `<div class="queue-card">${renderVideoList(sortedVideos)}</div>`);
  }
  renderPlanner();
  applyRowFocus();
  app.lastTabListFingerprint = fpLive;
  saveDeskSnapshot();
}

export function render() {
  if (renderTimeout != null) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => {
    renderTimeout = null;
    renderSidebar();
    renderMain();
    if (!app.selectedSession && app.skippedTabListDom) updateLiveTabListCardsFromState();
    updateSelectionUI();
    if (app.tabListContainerInnerHtmlUpdated) {
      setTimeout(() => applyTabListCheckboxIndeterminateFromAttr(), 0);
    }
  }, 0);
}
