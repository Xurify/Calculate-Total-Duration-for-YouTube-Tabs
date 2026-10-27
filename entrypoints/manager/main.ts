import "./style.css";
import { initTheme, mountThemeControl, THEME_CONTROL_HTML } from "../../utils/theme";
import { PLAYBACK_RATE_KEY } from "../../utils/playbackRate";
import { isStoreUpdatedMessage } from "../../utils/store";
import { refreshPracticeBadge } from "./practice";
import { CHANNEL_AVATARS_KEY, loadChannelAvatars, type ChannelAvatars } from "../../utils/channelAvatars";
import { installDialogs, installTooltips } from "../../utils/controls";
import { loadLanguageOverrides } from "../../utils/languageOverrides";
import { app } from "./state";
import { channelLetterHtml } from "./avatars";
import { mountDeskSelects, wireDeskToolbar, wireViewControls } from "./desk-controls";
import { wirePileFacetMenu } from "./facets";
import { wireShortcutsDialog } from "./keyboard";
import { wireLanguageModal } from "./language-modal";
import { applyPlaybackRate } from "./playback";
import { loadReadingList } from "./reading-list";
import { render } from "./render";
import { wireSections } from "./sections";
import { wireSessionContextMenu } from "./session-menu";
import { refreshSavedSessionsSidebar } from "./sessions-sidebar";
import { wireSettings } from "./settings";
import { wireSidebarClicks } from "./sidebar";
import { wireCompactHeader } from "./compact-header";
import { wireStudyModal } from "./study-session";
import { wireTabList } from "./tab-list-events";
import { fetchTabs, handleStoreUpdated, scheduleFetchTabsFromEvents, scheduleProbeResultsToUi } from "./tabs";

initTheme();

const VISIBILITY_REFETCH_MS = 2000;
let lastVisibilityFetch = 0;

function setupListeners() {
  mountDeskSelects();
  wireDeskToolbar();
  wireLanguageModal();
  wirePileFacetMenu();
  wireStudyModal();
  wireSidebarClicks();
  wireCompactHeader();
  wireTabList();
  wireViewControls();
  wireSessionContextMenu();
  wireSections();
  wireShortcutsDialog();
  wireSettings();
}

document.addEventListener("DOMContentLoaded", () => {
  const appearanceControl = document.getElementById("appearance-control");
  if (appearanceControl) {
    appearanceControl.innerHTML = THEME_CONTROL_HTML;
    mountThemeControl(appearanceControl);
  }
  installTooltips();
  installDialogs();
  // Avatar URLs go stale when a channel changes its picture; error doesn't bubble, so listen in capture.
  document.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (img instanceof HTMLImageElement && img.classList.contains("channel-avatar")) img.outerHTML = channelLetterHtml(img.dataset.letter ?? "?", img.dataset.size);
    },
    true
  );
  void loadChannelAvatars().then((avatars) => {
    app.deskChannelAvatars = avatars;
    app.lastFacetRailHtml = "";
    app.lastTabListFingerprint = "";
    render();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CHANNEL_AVATARS_KEY]) return;
    app.deskChannelAvatars = (changes[CHANNEL_AVATARS_KEY].newValue ?? {}) as ChannelAvatars;
    if (app.isTimeView) return;
    app.lastFacetRailHtml = "";
    app.lastTabListFingerprint = "";
    render();
  });
  setupListeners();
  const urlParameters = new URLSearchParams(window.location.search);
  if (urlParameters.get("view") === "reading-list") {
    app.isReadingListView = true;
  }
  if (urlParameters.get("view") === "time") {
    app.isTimeView = true;
  }
  if (urlParameters.get("view") === "practice") {
    app.isPracticeView = true;
  }
  void refreshPracticeBadge();
  void loadReadingList();
  void loadLanguageOverrides().then((overrides) => {
    app.languageOverrides = overrides;
    app.lastFacetRailHtml = "";
    app.lastTabListFingerprint = "";
    render();
  });
  void refreshSavedSessionsSidebar().then(() => fetchTabs());
  void browser.storage.local.get(PLAYBACK_RATE_KEY).then((data) => applyPlaybackRate(data[PLAYBACK_RATE_KEY]));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[PLAYBACK_RATE_KEY]) applyPlaybackRate(changes[PLAYBACK_RATE_KEY].newValue);
  });

  browser.tabs.onRemoved.addListener(scheduleFetchTabsFromEvents);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) scheduleFetchTabsFromEvents();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastVisibilityFetch < VISIBILITY_REFETCH_MS) return;
    lastVisibilityFetch = Date.now();
    fetchTabs(true);
  });

  browser.runtime.onMessage.addListener((message) => {
    if (isStoreUpdatedMessage(message)) {
      handleStoreUpdated(message);
      return;
    }
    if (message.action === "tab-synced") {
      const video = app.allVideos.find((candidate) => candidate.id === message.tabId);
      if (video) {
        video.seconds = message.metadata.seconds;
        video.title = message.metadata.title;
        video.channelName = message.metadata.channelName;
        video.isLive = message.metadata.isLive || false;
        video.suspended = false;
        if (message.metadata.language !== undefined) video.language = message.metadata.language;
        if (message.metadata.languageName !== undefined) video.languageName = message.metadata.languageName;
        scheduleProbeResultsToUi();
      }
    }
  });
});
