import "./style.css";
import { initTheme, mountThemeControl, THEME_CONTROL_HTML } from "../../utils/theme";
import { closeAllCustomSelects, mountCustomSelect, type CustomSelectHandle } from "./custom-select";

initTheme();
import packageJson from "../../package.json";
import {
  VideoData,
  lookupCachedMetadata,
  savePrefs,
  normalizeYoutubeUrl,
  CachedMetadata,
  requestMetadataUpdate,
  clearCache,
  getSavedSessions,
  saveSession,
  replaceSession,
  mergeIntoSession,
  duplicateSession,
  exportSessionsJson,
  importSessionsJson,
  deleteSession,
  renameSession,
  setSessionPinned,
  updateSessionTabs,
  updateSessionSections,
  getLiveTabSections,
  setLiveTabSections,
  type SavedSessionTab,
  type SavedSession,
  type SessionSection,
  type LiveTabSectionsState,
} from "../../utils/storage";
import { PLAYBACK_RATE_KEY, formatPlaybackRate, parsePlaybackRate } from "../../utils/playbackRate";
import {
  applyStorePatch,
  fetchStoreState,
  isStoreUpdatedMessage,
  type StoreState,
} from "../../utils/store";
import { formatTime, formatCompact, formatDurationWords, formatOffset, formatShortDuration, parseTimeParam, getVideoIdFromUrl, normalizeText, isYoutubeWatchOrShortsUrl } from "../../utils/format";
import { dateKeyOf, pillarColor, type SiteRule, type TimeTrackingPrefs } from "../../utils/timeLog";
import { actionSelectOptions, formatMinutesWords, pillarChoices, pillarSelectOptions, pillarTitleOf, type TimeSummaryResponse } from "../../utils/timeUi";
import type { WatchSummary, WatchVideoRow } from "../../utils/watchLog";
import { isGoal, languageKey, MAX_LIMIT_MINUTES, ruleKey, type LanguageLimit, type LanguageLimitUsage } from "../../utils/languageLimits";
import { CALENDAR_WEEKS, type GoalStreaks } from "../../utils/goals";
import { CSV_COLUMNS, DEFAULT_CSV_COLUMNS, type CsvColumn } from "../../utils/watchCsv";
import { CHANNEL_AVATARS_KEY, loadChannelAvatars, type ChannelAvatars } from "../../utils/channelAvatars";
import { installTooltips, stepperHtml, wireCombobox, wireSteppers } from "../../utils/controls";
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  normalizeLanguageCode,
} from "../../utils/captionLanguage";
import { requestVideoLanguage } from "../../utils/languageRequest";
import {
  buildTabsFromVideos,
  countItemsByVideoId,
  duplicateCountForUrl,
  findSimilarSession,
  formatSavedAgo,
  sessionsOverlapScore,
  sessionTotalSeconds,
  suggestSessionName,
  summarizeDuplicates,
  videoIdFromTabUrl,
  type DuplicateSummary,
  type SaveSessionPayload,
} from "../../utils/sessions";
import { queryReadingList, removeReadingListItem, type ReadingListItem } from "../../utils/readingList";
import { emptyLanguageOverrides, languageOverrideFor, loadLanguageOverrides, saveLanguageOverrides, type LanguageOverride, type LanguageOverrides } from "../../utils/languageOverrides";

interface WindowGroup {
  id: number;
  tabs: VideoData[];
  duration: number;
  label: string;
}

let allVideos: VideoData[] = [];
let windowGroups: WindowGroup[] = [];
let currentWindowId: number | 'all' = 'all';
let selectedTabIds = new Set<number>();
let isReadingListView = false;
/** Top-nav "Saved sessions" view: lists sessions instead of the board. */
let isSessionsView = false;
let isTimeView = false;
let savedSessionsCount = 0;
let readingListItems: ReadingListItem[] = [];
let selectedPlaybackSpeed = 1.0;

let searchQuery = "";
let groupingMode: 'none' | 'channel' | 'language' = 'none';
let layoutMode: 'list' | 'grid' = 'list';
let thumbnailQuality: 'standard' | 'high' = 'high';
let isSettingsOpen = false;

let sortOption: string = 'started-first';
/** Tab + video ids whose spoken language was read from the page player response. */
const pageLanguageConfirmed = new Set<string>();

const SORT_SELECT_OPTIONS = [
  { value: "started-first", label: "Started first" },
  { value: "index-asc", label: "Tab order" },
  { value: "duration-desc", label: "Longest first" },
  { value: "duration-asc", label: "Shortest first" },
  { value: "title-asc", label: "Title A to Z" },
  { value: "channel-asc", label: "Channel A to Z" },
] as const;

let sortSelectHandle: CustomSelectHandle | null = null;
let restoreTargetSelect: CustomSelectHandle | null = null;
let saveSessionTargetSelect: CustomSelectHandle | null = null;
let showDuplicatesOnly = false;
/** Video-id counts for the current view scope (all windows, one window, or saved session). */
let scopeVideoIdCounts = new Map<string, number>();
let collapsedGroups = new Set<string>();
let renderTimeout: ReturnType<typeof setTimeout> | null = null;
let probeUiRaf: number | null = null;
let searchDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
const SEARCH_DEBOUNCE_MS = 200;

const VISIBILITY_REFETCH_MS = 2000;
let lastVisibilityFetch = 0;

let lastTabListFingerprint = "";
let skippedTabListDom = false;
let lastSidebarFingerprint = "";
/** True when `#tab-list` `innerHTML` was replaced this `renderMain()` pass (not when fingerprint short-circuits). */
let tabListContainerInnerHtmlUpdated = false;
let lastSelectionRowSyncSig = "";
let lastMoveToSectionPopoverSig = "";

let sidebarContextTarget: { type: "all" | "window" | "session"; windowId?: number; sessionId?: string } | null = null;

/** When set, main view shows this session's tab list instead of live windows. */
let selectedSession: SavedSession | null = null;
let sessionSidebarSearch = "";
let lastSavedSessionsFingerprint = "";
/** When viewing a saved session, URLs of tabs selected in the grid/list (for remove-from-session). */
let selectedSessionTabUrls = new Set<string>();

let liveTabSectionsState: LiveTabSectionsState = { sections: [], assignments: {} };

const SECTION_RAIL_VARS = [
  "var(--section-coral)",
  "var(--section-amber)",
  "var(--section-lime)",
  "var(--section-teal)",
  "var(--section-sky)",
  "var(--section-indigo)",
  "var(--section-violet)",
  "var(--section-rose)",
] as const;

const SECTION_PRESETS: { name: string; emoji: string; colorIndex: number }[] = [
  { name: "Music", emoji: "🎵", colorIndex: 6 },
  { name: "Work", emoji: "💼", colorIndex: 5 },
  { name: "Podcasts", emoji: "🎙️", colorIndex: 3 },
  { name: "Learning", emoji: "📚", colorIndex: 4 },
  { name: "Entertainment", emoji: "🎬", colorIndex: 1 },
  { name: "Favorites", emoji: "⭐", colorIndex: 7 },
  { name: "Gaming", emoji: "🎮", colorIndex: 2 },
  { name: "News", emoji: "📰", colorIndex: 0 },
];

const SECTION_COLLAPSE_PREFIX = "sec:";
const UNSORTED_COLLAPSE_KEY = `${SECTION_COLLAPSE_PREFIX}__unsorted`;

let tabSectionContextTarget: { mode: "session"; url: string } | { mode: "live"; tabId: number } | null = null;
let sectionHeaderContextTarget: { sectionId: string } | null = null;

const TAB_MANAGER_DRAG_MIME = "application/x-tab-manager";
let sectionDropHighlightEl: HTMLElement | null = null;

function clearSectionDropHighlight(): void {
  sectionDropHighlightEl?.classList.remove("section-drop-target--active");
  sectionDropHighlightEl = null;
}

function setSectionDropHighlight(zone: HTMLElement | null): void {
  if (sectionDropHighlightEl === zone) return;
  clearSectionDropHighlight();
  if (zone) {
    zone.classList.add("section-drop-target--active");
    sectionDropHighlightEl = zone;
  }
}

function parseTabManagerDrag(raw: string): { kind: "session"; url: string } | { kind: "live"; tabId: number } | null {
  try {
    const o = JSON.parse(raw) as { kind?: string; url?: string; tabId?: number };
    if (o.kind === "session" && typeof o.url === "string") return { kind: "session", url: o.url };
    if (o.kind === "live" && typeof o.tabId === "number") return { kind: "live", tabId: o.tabId };
  } catch {
    /* ignore */
  }
  return null;
}

let storeState: StoreState = {
  prefs: {
    sortByDuration: false,
    excludedUrls: [],
    thumbnailQuality: "high",
    layoutMode: "grid",
    groupingMode: "none",
    sortOption: "started-first",
  },
  metadataCache: {},
};

function applyPrefsFromStore(): void {
  const { prefs } = storeState;
  thumbnailQuality = prefs.thumbnailQuality;
  groupingMode = prefs.groupingMode;
  layoutMode = prefs.layoutMode;
  sortOption = prefs.sortOption;
  sortSelectHandle?.setValue(sortOption);
}

function applyStoreMetadataToVideos(): void {
  const { prefs, metadataCache } = storeState;
  allVideos.forEach((video) => {
    video.excluded = prefs.excludedUrls.includes(normalizeYoutubeUrl(video.url));
    const cached = lookupCachedMetadata(metadataCache, video.url);
    if (cached) applyCachedMetadataToVideo(video, cached);
  });
}

function handleStoreUpdated(message: { prefs?: StoreState["prefs"]; metadataCache?: StoreState["metadataCache"] }): void {
  applyStorePatch(storeState, message);
  if (message.prefs) applyPrefsFromStore();
  if (allVideos.length > 0 && (message.prefs || message.metadataCache)) {
    applyStoreMetadataToVideos();
    scheduleProbeResultsToUi();
  }
}

function titleFromTab(tab: Browser.tabs.Tab): string {
  const raw = tab.title?.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();
  return raw && raw !== "YouTube" ? raw : "YouTube Video";
}

function applyCachedMetadataToVideo(video: VideoData, cached: CachedMetadata): void {
  video.title = cached.title || video.title;
  video.channelName = cached.channelName || "";
  video.seconds = cached.seconds || 0;
  video.isLive = cached.isLive || false;
  video.language = cached.language;
  video.languageName = cached.languageName;
  video.chapters = cached.chapters;
}

const THUMBNAIL_CACHE_MAX = 60;
const thumbnailBlobCache = new Map<string, string>();

function getThumbnailSrc(videoId: string | null, quality: string): { src: string; cacheKey: string | null } {
  if (!videoId) return { src: "", cacheKey: null };
  const key = `${videoId}/${quality}`;
  const blobUrl = thumbnailBlobCache.get(key);
  if (blobUrl) return { src: blobUrl, cacheKey: null };
  const normalUrl = `https://i.ytimg.com/vi/${videoId}/${quality}`;
  return { src: normalUrl, cacheKey: key };
}

function thumbnailCacheBackfill(container: HTMLElement) {
  container.querySelectorAll<HTMLImageElement>("img[data-thumbnail-key]").forEach((img) => {
    const key = img.getAttribute("data-thumbnail-key");
    if (!key || thumbnailBlobCache.has(key)) return;
    const cacheFromSrc = () => {
      fetch(img.src)
        .then((response) => response.blob())
        .then((blob) => {
          const blobUrl = URL.createObjectURL(blob);
          while (thumbnailBlobCache.size >= THUMBNAIL_CACHE_MAX) {
            const oldest = thumbnailBlobCache.keys().next().value;
            if (oldest === undefined) break;
            const oldUrl = thumbnailBlobCache.get(oldest);
            if (oldUrl) URL.revokeObjectURL(oldUrl);
            thumbnailBlobCache.delete(oldest);
          }
          thumbnailBlobCache.set(key, blobUrl);
          img.removeAttribute("data-thumbnail-key");
        })
        .catch(() => {
          img.removeAttribute("data-thumbnail-key");
        });
    };
    if (img.complete && img.naturalWidth > 0) {
      cacheFromSrc();
    } else {
      const onLoad = () => {
        img.removeEventListener("load", onLoad);
        cacheFromSrc();
      };
      img.addEventListener("load", onLoad);
    }
  });
}

async function fetchTabs(skipInitialRender = false) {
  const tabIdsBefore = skipInitialRender
    ? allVideos
        .map((video) => video.id)
        .sort((a, b) => a - b)
        .join(",")
    : "";

  const [state, allTabs, sectionsState] = await Promise.all([
    fetchStoreState(),
    browser.tabs.query({}),
    getLiveTabSections(),
  ]);
  storeState = state;
  const { prefs, metadataCache: metadataRecord } = storeState;

  applyPrefsFromStore();
  liveTabSectionsState = sectionsState;

  const youtubeTabs = allTabs.filter(tab => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url)));

  const oldVideosMap = new Map<number, VideoData>();
  allVideos.forEach((video) => {
    if (video.id) oldVideosMap.set(video.id, video);
  });

  allVideos = youtubeTabs.map((tab, index) => {
    const url = tab.url!;
    const normalizedUrl = normalizeYoutubeUrl(url);
    const video: VideoData = {
      id: tab.id || 0,
      title: titleFromTab(tab),
      channelName: "",
      seconds: 0,
      currentTime: parseTimeParam(url),
      excluded: prefs.excludedUrls.includes(normalizedUrl),
      index,
      url,
      suspended: tab.discarded || false,
      active: tab.active,
      audible: tab.audible || false,
      isLive: false,
      windowId: tab.windowId,
    };

    const oldVideo = oldVideosMap.get(video.id);
    if (oldVideo && normalizeYoutubeUrl(oldVideo.url) === normalizedUrl) {
      video.title = oldVideo.title;
      video.channelName = oldVideo.channelName;
      video.seconds = oldVideo.seconds;
      video.currentTime = oldVideo.currentTime;
      video.isLive = oldVideo.isLive;
      video.language = oldVideo.language;
      video.languageName = oldVideo.languageName;
      video.videoId = oldVideo.videoId;
      video.audible = oldVideo.audible;
      video.paused = oldVideo.paused;
      video.chapters = oldVideo.chapters;
    } else {
      const cached = lookupCachedMetadata(metadataRecord, url);
      if (cached) applyCachedMetadataToVideo(video, cached);
    }
    return video;
  });

  const groups = new Map<number, VideoData[]>();
  allVideos.forEach(video => {
    const windowId = video.windowId;
    if (windowId === undefined) return;
    if (!groups.has(windowId)) groups.set(windowId, []);
    groups.get(windowId)!.push(video);
  });

  const windows = await browser.windows.getAll();
  windowGroups = windows
    .filter(window => groups.has(window.id!))
    .map((window, windowIndex) => {
      const tabs = groups.get(window.id!) || [];
      const duration = tabs.reduce((accumulator, video) => accumulator + video.seconds, 0);
      return {
        id: window.id!,
        tabs,
        duration,
        label: `Window ${windowIndex + 1}`
      };
    })
    .sort((a, b) => b.tabs.length - a.tabs.length);

  const tabIdsAfter = allVideos
    .map((video) => video.id)
    .sort((a, b) => a - b)
    .join(",");
  const tabsStructureChanged = skipInitialRender && tabIdsBefore !== tabIdsAfter;

  if (!skipInitialRender || tabsStructureChanged) render();
  await probeTabsMetadata();

  const tabsWithoutDuration = allVideos.filter((video) => (video.seconds === 0 && !video.isLive) || video.language === undefined);
  if (tabsWithoutDuration.length > 0 && Date.now() - lastSyncTime >= SYNC_COOLDOWN_MS) {
    lastSyncTime = Date.now();
    browser.runtime
      .sendMessage({
        action: "sync-all",
        tabs: tabsWithoutDuration.map((video) => ({ id: video.id, url: video.url })),
      })
      .catch(() => {});
  }
}

function recomputeWindowGroupDurations(): void {
  for (const group of windowGroups) {
    group.duration = group.tabs.reduce((accumulator, video) => accumulator + video.seconds, 0);
  }
}

function scheduleProbeResultsToUi(): void {
  if (probeUiRaf != null) return;
  probeUiRaf = requestAnimationFrame(() => {
    probeUiRaf = null;
    applyProbeResultsToUi();
  });
}

/** Coalesced metadata updates: patch cards in place; full rebuild only when layout structure changes. */
let deskChannelAvatars: ChannelAvatars = {};
const avatarRequested = new Set<string>();

/** Channels on the desk without an avatar yet get one looked up from one of their open videos. */
function requestMissingChannelAvatars(): void {
  const missing = new Map<string, string>();
  for (const video of allVideos) {
    const videoId = getVideoIdFromUrl(video.url);
    const name = video.channelName?.trim();
    if (!name || !videoId || deskChannelAvatars[name] || avatarRequested.has(name) || missing.has(name)) continue;
    missing.set(name, videoId);
  }
  if (missing.size === 0) return;
  for (const name of missing.keys()) avatarRequested.add(name);
  void browser.runtime
    .sendMessage({ action: "fill-channel-avatars", channels: [...missing].map(([channelName, videoId]) => ({ channelName, videoId })) })
    .catch(() => {});
}

function deskAvatarHtml(channelName: string | null | undefined, size = "w-4 h-4 text-[8px]"): string {
  const name = channelName?.trim();
  return name ? channelAvatarHtml(name, deskChannelAvatars[name] ?? null, size) : "";
}

function applyProbeResultsToUi(): void {
  recomputeWindowGroupDurations();
  requestMissingChannelAvatars();

  const nextStructureFp = tabListStructureFingerprint();
  if (!selectedSession && nextStructureFp !== lastTabListFingerprint) {
    render();
    return;
  }

  updateLiveTabListCardsFromState();
  updateTabListAggregateHeadersFromState();
  updateCurrentViewStatsFromState();
  // Languages and channels arrive with the metadata, so the facet counts change even when the list layout doesn't.
  renderFacetRail();
  renderSidebar();
  updateSelectionUI();
}

function hasValidCoreMetadata(video: VideoData): boolean {
  return (
    video.seconds > 0 &&
    video.title !== "YouTube Video" &&
    video.title !== "YouTube" &&
    !/^\(\d+\)\s*/.test(video.title)
  );
}

function languageMetadataChanged(
  video: VideoData,
  language: string | null | undefined,
  languageName: string | null | undefined
): boolean {
  if (language === undefined) return false;
  if (video.language == null && language == null) {
    return video.languageName !== languageName;
  }
  if (video.language == null || language == null) return true;
  if (normalizeLanguageCode(video.language) !== normalizeLanguageCode(language)) return true;
  return (video.languageName ?? "") !== (languageName ?? "");
}

function persistVideoMetadata(video: VideoData, expectedVideoId: string | null | undefined): void {
  requestMetadataUpdate(video.url, {
    seconds: video.seconds,
    title: video.title,
    channelName: video.channelName,
    currentTime: video.currentTime,
    isLive: video.isLive,
    videoId: expectedVideoId ?? undefined,
    language: video.language,
    languageName: video.languageName,
  });
}

function applyLanguageMetadata(
  video: VideoData,
  language: string | null | undefined,
  languageName: string | null | undefined,
  expectedVideoId: string | null | undefined
): boolean {
  if (language === undefined) return false;
  const changed = languageMetadataChanged(video, language, languageName);
  video.language = language;
  video.languageName = languageName;
  if (changed) persistVideoMetadata(video, expectedVideoId);
  return changed;
}

async function probeTabsMetadata() {
  const activeTabPromises = allVideos.map(async (video) => {
    if (video.suspended) return;

    const expectedVideoId = getVideoIdFromUrl(video.url);
    const hasCore = hasValidCoreMetadata(video);
    const pageLanguageKey = `${video.id}:${expectedVideoId ?? ""}`;
    const needPageLanguage = !pageLanguageConfirmed.has(pageLanguageKey);
    const skipHeavyProbe =
      hasCore && !needPageLanguage && !video.active && !video.audible;

    try {
      const contentMeta = await browser.tabs
        .sendMessage(video.id, { action: "get-metadata", refreshLanguage: true })
        .catch(() => null);

      if (contentMeta?.videoId != null && contentMeta.videoId === expectedVideoId) {
        applyLanguageMetadata(
          video,
          contentMeta.language,
          contentMeta.languageName,
          expectedVideoId
        );

        if (contentMeta.title && (contentMeta.seconds > 0 || contentMeta.isLive)) {
          const isPlaceholder = (title: string) =>
            !title || title === "YouTube Video" || title === "YouTube";
          video.title = isPlaceholder(contentMeta.title)
            ? video.title || contentMeta.title
            : contentMeta.title;
          video.channelName = contentMeta.channelName || "";
          video.seconds = contentMeta.seconds;
          video.currentTime = contentMeta.currentTime;
          video.isLive = contentMeta.isLive;
          persistVideoMetadata(video, expectedVideoId);
        }

        if (skipHeavyProbe) return;
      }
    } catch {
      // No content script — fall through to inject
    }

    if (skipHeavyProbe) return;

    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: video.id },
        world: "MAIN",
        args: [hasCore],
        func: (hasMetadata: boolean) => {
          const videoElement = document.querySelector("video");
          const currentTime = videoElement ? videoElement.currentTime : 0;

          const shortsMatch = window.location.pathname.match(/^\/shorts\/([^/?]+)/);
          const currentVideoId =
            new URLSearchParams(window.location.search).get("v") ||
            (shortsMatch ? shortsMatch[1] : null) ||
            null;

          // @ts-ignore - Get ytInitialPlayerResponse for SPA detection
          const playerResponse = window.ytInitialPlayerResponse;
          const playerVideoId = playerResponse?.videoDetails?.videoId;

          const isSpaTransition =
            playerVideoId && currentVideoId && playerVideoId !== currentVideoId;

          const readLanguageSource = () => {
            if (!playerResponse) return undefined;
            const micro = playerResponse?.microformat?.playerMicroformatRenderer;
            const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer;
            const mapFormats = (list: Array<{ audioTrack?: { id?: string; displayName?: string; audioIsDefault?: boolean; isAutoDubbed?: boolean } }> | undefined) =>
              (list || [])
                .filter((format) => format?.audioTrack?.id)
                .map((format) => ({
                  audioTrack: {
                    id: format.audioTrack?.id,
                    displayName: format.audioTrack?.displayName,
                    audioIsDefault: format.audioTrack?.audioIsDefault,
                    isAutoDubbed: format.audioTrack?.isAutoDubbed,
                  },
                }));

            return {
              videoDetails: {
                defaultAudioLanguageCode: playerResponse?.videoDetails?.defaultAudioLanguageCode,
                defaultLanguage: playerResponse?.videoDetails?.defaultLanguage,
                videoId: playerResponse?.videoDetails?.videoId as string | undefined,
                author: playerResponse?.videoDetails?.author as string | undefined,
                title: playerResponse?.videoDetails?.title as string | undefined,
                shortDescription: playerResponse?.videoDetails?.shortDescription as string | undefined,
              },
              uiLanguage: document.documentElement.lang,
              microformat: {
                playerMicroformatRenderer: {
                  defaultAudioLanguage: micro?.defaultAudioLanguage,
                  defaultLanguage: micro?.defaultLanguage,
                },
              },
              captions: renderer
                ? {
                    playerCaptionsTracklistRenderer: {
                      captionTracks: (renderer.captionTracks || []).map((track: {
                        kind?: string;
                        languageCode?: string;
                        name?: { simpleText?: string };
                      }) => ({
                        kind: track.kind,
                        languageCode: track.languageCode,
                        name: track.name?.simpleText ? { simpleText: track.name.simpleText } : undefined,
                      })),
                      audioTracks: (renderer.audioTracks || []).map((track: {
                        audioTrackId?: string;
                        defaultCaptionTrackIndex?: number;
                      }) => ({
                        audioTrackId: track.audioTrackId,
                        defaultCaptionTrackIndex: track.defaultCaptionTrackIndex,
                      })),
                      defaultAudioTrackIndex: renderer.defaultAudioTrackIndex,
                    },
                  }
                : undefined,
              streamingData: {
                formats: mapFormats(playerResponse?.streamingData?.formats),
                adaptiveFormats: mapFormats(playerResponse?.streamingData?.adaptiveFormats),
              },
            };
          };

          if (hasMetadata && !isSpaTransition) {
            return {
              currentTime,
              skipMetadata: true,
              languageSource: readLanguageSource(),
            };
          }

          if (isSpaTransition) {
            return {
              currentTime,
              spaTransition: true,
              currentVideoId,
              skipMetadata: false,
            };
          }

          const channel =
            (document.querySelector("#upload-info #channel-name a") as HTMLElement)?.innerText ||
            (document.querySelector(".ytd-video-owner-renderer #channel-name a") as HTMLElement)?.innerText ||
            "";

          let duration = 0;
          let isLive = false;
          let videoDetails = playerResponse?.videoDetails;

          try {
            if (videoDetails) {
              isLive = videoDetails.isLive === true;
              const liveDetails =
                playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
              if (liveDetails && !liveDetails.endTimestamp) isLive = true;

              const lengthSeconds = parseInt(videoDetails.lengthSeconds) || 0;
              if (lengthSeconds > 0) {
                isLive = false;
                duration = lengthSeconds;
              }
            }

            if (duration === 0 && window.location.pathname.startsWith("/shorts/")) {
              try {
                const sd = playerResponse && playerResponse.streamingData;
                const formats = sd && sd.formats;
                const adaptive = sd && sd.adaptiveFormats;
                const firstFormat = (formats && formats[0]) || (adaptive && adaptive[0]);
                const ms = firstFormat && firstFormat.approxDurationMs;
                if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
              } catch (_) {}
            }
            if (duration === 0 && window.location.pathname.startsWith("/shorts/")) {
              try {
                // @ts-ignore
                const initialData = window.ytInitialData;
                const ms =
                  initialData &&
                  initialData.contents &&
                  initialData.contents.reelWatchEndpoint &&
                  initialData.contents.reelWatchEndpoint.approxDurationMs;
                if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
              } catch (_) {}
            }

            if (!isLive) {
              const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
              if (
                liveBadge &&
                !liveBadge.hasAttribute("disabled") &&
                getComputedStyle(liveBadge).display !== "none"
              ) {
                isLive = true;
              }
            }

            let title =
              videoDetails?.title ||
              (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
              (document.querySelector("h1.title.ytd-video-primary-info-renderer") as HTMLElement)
                ?.innerText ||
              (document.querySelector(".ytd-video-primary-info-renderer h1") as HTMLElement)?.innerText ||
              (document.querySelector("ytd-video-primary-info-renderer #container h1") as HTMLElement)
                ?.innerText ||
              document.title;

            title = title.replace(/^\(\d+\)\s*/g, "");
            title = title.replace(" - YouTube", "").trim();

            return {
              duration: isLive ? 0 : duration || videoElement?.duration || 0,
              currentTime,
              channelName: channel || videoDetails?.author || "",
              title: title || "YouTube Video",
              isLive,
              skipMetadata: false,
              languageSource: readLanguageSource(),
              language: undefined as string | null | undefined,
              languageName: undefined as string | null | undefined,
            };
          } catch (error) {
            return {
              duration: videoElement?.duration || 0,
              currentTime,
              channelName: channel,
              title:
                document.title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim() ||
                "YouTube Video",
              isLive: false,
              skipMetadata: false,
              language: undefined as string | null | undefined,
              languageName: undefined as string | null | undefined,
            };
          }
        },
      });

      if (results[0]?.result) {
        const result = results[0].result;

        if (result.languageSource) {
          const sourceDetails = result.languageSource.videoDetails;
          const detected = await requestVideoLanguage(
            detectLanguageFromPlayerResponse(result.languageSource),
            languageTextFromPlayerResponse(result.languageSource),
            { channelName: sourceDetails?.author, videoId: sourceDetails?.videoId },
            result.languageSource.uiLanguage
          );
          result.language = detected.language;
          result.languageName = detected.languageName;
          const renderer = result.languageSource.captions?.playerCaptionsTracklistRenderer;
          const trackCount = renderer?.captionTracks?.length ?? 0;
          const formats = [
            ...(result.languageSource.streamingData?.formats ?? []),
            ...(result.languageSource.streamingData?.adaptiveFormats ?? []),
          ];
          const hasAudioHint =
            formats.some((format) => format.audioTrack?.id) ||
            typeof renderer?.defaultAudioTrackIndex === "number";
          if (detected.language || trackCount === 0 || hasAudioHint) {
            pageLanguageConfirmed.add(pageLanguageKey);
          }
        }

        if (result.spaTransition) {
          video.currentTime = result.currentTime || 0;
          const tryContentScript = async (): Promise<boolean> => {
            const meta = await browser.tabs
              .sendMessage(video.id, { action: "get-metadata", refreshLanguage: true })
              .catch(() => null);
            if (meta?.videoId === expectedVideoId && meta?.title && (meta.seconds > 0 || meta.isLive)) {
              video.title = meta.title;
              video.channelName = meta.channelName ?? "";
              video.seconds = meta.seconds;
              video.currentTime = meta.currentTime ?? 0;
              video.isLive = meta.isLive ?? false;
              applyLanguageMetadata(
                video,
                meta.language,
                meta.languageName,
                expectedVideoId
              );
              if (video.seconds > 0 || video.isLive) {
                persistVideoMetadata(video, expectedVideoId);
              }
              return true;
            }
            return false;
          };
          if (await tryContentScript()) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (await tryContentScript()) return;
          return;
        }

        if (result.skipMetadata) {
          video.currentTime = result.currentTime || 0;
          applyLanguageMetadata(
            video,
            result.language,
            result.languageName,
            expectedVideoId
          );
        } else {
          const duration = result.duration || 0;

          const hasValidTitle =
            result.title &&
            result.title !== "Loading..." &&
            result.title !== "YouTube Video" &&
            result.title !== "YouTube";
          if (hasValidTitle || duration > 0 || result.isLive) {
            video.title = hasValidTitle ? result.title : video.title || result.title;
            video.channelName = result.channelName || video.channelName;
            video.seconds = duration;
            video.currentTime = result.currentTime || 0;
            video.isLive = result.isLive || false;
            applyLanguageMetadata(
              video,
              result.language,
              result.languageName,
              expectedVideoId
            );

            if (duration > 0 || result.isLive) {
              persistVideoMetadata(video, expectedVideoId);
            }
          }
        }
      }
    } catch (error) {
      // Ignore errors (permissions, closed tabs, etc)
    }
  });

  await Promise.all(activeTabPromises);
  scheduleProbeResultsToUi();
}

const TAB_CREATE_BATCH = 8;
const TAB_CREATE_DELAY_MS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positionFixedMenu(menu: HTMLElement, clientX: number, clientY: number): void {
  menu.classList.remove("hidden");
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(clientX, window.innerWidth - rect.width - pad));
  const top = Math.max(pad, Math.min(clientY, window.innerHeight - rect.height - pad));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function renderSectionPickerRows(sections: ReturnType<typeof orderedSections>): string {
  const rows = sections.map((sec) => {
    const rail = sectionRailVar(sec.colorIndex ?? 0);
    return `
      <button type="button" role="menuitem" class="ctx-section-item" data-ctx-section-id="${escapeHtml(sec.id)}">
        <span class="w-1.5 h-4 rounded-full shrink-0" style="background:${rail}"></span>
        <span class="truncate">${sec.emoji ? `${escapeHtml(sec.emoji)} ` : ""}${escapeHtml(sec.name)}</span>
      </button>`;
  });
  rows.push(`<div class="ctx-menu-divider" role="separator"></div>`);
  rows.push(
    `<button type="button" role="menuitem" class="ctx-section-item ctx-section-item--muted" data-ctx-section-id="">✦ Unsorted</button>`
  );
  return rows.join("");
}

async function getOpenVideoIds(): Promise<Set<string>> {
  const tabs = await browser.tabs.query({});
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (!tab.url) continue;
    const id = videoIdFromTabUrl(tab.url);
    if (id) ids.add(id);
  }
  return ids;
}

async function createTabsBatched(urls: string[], windowId?: number): Promise<number> {
  let opened = 0;
  for (let i = 0; i < urls.length; i += TAB_CREATE_BATCH) {
    const batch = urls.slice(i, i + TAB_CREATE_BATCH);
    await Promise.all(
      batch.map((url) =>
        windowId != null ? browser.tabs.create({ windowId, url }) : browser.tabs.create({ url })
      )
    );
    opened += batch.length;
    if (i + TAB_CREATE_BATCH < urls.length) await sleep(TAB_CREATE_DELAY_MS);
  }
  return opened;
}

function filterUrlsMissingOnly(urls: string[], openIds: Set<string>): string[] {
  return urls.filter((url) => {
    const id = videoIdFromTabUrl(url);
    return id ? !openIds.has(id) : true;
  });
}

function duplicateBadgeHtml(url: string): string {
  const count = duplicateCountForUrl(scopeVideoIdCounts, url);
  if (count <= 1) return "";
  return `<span class="text-[10px] bg-warning/15 text-warning border border-warning/30 px-1.5 py-0.5 rounded-full font-bold shrink-0 tabular-nums" title="This video appears ${count} times in this view">×${count}</span>`;
}

function shouldShowWindowBadge(): boolean {
  return selectedSession == null && currentWindowId === "all" && windowGroups.length > 1;
}

function windowLabelForVideo(video: VideoData): string | null {
  if (!shouldShowWindowBadge() || video.windowId == null) return null;
  return windowGroups.find((group) => group.id === video.windowId)?.label ?? null;
}

function windowBadgeHtml(video: VideoData): string {
  const label = windowLabelForVideo(video);
  if (!label) return "";
  return `<span class="text-[10px] bg-surface-elevated border border-border text-text-secondary px-1.5 py-0.5 rounded-full font-medium shrink-0 tabular-nums" title="Open in ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}


function liveVideoStructurePart(video: VideoData): string {
  const groupKey =
    groupingMode === "channel" || groupingMode === "language" ? `|${videoGroupKey(video)}` : "";
  return `${video.id}|${video.windowId ?? ""}|${video.url}|${video.audible && !video.suspended ? 1 : 0}${groupKey}`;
}

function formatDuplicateStatsSuffix(summary: DuplicateSummary): string {
  if (summary.duplicateVideoCount === 0) return "";
  const videosLabel = summary.duplicateVideoCount === 1 ? "duplicate video" : "duplicate videos";
  const tabsLabel = summary.extraTabCount === 1 ? "extra tab" : "extra tabs";
  return ` · ${summary.duplicateVideoCount} ${videosLabel} (${summary.extraTabCount} ${tabsLabel})`;
}

function formatViewStats(count: number, durationSec: number, summary: DuplicateSummary): string {
  if (count === 0) return "";
  const dupSuffix = formatDuplicateStatsSuffix(summary);
  if (showDuplicatesOnly && summary.duplicateVideoCount > 0) {
    return `${count} duplicate tab${count === 1 ? "" : "s"} · ${formatTime(durationSec)} total duration`;
  }
  return `${count} video${count === 1 ? "" : "s"}${dupSuffix} · ${formatDurationWords(durationSec)} in total`;
}

function refreshScopeVideoIdCountsFromVideos(videos: VideoData[]): void {
  scopeVideoIdCounts = countItemsByVideoId(videos, (video) => video.url);
}

function refreshScopeVideoIdCountsFromSessionTabs(tabs: SavedSessionTab[]): void {
  scopeVideoIdCounts = countItemsByVideoId(tabs, (tab) => tab.url ?? "");
}

function filterVideosForDisplay(videos: VideoData[], options: { ignoreFacet?: boolean } = {}): VideoData[] {
  refreshScopeVideoIdCountsFromVideos(videos);
  let result = videos;
  if (!options.ignoreFacet && hasAnyFacet()) result = result.filter((video) => facetMatchesVideo(video));
  if (searchQuery) {
    const searchQueryNormalized = normalizeText(searchQuery);
    result = result.filter(
      (video) =>
        normalizeText(video.title).includes(searchQueryNormalized) ||
        normalizeText(video.channelName).includes(searchQueryNormalized)
    );
  }
  if (showDuplicatesOnly) {
    result = result.filter((video) => duplicateCountForUrl(scopeVideoIdCounts, video.url) > 1);
  }
  return result;
}

function filterSessionTabsForDisplay(tabs: SavedSessionTab[], options: { ignoreFacet?: boolean } = {}): SavedSessionTab[] {
  refreshScopeVideoIdCountsFromSessionTabs(tabs);
  let result = tabs;
  if (!options.ignoreFacet && hasAnyFacet()) {
    const sections = orderedSections(selectedSession?.sections);
    result = result.filter((tab) => facetMatchesSessionTab(tab, sections));
  }
  if (searchQuery) {
    const searchNormalized = normalizeText(searchQuery);
    result = result.filter(
      (tab) =>
        normalizeText(tab.title ?? "").includes(searchNormalized) ||
        normalizeText(tab.channelName ?? "").includes(searchNormalized)
    );
  }
  if (showDuplicatesOnly) {
    result = result.filter((tab) => duplicateCountForUrl(scopeVideoIdCounts, tab.url ?? "") > 1);
  }
  return result;
}

function updateDuplicatesFilterButton(summary: DuplicateSummary): void {
  const btn = document.getElementById("btn-filter-duplicates");
  const label = document.getElementById("btn-filter-duplicates-label");
  if (!btn || !label) return;

  const hasDuplicates = summary.duplicateVideoCount > 0;
  btn.classList.toggle("text-accent", showDuplicatesOnly);
  btn.classList.toggle("border-accent/40", showDuplicatesOnly);
  btn.classList.toggle("bg-accent/10", showDuplicatesOnly);
  btn.classList.toggle("text-text-muted", !showDuplicatesOnly);
  btn.classList.toggle("opacity-40", !hasDuplicates && !showDuplicatesOnly);
  btn.toggleAttribute("disabled", !hasDuplicates && !showDuplicatesOnly);

  label.textContent = hasDuplicates ? `Duplicates (${summary.duplicateVideoCount})` : "Duplicates";
  btn.title = hasDuplicates
    ? `${summary.duplicateVideoCount} video${summary.duplicateVideoCount === 1 ? "" : "s"} appear more than once (${summary.extraTabCount} extra tab${summary.extraTabCount === 1 ? "" : "s"}). Click to ${showDuplicatesOnly ? "show all" : "show duplicates only"}.`
    : "No duplicate videos in this view";
}

function emptyListMessage(): string {
  const query = searchQuery.trim();
  if (query) {
    return `
      <div class="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div class="font-display text-xl text-text-primary">Nothing matches “${escapeHtml(query)}”</div>
        <div class="text-sm text-text-muted mt-1 max-w-sm">Search looks at titles and channel names${facetCrumbText() ? ` in ${escapeHtml(facetCrumbText())}` : ""}.</div>
        <button type="button" data-empty-action="clear-search" class="chip mt-4">Clear search</button>
      </div>
    `;
  }
  if (showDuplicatesOnly) {
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

interface RestoreSessionOptions {
  target: "new" | "current";
  missingOnly: boolean;
  bySections: boolean;
}

async function restoreSession(session: SavedSession, options: RestoreSessionOptions): Promise<number> {
  const tabs = session.tabs ?? [];
  if (tabs.length === 0) return 0;

  const openIds = options.missingOnly ? await getOpenVideoIds() : null;

  if (options.bySections && orderedSections(session.sections).length > 0) {
    const secs = orderedSections(session.sections);
    const { blocks, unsorted } = partitionSessionTabsBySection(tabs, secs);
    const groups: SavedSessionTab[][] = blocks.map((b) => b.tabs);
    if (unsorted.length > 0) groups.push(unsorted);

    let opened = 0;
    for (const group of groups) {
      let urls = group.map((t) => normalizeYoutubeUrl(t.url)).filter((u) => u.length > 0);
      if (openIds) urls = filterUrlsMissingOnly(urls, openIds);
      if (urls.length === 0) continue;

      if (options.target === "current") {
        const currentWin = await browser.windows.getCurrent();
        opened += await createTabsBatched(urls, currentWin.id);
        continue;
      }

      const win = await browser.windows.create({ url: urls[0] });
      if (!win?.id) continue;
      opened += 1;
      if (urls.length > 1) opened += await createTabsBatched(urls.slice(1), win.id);
    }
    return opened;
  }

  let urls = tabs.map((t) => normalizeYoutubeUrl(t.url)).filter((u) => u.length > 0);
  if (openIds) urls = filterUrlsMissingOnly(urls, openIds);
  if (urls.length === 0) return 0;

  if (options.target === "current") {
    const currentWin = await browser.windows.getCurrent();
    return createTabsBatched(urls, currentWin.id);
  }

  const win = await browser.windows.create({ url: urls[0] });
  if (!win?.id) return 0;
  if (urls.length === 1) return 1;
  return 1 + (await createTabsBatched(urls.slice(1), win.id));
}

async function showRestoreSessionModal(session: SavedSession): Promise<RestoreSessionOptions | null> {
  closeAllCustomSelects();
  return new Promise((resolve) => {
    const modal = document.getElementById("restore-session-modal");
    const titleEl = document.getElementById("restore-session-title");
    const summaryEl = document.getElementById("restore-session-summary");
    const targetSelect = restoreTargetSelect;
    const missingOnly = document.getElementById("restore-missing-only") as HTMLInputElement;
    const bySections = document.getElementById("restore-by-sections") as HTMLInputElement;
    const cancelBtn = document.getElementById("restore-session-cancel");
    const confirmBtn = document.getElementById("restore-session-confirm");
    if (!modal || !targetSelect || !missingOnly || !bySections || !cancelBtn || !confirmBtn) {
      resolve(null);
      return;
    }
    if (titleEl) titleEl.textContent = `Open "${session.name}"`;
    const tabCount = session.tabs?.length ?? 0;
    const duration = formatTime(sessionTotalSeconds(session.tabs ?? []));
    if (summaryEl) summaryEl.textContent = `${tabCount} tabs · ${duration} total watch time`;
    const hasSections = orderedSections(session.sections).length > 0;
    bySections.disabled = !hasSections;
    bySections.checked = false;
    missingOnly.checked = false;
    targetSelect.setValue("new");

    const close = (result: RestoreSessionOptions | null) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      modal.removeEventListener("click", onBackdrop);
    };
    const onCancel = () => close(null);
    const onConfirm = () =>
      close({
        target: targetSelect.getValue() === "current" ? "current" : "new",
        missingOnly: missingOnly.checked,
        bySections: bySections.checked && hasSections,
      });
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "restore-session-modal") close(null);
    };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
  });
}

interface SaveSessionModalOptions {
  defaultName: string;
  tabCount: number;
  duplicateExtraTabs: number;
  sessions: SavedSession[];
  similarSession: SavedSession | null;
  similarScore: number;
}

async function showSaveSessionModal(options: SaveSessionModalOptions): Promise<SaveSessionPayload | null> {
  closeAllCustomSelects();
  return new Promise((resolve) => {
    const modal = document.getElementById("save-session-modal");
    const input = document.getElementById("save-session-input") as HTMLInputElement;
    const summaryEl = document.getElementById("save-session-summary");
    const targetSelect = saveSessionTargetSelect;
    const hintEl = document.getElementById("save-session-duplicate-hint");
    const cancelBtn = document.getElementById("save-session-cancel");
    const confirmBtn = document.getElementById("save-session-confirm");
    const modeInputs = modal?.querySelectorAll('input[name="save-session-mode"]') as NodeListOf<HTMLInputElement> | undefined;
    if (!modal || !input || !targetSelect || !cancelBtn || !confirmBtn || !modeInputs) {
      resolve(null);
      return;
    }

    input.value = options.defaultName;
    const summaryParts = [`Saving ${options.tabCount} tab${options.tabCount === 1 ? "" : "s"} from this view`];
    if (options.duplicateExtraTabs > 0) {
      summaryParts.push(
        `${options.duplicateExtraTabs} duplicate tab${options.duplicateExtraTabs === 1 ? "" : "s"} will be merged into one entry per video`
      );
    }
    if (summaryEl) summaryEl.textContent = summaryParts.join(" · ");

    targetSelect.setOptions(
      options.sessions.map((s) => ({
        value: s.id,
        label: `${s.name} (${s.tabs?.length ?? 0} tabs)`,
      }))
    );

    const syncTargetVisibility = () => {
      const mode = [...modeInputs].find((r) => r.checked)?.value ?? "new";
      const showTarget = mode === "replace" || mode === "merge";
      targetSelect.setHidden(!showTarget || options.sessions.length === 0);
      if (showTarget && options.similarSession) {
        targetSelect.setValue(options.similarSession.id);
      } else if (showTarget && options.sessions[0]) {
        targetSelect.setValue(options.sessions[0].id);
      }
    };

    if (options.similarSession && hintEl) {
      const pct = Math.round(options.similarScore * 100);
      hintEl.textContent = `${pct}% overlap with "${options.similarSession.name}". Consider replacing or merging instead of creating another copy.`;
      hintEl.classList.remove("hidden");
    } else if (hintEl) {
      hintEl.classList.add("hidden");
    }

    if (options.similarSession) {
      const replaceRadio = [...modeInputs].find((r) => r.value === "replace");
      if (replaceRadio) replaceRadio.checked = true;
      targetSelect.setValue(options.similarSession.id);
    } else {
      const newRadio = [...modeInputs].find((r) => r.value === "new");
      if (newRadio) newRadio.checked = true;
    }
    syncTargetVisibility();

    const close = (result: SaveSessionPayload | null) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      modeInputs.forEach((r) => r.removeEventListener("change", syncTargetVisibility));
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onKeydown);
    };
    const onCancel = () => close(null);
    const onConfirm = () => {
      const mode = ([...modeInputs].find((r) => r.checked)?.value ?? "new") as SaveSessionPayload["mode"];
      const name = input.value.trim() || options.defaultName;
      if ((mode === "replace" || mode === "merge") && !targetSelect.getValue()) {
        showToast("Choose a session to update.");
        return;
      }
      close({
        name,
        mode,
        targetSessionId: mode === "new" ? undefined : targetSelect.getValue(),
      });
    };
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "save-session-modal") close(null);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(null);
      if (event.key === "Enter") onConfirm();
    };
    modeInputs.forEach((r) => r.addEventListener("change", syncTargetVisibility));
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onKeydown);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
    requestAnimationFrame(() => input.focus());
  });
}

async function executeSaveSession(
  payload: SaveSessionPayload,
  tabs: SavedSessionTab[],
  sections: SessionSection[]
): Promise<void> {
  const secs = sections.length > 0 ? sections : undefined;
  if (payload.mode === "replace" && payload.targetSessionId) {
    const updated = await replaceSession(payload.targetSessionId, payload.name, tabs, secs);
    if (!updated) throw new Error("Session not found");
    showToast(`Updated "${payload.name}" (${tabs.length} tabs)`);
    return;
  }
  if (payload.mode === "merge" && payload.targetSessionId) {
    const merged = await mergeIntoSession(payload.targetSessionId, tabs, secs);
    if (!merged) throw new Error("Session not found");
    showToast(`Merged into "${merged.name}"`);
    return;
  }
  await saveSession(payload.name, tabs, secs);
  showToast(`Saved "${payload.name}" (${tabs.length} tabs)`);
}

async function saveVideosAsSession(videos: VideoData[], windowLabel?: string): Promise<void> {
  const liveSecs = orderedSections(liveTabSectionsState.sections);
  const { tabs, sections } = buildTabsFromVideos(
    videos,
    liveTabSectionsState.assignments,
    liveSecs,
    { excludeHidden: true }
  );
  if (tabs.length === 0) {
    showToast("No YouTube tabs to save.");
    return;
  }
  const sessions = await getSavedSessions();
  const similar = findSimilarSession(sessions, tabs);
  const similarScore = similar ? sessionsOverlapScore(tabs, similar.tabs ?? []) : 0;
  const includedVideos = videos.filter((video) => !video.excluded);
  const duplicateExtraTabs = summarizeDuplicates(countItemsByVideoId(includedVideos, (video) => video.url)).extraTabCount;
  const defaultName = suggestSessionName(tabs, windowLabel, sections);
  const payload = await showSaveSessionModal({
    defaultName,
    tabCount: tabs.length,
    duplicateExtraTabs,
    sessions,
    similarSession: similar,
    similarScore,
  });
  if (!payload) return;
  try {
    await executeSaveSession(payload, tabs, sections);
    lastSavedSessionsFingerprint = "";
    await refreshSavedSessionsSidebar();
  } catch (error) {
    console.error("Save session failed:", error);
    showToast(error instanceof Error ? error.message : "Could not save session.");
  }
}

async function loadSessionInNewWindow(sessionId: string) {
  const sessions = await getSavedSessions();
  const session = sessions.find((saved) => saved.id === sessionId);
  if (!session) return;
  const options = await showRestoreSessionModal(session);
  if (!options) return;
  try {
    const opened = await restoreSession(session, options);
    showToast(opened > 0 ? `Opened ${opened} tab${opened === 1 ? "" : "s"}` : "All tabs from this session are already open.");
  } catch (error) {
    console.error("Restore session failed:", error);
    showToast("Could not open session tabs.");
  }
}

function openSessionVideoInNewTab(url: string) {
  return browser.tabs.create({ url });
}

async function openOrFocusSessionVideo(url: string) {
  const normalizedTargetUrl = normalizeYoutubeUrl(url);
  const allTabs = await browser.tabs.query({});
  const existingTab = allTabs.find((tab) => {
    if (!tab.url) return false;
    return normalizeYoutubeUrl(tab.url) === normalizedTargetUrl;
  });

  if (existingTab?.id != null) {
    await browser.tabs.update(existingTab.id, { active: true });
    if (existingTab.windowId != null) {
      await browser.windows.update(existingTab.windowId, { focused: true });
    }
    return;
  }

  return browser.tabs.create({ url });
}

async function focusLiveVideoTab(video: VideoData) {
  await browser.tabs.update(video.id, { active: true });
  if (video.windowId != null) {
    await browser.windows.update(video.windowId, { focused: true });
  }
}

function sessionTabMatchesUrl(tab: SavedSessionTab, url: string): boolean {
  const a = videoIdFromTabUrl(tab.url ?? "");
  const b = videoIdFromTabUrl(url);
  if (a && b) return a === b;
  return (tab.url ?? "") === url;
}

function escapeHtml(raw: string): string {
  if (raw.length === 0) return raw;
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sectionRailVar(colorIndex: number | "unsorted"): string {
  if (colorIndex === "unsorted") return "var(--color-border)";
  return SECTION_RAIL_VARS[((colorIndex % SECTION_RAIL_VARS.length) + SECTION_RAIL_VARS.length) % SECTION_RAIL_VARS.length];
}

function tabCardDnDHtml(sectionColorIndex: number | "unsorted" | undefined): { extraClass: string; draggableAttr: string } {
  if (sectionColorIndex === undefined) return { extraClass: "", draggableAttr: "" };
  return { extraClass: " tab-card-dnd", draggableAttr: ` draggable="true"` };
}

function orderedSections(sections: SessionSection[] | undefined): SessionSection[] {
  if (!sections || sections.length === 0) return [];
  return [...sections].sort((a, b) => a.order - b.order);
}

function validSectionIds(sections: SessionSection[]): Set<string> {
  return new Set(sections.map((s) => s.id));
}

function liveSectionIdForVideo(video: VideoData): string | undefined {
  const sections = orderedSections(liveTabSectionsState.sections);
  const valid = validSectionIds(sections);
  const key = normalizeYoutubeUrl(video.url);
  const sid = liveTabSectionsState.assignments[key];
  if (typeof sid === "string" && valid.has(sid)) return sid;
  return undefined;
}

function sessionTabSectionId(tab: SavedSessionTab, sections: SessionSection[]): string | undefined {
  const valid = validSectionIds(sections);
  const sid = tab.sectionId;
  if (typeof sid === "string" && valid.has(sid)) return sid;
  return undefined;
}

function partitionSessionTabsBySection(
  tabs: SavedSessionTab[],
  sections: SessionSection[]
): { blocks: { section: SessionSection; tabs: SavedSessionTab[] }[]; unsorted: SavedSessionTab[] } {
  const ordered = orderedSections(sections);
  const byId = new Map<string, SavedSessionTab[]>();
  for (const s of ordered) byId.set(s.id, []);
  const unsorted: SavedSessionTab[] = [];
  for (const t of tabs) {
    const sid = sessionTabSectionId(t, ordered);
    if (sid && byId.has(sid)) byId.get(sid)!.push(t);
    else unsorted.push(t);
  }
  const blocks = ordered.map((section) => ({ section, tabs: byId.get(section.id) ?? [] }));
  return { blocks, unsorted };
}

function partitionLiveVideosBySection(
  videos: VideoData[],
  sections: SessionSection[],
  assignments: Record<string, string>
): { blocks: { section: SessionSection; videos: VideoData[] }[]; unsorted: VideoData[] } {
  const ordered = orderedSections(sections);
  const byId = new Map<string, VideoData[]>();
  for (const s of ordered) byId.set(s.id, []);
  const unsorted: VideoData[] = [];
  const valid = validSectionIds(ordered);
  for (const v of videos) {
    const key = normalizeYoutubeUrl(v.url);
    const sid = assignments[key];
    if (typeof sid === "string" && valid.has(sid) && byId.has(sid)) byId.get(sid)!.push(v);
    else unsorted.push(v);
  }
  const blocks = ordered.map((section) => ({ section, videos: byId.get(section.id) ?? [] }));
  return { blocks, unsorted };
}

function usesSectionLayoutForSession(session: SavedSession | null): boolean {
  if (!session) return false;
  return orderedSections(session.sections).length > 0;
}

function usesSectionLayoutForLive(): boolean {
  return orderedSections(liveTabSectionsState.sections).length > 0;
}

function persistLiveSections(): Promise<void> {
  return setLiveTabSections(liveTabSectionsState);
}

async function reloadSelectedSessionFromStorage(): Promise<void> {
  if (!selectedSession) return;
  const sessions = await getSavedSessions();
  const fresh = sessions.find((s) => s.id === selectedSession!.id);
  if (fresh) selectedSession = fresh;
}

async function moveSessionTabsToSection(urls: string[], sectionId: string | null): Promise<void> {
  if (!selectedSession || urls.length === 0) return;
  const sections = orderedSections(selectedSession.sections);
  const valid = validSectionIds(sections);
  const target = sectionId && valid.has(sectionId) ? sectionId : undefined;
  const tabs = (selectedSession.tabs ?? []).map((t) => {
    const u = t.url ?? "";
    if (!urls.includes(u)) return t;
    if (target) return { ...t, sectionId: target };
    return { url: t.url, title: t.title, channelName: t.channelName, seconds: t.seconds };
  });
  await updateSessionTabs(selectedSession.id, tabs);
  selectedSession.tabs = tabs;
  await reloadSelectedSessionFromStorage();
  selectedSessionTabUrls.clear();
  updateSelectionUI();
  render();
}

async function moveLiveVideosToSection(tabIds: number[], sectionId: string | null): Promise<void> {
  if (tabIds.length === 0) return;
  const sections = orderedSections(liveTabSectionsState.sections);
  const valid = validSectionIds(sections);
  const assign = { ...liveTabSectionsState.assignments };
  for (const id of tabIds) {
    const video = allVideos.find((v) => v.id === id);
    if (!video) continue;
    const key = normalizeYoutubeUrl(video.url);
    if (sectionId && valid.has(sectionId)) assign[key] = sectionId;
    else delete assign[key];
  }
  liveTabSectionsState = { ...liveTabSectionsState, assignments: assign };
  await persistLiveSections();
  selectedTabIds.clear();
  updateSelectionUI();
  render();
}

async function moveSelectionToSection(sectionId: string | null): Promise<void> {
  if (selectedSession) {
    await moveSessionTabsToSection(Array.from(selectedSessionTabUrls), sectionId);
  } else {
    await moveLiveVideosToSection(Array.from(selectedTabIds), sectionId);
  }
}

async function addNewSection(name: string, emoji: string | undefined, colorIndex: number): Promise<void> {
  const trimmed = name.trim() || "Section";
  if (selectedSession) {
    const list = orderedSections(selectedSession.sections);
    const sec = createSectionObject(trimmed, emoji, colorIndex, list);
    const next = [...list, sec];
    selectedSession.sections = next;
    await updateSessionSections(selectedSession.id, next);
    await reloadSelectedSessionFromStorage();
  } else {
    const list = orderedSections(liveTabSectionsState.sections);
    const sec = createSectionObject(trimmed, emoji, colorIndex, list);
    liveTabSectionsState = {
      sections: [...list, sec],
      assignments: { ...liveTabSectionsState.assignments },
    };
    await persistLiveSections();
  }
  showToast(`Section "${trimmed}" added`);
  render();
}

async function deleteSectionById(sectionId: string): Promise<void> {
  if (selectedSession) {
    const nextSecs = orderedSections(selectedSession.sections).filter((s) => s.id !== sectionId);
    await updateSessionSections(selectedSession.id, nextSecs);
    await reloadSelectedSessionFromStorage();
  } else {
    const nextSecs = liveTabSectionsState.sections.filter((s) => s.id !== sectionId);
    const assign = { ...liveTabSectionsState.assignments };
    for (const k of Object.keys(assign)) {
      if (assign[k] === sectionId) delete assign[k];
    }
    liveTabSectionsState = { sections: nextSecs, assignments: assign };
    await persistLiveSections();
  }
  render();
}

async function renameSectionById(sectionId: string, newName: string): Promise<void> {
  const name = newName.trim();
  if (!name) return;
  if (selectedSession) {
    const next = orderedSections(selectedSession.sections).map((s) => (s.id === sectionId ? { ...s, name } : s));
    await updateSessionSections(selectedSession.id, next);
    await reloadSelectedSessionFromStorage();
  } else {
    liveTabSectionsState = {
      ...liveTabSectionsState,
      sections: liveTabSectionsState.sections.map((s) => (s.id === sectionId ? { ...s, name } : s)),
    };
    await persistLiveSections();
  }
  render();
}

function openAddSectionModal(): void {
  const modal = document.getElementById("add-section-modal");
  const presets = document.getElementById("add-section-presets");
  const customInput = document.getElementById("add-section-custom") as HTMLInputElement | null;
  if (!modal || !presets) return;
  presets.innerHTML = SECTION_PRESETS.map(
    (p) => `
    <button type="button" class="section-preset-btn text-left" style="--preset-color: ${sectionRailVar(p.colorIndex)}" data-preset-name="${escapeHtml(p.name)}" data-preset-emoji="${escapeHtml(p.emoji)}" data-preset-color="${p.colorIndex}">
      <span class="text-lg leading-none">${escapeHtml(p.emoji)}</span>
      <span class="text-xs font-semibold text-text-primary">${escapeHtml(p.name)}</span>
    </button>
  `
  ).join("");
  if (customInput) customInput.value = "";
  modal.classList.remove("hidden");
  requestAnimationFrame(() => customInput?.focus());
}

function closeAddSectionModal(): void {
  document.getElementById("add-section-modal")?.classList.add("hidden");
}

function nextSectionOrder(sections: SessionSection[]): number {
  if (sections.length === 0) return 0;
  return Math.max(...sections.map((s) => s.order)) + 1;
}

function createSectionObject(name: string, emoji: string | undefined, colorIndex: number, sections: SessionSection[]): SessionSection {
  return {
    id: crypto.randomUUID(),
    name: name.trim() || "Section",
    emoji,
    colorIndex: colorIndex % SECTION_RAIL_VARS.length,
    order: nextSectionOrder(sections),
  };
}

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
      <button type="button" class="section-collapse-toggle p-1 rounded-md hover:bg-surface-hover/60 text-text-muted transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}" data-section-collapse="${escapeHtml(options.collapseKey)}" aria-expanded="${isCollapsed ? "false" : "true"}" aria-label="Collapse section">
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

function nestedChannelCollapseKey(scopeId: string, channel: string): string {
  return `sg:${scopeId}:${channel}`;
}

function renderSessionTabsInnerHtml(
  tabs: SavedSessionTab[],
  sectionColor: number | "unsorted",
  collapseScopeId: string
): string {
  if (tabs.length === 0) return "";
  if (groupingMode === "none") {
    const sorted = sortSessionTabsForDisplay(tabs);
    return layoutMode === "grid" ? renderSessionGrid(sorted, sectionColor) : renderSessionList(sorted, sectionColor);
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
        layoutMode === "grid" ? renderSessionGrid(sortedTabs, sectionColor) : renderSessionList(sortedTabs, sectionColor);
      return `
            <div class="mb-3">
              <div class="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface-hover/30 group/header select-none">
                <button type="button" class="p-1 rounded hover:bg-surface-hover text-text-muted transition-transform duration-200 nested-group-toggle ${isCollapsed ? "-rotate-90" : ""}" data-nested-group="${escapeHtml(ck)}">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
                <div class="flex-1 min-w-0 flex items-center gap-2 font-medium text-xs text-text-secondary nested-group-toggle cursor-pointer" data-nested-group="${escapeHtml(ck)}">${groupingMode === "channel" ? deskAvatarHtml(groupName, "w-5 h-5 text-[9px]") : ""}<span class="truncate">${escapeHtml(groupName)}</span></div>
                <div class="aggregate-group-stats text-[10px] text-text-muted tabular-nums flex items-center gap-2" data-group-name="${escapeHtml(groupName)}">
                  <span>${tabList.length} videos</span>
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
  if (groupingMode === "none") {
    const sortedVideos = sortVideosForDisplay(videos);
    return layoutMode === "grid" ? renderVideoGrid(sortedVideos, sectionColor) : renderVideoList(sortedVideos, sectionColor);
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
        layoutMode === "grid" ? renderVideoGrid(sortedGroupVideos, sectionColor) : renderVideoList(sortedGroupVideos, sectionColor);
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
                    <div class="flex-1 min-w-0 flex items-center gap-2 font-medium text-xs text-text-secondary nested-group-toggle cursor-pointer" data-nested-group="${escapeHtml(ck)}">${groupingMode === "channel" ? deskAvatarHtml(groupName, "w-5 h-5 text-[9px]") : ""}<span class="truncate">${escapeHtml(groupName)}</span></div>
                    <div class="aggregate-group-stats text-[10px] text-text-muted tabular-nums flex items-center gap-2" data-group-name="${escapeHtml(groupName)}">
                        <span>${groupVideos.length} videos</span>
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
      countLabel: `${tabs.length} videos`,
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
      countLabel: `${unsorted.length} videos`,
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

function applySectionCollapseDom(collapseKey: string, collapsed: boolean): void {
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

function applyNestedGroupCollapseDom(nestedKey: string, collapsed: boolean): void {
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

function applyFlatChannelGroupCollapseDom(channel: string, collapsed: boolean): void {
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
      countLabel: `${videos.length} videos`,
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
      countLabel: `${unsorted.length} videos`,
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

let toastTimeout: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string, durationMs = 3000) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden", "opacity-0");
  el.classList.add("animate-in", "fade-in");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    el.classList.add("opacity-0");
    toastTimeout = null;
  }, durationMs);
}

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmDanger?: boolean;
}

function showNameSessionModal(defaultName: string, heading = "Name this session"): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.getElementById("name-session-modal");
    const input = document.getElementById("name-session-input") as HTMLInputElement;
    const cancelBtn = document.getElementById("name-session-cancel");
    const saveBtn = document.getElementById("name-session-save");
    const titleEl = document.getElementById("name-session-title");
    if (!modal || !input || !cancelBtn || !saveBtn) {
      resolve(null);
      return;
    }
    if (titleEl) titleEl.textContent = heading;
    input.value = defaultName;
    input.select();
    const close = (result: string | null) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      saveBtn.removeEventListener("click", onSave);
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onKeydown);
    };
    const onCancel = () => close(null);
    const onSave = () => close((input.value?.trim() || defaultName));
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "name-session-modal") close(null);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(null);
      if (event.key === "Enter") onSave();
    };
    cancelBtn.addEventListener("click", onCancel);
    saveBtn.addEventListener("click", onSave);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onKeydown);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
    requestAnimationFrame(() => input.focus());
  });
}

function showConfirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const titleEl = document.getElementById("confirm-title");
    const messageEl = document.getElementById("confirm-message");
    const cancelBtn = document.getElementById("confirm-cancel");
    const okBtn = document.getElementById("confirm-ok");
    if (!modal || !titleEl || !messageEl || !cancelBtn || !okBtn) {
      resolve(false);
      return;
    }
    titleEl.textContent = options.title;
    messageEl.textContent = options.message;
    okBtn.textContent = options.confirmLabel ?? "OK";
    cancelBtn.textContent = options.cancelLabel ?? "Cancel";
    okBtn.classList.remove("bg-accent", "hover:bg-accent-hover", "bg-danger", "hover:bg-danger-hover");
    okBtn.classList.add("text-on-accent");
    if (options.confirmDanger) {
      okBtn.classList.add("bg-danger", "hover:bg-danger-hover");
    } else {
      okBtn.classList.add("bg-accent", "hover:bg-accent-hover");
    }
    const close = (result: boolean) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
      modal.removeEventListener("click", onBackdrop);
    };
    const onCancel = () => close(false);
    const onOk = () => close(true);
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "confirm-modal") close(false);
    };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
  });
}

function saveSettings(): void {
  void savePrefs({
    thumbnailQuality,
    layoutMode,
    groupingMode,
    sortOption,
  }).catch((error) => {
    console.warn("Failed to save settings:", error);
  });
}

async function loadReadingList(): Promise<void> {
  readingListItems = await queryReadingList(false);
  const badgeElement = document.getElementById("reading-list-badge");
  if (badgeElement) {
    badgeElement.textContent = String(readingListItems.length);
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

function renderReadingListCard(item: ReadingListItem): string {
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

function renderSidebar() {
  const container = document.getElementById("window-list-windows");
  if (!container) return;

  const totalDuration = allVideos.reduce((accumulator, video) => accumulator + video.seconds, 0);
  const totalTabs = allVideos.length;

  syncTopNavState();

  const fingerprint = [
    String(isReadingListView),
    String(selectedSession?.id ?? ""),
    String(currentWindowId),
    String(totalTabs),
    String(totalDuration),
    windowGroups.map((group) => `${group.id}:${group.label}:${group.duration}:${group.tabs.length}`).join("|"),
  ].join("\x1f");

  if (fingerprint === lastSidebarFingerprint) return;
  lastSidebarFingerprint = fingerprint;

  if (!isSessionsView) {
    document.getElementById("global-stats-count")!.textContent = `${totalTabs} videos · ${formatDurationWords(totalDuration)}`;
  }

  const liveView = !isReadingListView && selectedSession == null;
  const isAllActive = currentWindowId === 'all' && liveView;
  let html = `
    <button type="button" class="sidebar-item window-chip ${isAllActive ? "bg-surface-hover" : ""}" data-sidebar-type="all">All windows · ${totalTabs}</button>
  `;

  windowGroups.forEach((group) => {
    const isActive = currentWindowId === group.id && liveView;
    html += `
      <button type="button" class="sidebar-item window-chip ${isActive ? "bg-surface-hover" : ""}" data-sidebar-type="window" data-window-id="${group.id}" title="${formatDurationWords(group.duration)}">${escapeHtml(group.label)} · ${group.tabs.length}</button>
    `;
  });

  container.innerHTML = html;
}

function syncTopNavState(): void {
  const states: [string, boolean][] = [
    ["nav-desk", !isReadingListView && !isSessionsView && !isTimeView && selectedSession == null],
    ["nav-reading-list", isReadingListView],
    ["nav-sessions", isSessionsView || selectedSession != null],
    ["nav-time", isTimeView],
  ];
  for (const [id, active] of states) {
    const element = document.getElementById(id);
    element?.classList.toggle("bg-surface-hover", active);
    element?.classList.toggle("text-text-primary", active);
  }
  document.getElementById("windows-block")?.classList.toggle("hidden", isReadingListView || isSessionsView || isTimeView || selectedSession != null);
}

function setDeskHero(options: { kicker: string; title: string; value: string; suffix: string }): void {
  const kicker = document.getElementById("desk-kicker");
  const value = document.getElementById("desk-time-value");
  const suffix = document.getElementById("desk-time-suffix");
  if (kicker) kicker.textContent = options.kicker;
  if (value) value.textContent = options.value;
  if (suffix) suffix.textContent = options.suffix;
}

function liveHeroTime(videos: VideoData[]): { value: string; suffix: string } {
  if (videos.length === 0) return searchQuery.trim() ? { value: "No", suffix: "matches" } : { value: "No", suffix: "videos open" };
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
  block.classList.toggle("hidden", isReadingListView);
  if (isReadingListView) return;

  const cards: string[] = [];
  if (selectedSession) {
    const sections = orderedSections(selectedSession.sections);
    const tabs = filterSessionTabsForDisplay(selectedSession.tabs ?? []);
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
    const sections = orderedSections(liveTabSectionsState.sections);
    const videos = getLiveVideosForCurrentView();
    const { blocks, unsorted } = partitionLiveVideosBySection(videos, sections, liveTabSectionsState.assignments);
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

async function refreshSavedSessionsSidebar() {
  const sessions = await getSavedSessions();
  if (sessions.length !== savedSessionsCount) {
    savedSessionsCount = sessions.length;
    if (isSessionsView) render();
  }
  renderSessionsTotals(sessions);
  const query = normalizeText(sessionSidebarSearch.trim());
  const filtered = query
    ? sessions.filter((session) => normalizeText(session.name).includes(query))
    : sessions;

  const fp = [
    query,
    selectedSession?.id ?? "",
    filtered.map((session) => `${session.id}:${session.name}:${session.savedAt}:${session.tabs?.length ?? 0}:${session.pinned ? 1 : 0}`).join("|"),
  ].join("\x1f");
  if (fp === lastSavedSessionsFingerprint) return;
  lastSavedSessionsFingerprint = fp;

  const container = document.getElementById("saved-sessions-sidebar");
  if (!container) return;
  container.setAttribute("aria-busy", "false");

  const emptyMessage = (text: string) =>
    `<div class="px-3 py-2 text-xs text-text-muted">${text}</div>`;

  if (filtered.length === 0) {
    container.innerHTML = query
      ? emptyMessage(`No sessions match "${escapeHtml(query)}"`)
      : emptyMessage("Nothing saved yet. The save button in the top bar keeps today's tabs as a session.");
    return;
  }
  const isSelected = (sessionId: string) => selectedSession?.id === sessionId;
  container.innerHTML = filtered.map((savedSession) => sessionCardHtml(savedSession, isSelected(savedSession.id))).join("");
}

function renderSessionsTotals(sessions: SavedSession[]): void {
  const stats = document.getElementById("global-stats-count");
  if (!stats || !isSessionsView) return;
  const totalVideos = sessions.reduce((sum, session) => sum + (session.tabs?.length ?? 0), 0);
  const totalSeconds = sessions.reduce((sum, session) => sum + sessionTotalSeconds(session.tabs ?? []), 0);
  stats.textContent = `${sessions.length} ${sessions.length === 1 ? "session" : "sessions"} · ${totalVideos} videos · ${formatDurationWords(totalSeconds)} kept`;
}

const AUTO_SESSION_NAME = /^Session \d{1,2}\/\d{1,2}\/\d{2,4}, \d{1,2}:\d{2} (?:AM|PM)\s*(?:\((.+)\))?$/;

/** Auto-named sessions ("Session 10/15/26, 7:27 AM") read as what they hold instead of when they were saved. */
function sessionDisplayName(session: SavedSession): { title: string; custom: boolean } {
  const match = session.name.match(AUTO_SESSION_NAME);
  if (!match) return { title: session.name, custom: true };
  if (match[1]) return { title: match[1].trim(), custom: true };
  const languages = Array.from(tally(session.tabs ?? [], sessionTabLanguageLabel, (tab) => tab.seconds ?? 0).entries())
    .filter(([label]) => label !== UNKNOWN_LANGUAGE && label !== DETECTING_LANGUAGE)
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([label]) => label);
  if (languages.length === 0) return { title: "Mixed desk", custom: false };
  if (languages.length === 1) return { title: `${languages[0]} desk`, custom: false };
  return { title: `${languages[0]} & ${languages[1]} desk`, custom: false };
}

function sessionSavedLabel(savedAt: number): string {
  const date = new Date(savedAt);
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

function sessionLanguageBarHtml(tabs: SavedSessionTab[]): string {
  const languages = tally(tabs, sessionTabLanguageLabel, (tab) => tab.seconds ?? 0);
  assignLanguageColors(languages);
  const entries = Array.from(languages.entries())
    .filter(([, entry]) => entry.seconds > 0)
    .sort((a, b) => b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, entry]) => sum + entry.seconds, 0);
  if (total <= 0) return `<div class="session-langs text-text-muted">No durations yet</div>`;
  const bar = entries
    .map(([label, entry]) => `<span class="session-lang-seg" style="flex: ${Math.max(1, Math.round(entry.seconds))} 1 0px; background: ${languageColor(label)}" title="${escapeHtml(label)}: ${entry.count} videos, ${formatDurationWords(entry.seconds)}"></span>`)
    .join("");
  const shown = entries.slice(0, 3);
  const more = entries.length - shown.length;
  const legend = shown
    .map(([label, entry]) => `<span class="session-lang"><span class="facet-dot" style="background: ${languageColor(label)}"></span>${escapeHtml(label)} <span class="text-text-muted tabular-nums">${formatDurationWords(entry.seconds)}</span></span>`)
    .join("");
  return `
    <div class="session-lang-bar" aria-hidden="true">${bar}</div>
    <div class="session-langs">${legend}${more > 0 ? `<span class="text-text-muted">+${more} more</span>` : ""}</div>`;
}

const SESSION_THUMBS = 4;

function sessionThumbStripHtml(tabs: SavedSessionTab[]): string {
  const shown = tabs.slice(0, SESSION_THUMBS);
  if (shown.length === 0) return "";
  const more = tabs.length - shown.length;
  const cells = shown
    .map((tab, index) => {
      const { src } = getThumbnailSrc(getVideoIdFromUrl(tab.url), "mqdefault.jpg");
      const overlay = index === shown.length - 1 && more > 0 ? `<span class="session-thumb-more">+${more}</span>` : "";
      return `<span class="session-thumb">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async" draggable="false" />` : ""}${overlay}</span>`;
    })
    .join("");
  const filler = `<span class="session-thumb"></span>`.repeat(SESSION_THUMBS - shown.length);
  return `<div class="session-thumbs" aria-hidden="true">${cells}${filler}</div>`;
}

function sessionAvatarStackHtml(tabs: SavedSessionTab[]): string {
  const channels = Array.from(tally(tabs, (tab) => tab.channelName?.trim() || "", (tab) => tab.seconds ?? 0).entries())
    .filter(([name]) => name !== "")
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([name]) => name);
  if (channels.length === 0) return "";
  const shown = channels.slice(0, 4);
  return `<span class="session-avatars" title="${escapeHtml(channels.join(", "))}">${shown.map((name) => deskAvatarHtml(name, "w-5 h-5 text-[9px]")).join("")}</span>`;
}

function sessionCardHtml(session: SavedSession, active: boolean): string {
  const tabs = session.tabs ?? [];
  const { title, custom } = sessionDisplayName(session);
  const pileCount = orderedSections(session.sections).length;
  const pinIcon = `<svg class="shrink-0 w-3.5 h-3.5 text-accent" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
  return `
    <article class="session-card sidebar-item${active ? " session-card--active" : ""}" data-sidebar-type="session" data-session-id="${escapeHtml(session.id)}" data-pinned="${session.pinned ? "1" : "0"}" tabindex="0" role="button" aria-label="Open ${escapeHtml(title)} on the desk">
      ${sessionThumbStripHtml(tabs)}
      <div class="session-card-head">
        <h3 class="session-card-title${custom ? "" : " session-card-title--auto"}" title="${escapeHtml(session.name)}">${escapeHtml(title)}</h3>
        ${session.pinned ? pinIcon : ""}
        ${sessionAvatarStackHtml(tabs)}
      </div>
      <div class="session-card-sub">
        <span class="tabular-nums">${tabs.length} videos · ${formatDurationWords(sessionTotalSeconds(tabs))}</span>
        ${pileCount > 0 ? `<span>· ${pileCount} ${pileCount === 1 ? "pile" : "piles"}</span>` : ""}
        <span class="text-text-muted/80">· saved ${escapeHtml(sessionSavedLabel(session.savedAt))}</span>
      </div>
      ${sessionLanguageBarHtml(tabs)}
      <div class="session-card-actions">
        <button type="button" class="chip h-8" data-session-action="restore" title="Open these tabs in a window">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          Open tabs
        </button>
        <button type="button" class="chip h-8" data-session-action="add" title="Add today's open tabs to this session">+ Today's tabs</button>
        <span class="flex-1"></span>
        <button type="button" class="queue-action" data-session-action="more" title="Rename, pin, duplicate, delete" aria-label="More actions">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>
    </article>
  `;
}

function sortVideos(videos: VideoData[]): VideoData[] {
  return [...videos].sort((a, b) => {
    switch (sortOption) {
      case 'index-asc': return a.index - b.index;
      case 'started-first': {
        const started = (video: VideoData) => (!video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds ? 1 : 0);
        return started(b) - started(a) || a.index - b.index;
      }
      case 'duration-desc': return b.seconds - a.seconds;
      case 'duration-asc': return a.seconds - b.seconds;
      case 'title-asc': return a.title.localeCompare(b.title);
      case 'channel-asc': return a.channelName.localeCompare(b.channelName);
      default: return 0;
    }
  });
}

function videoGroupKey(video: VideoData): string {
  if (groupingMode === "channel") return video.channelName || "Unknown Channel";
  if (groupingMode === "language") {
    const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
    return stripped ? stripped : video.language ? video.language.toUpperCase() : "Unspecified";
  }
  return "";
}

function sessionTabGroupKey(tab: SavedSessionTab): string {
  if (groupingMode === "channel") return tab.channelName ?? "Unknown Channel";
  if (groupingMode === "language") {
    const stripped = tab.languageName ? tab.languageName.split("(")[0].trim() : "";
    return stripped ? stripped : tab.language ? tab.language.toUpperCase() : "Unspecified";
  }
  return "";
}

function sortVideosForDisplay(videos: VideoData[]): VideoData[] {
  return sortVideos(videos);
}

function sortSessionTabsForDisplay(tabs: SavedSessionTab[]): SavedSessionTab[] {
  if (sortOption === "index-asc") return tabs;
  return sortSessionTabs(tabs);
}

function orderLiveGroupEntries(groups: [string, VideoData[]][]): [string, VideoData[]][] {
  const entries = [...groups];
  if (sortOption === "channel-asc" || sortOption === "title-asc") {
    return entries.sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (sortOption === "duration-desc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      const durationB = b[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      return durationB - durationA;
    });
  }
  if (sortOption === "duration-asc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      const durationB = b[1].reduce((accumulator, video) => accumulator + video.seconds, 0);
      return durationA - durationB;
    });
  }
  return entries;
}

function orderSessionGroupEntries(groups: [string, SavedSessionTab[]][]): [string, SavedSessionTab[]][] {
  const entries = [...groups];
  if (sortOption === "channel-asc" || sortOption === "title-asc") {
    return entries.sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (sortOption === "duration-desc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationB - durationA;
    });
  }
  if (sortOption === "duration-asc") {
    return entries.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationA - durationB;
    });
  }
  return entries;
}

function getLiveVideosForCurrentView(): VideoData[] {
  let baseVideos: VideoData[] = [];
  if (currentWindowId === "all") {
    baseVideos = allVideos;
  } else {
    const group = windowGroups.find((windowGroup) => windowGroup.id === currentWindowId);
    baseVideos = group ? group.tabs : [];
  }
  return filterVideosForDisplay(baseVideos);
}

function updateCurrentViewStatsFromState(): void {
  if (selectedSession) return;
  const headerStats = document.getElementById("current-view-stats");
  if (!headerStats) return;
  const videosToShow = getLiveVideosForCurrentView();
  const duplicateSummary = summarizeDuplicates(scopeVideoIdCounts);
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

function updateTabListAggregateHeadersFromState(): void {
  if (selectedSession) return;
  const videosToShow = getLiveVideosForCurrentView();

  document.querySelectorAll("[data-section-wrapper]").forEach((wrapper) => {
    const sectionKey = wrapper.getAttribute("data-section-wrapper");
    if (!sectionKey) return;
    let sectionVideos: VideoData[] = [];
    if (sectionKey === "__unsorted") {
      const secs = orderedSections(liveTabSectionsState.sections);
      const { unsorted } = partitionLiveVideosBySection(
        videosToShow,
        secs,
        liveTabSectionsState.assignments
      );
      sectionVideos = unsorted;
    } else {
      const secs = orderedSections(liveTabSectionsState.sections);
      const section = secs.find((sec) => sec.id === sectionKey);
      if (!section) return;
      const { blocks } = partitionLiveVideosBySection(
        videosToShow,
        secs,
        liveTabSectionsState.assignments
      );
      sectionVideos = blocks.find((block) => block.section.id === sectionKey)?.videos ?? [];
    }
    const pills = wrapper.querySelectorAll(".session-stat-pill");
    if (pills.length >= 2) {
      pills[0]!.textContent = `${sectionVideos.length} videos`;
      pills[1]!.textContent = formatTime(sectionVideos.reduce((sum, video) => sum + video.seconds, 0));
    }
  });

  document.querySelectorAll(".aggregate-group-stats").forEach((statsEl) => {
    const groupName = (statsEl as HTMLElement).dataset.groupName;
    if (!groupName) return;
    const groupVideos = videosToShow.filter((video) => videoGroupKey(video) === groupName);
    const spans = statsEl.querySelectorAll("span");
    if (spans.length >= 3) {
      spans[0]!.textContent = `${groupVideos.length} videos`;
      spans[2]!.textContent = formatTime(groupVideos.reduce((accumulator, video) => accumulator + video.seconds, 0));
    }
  });
}

const SYNC_COOLDOWN_MS = 30_000;
let lastSyncTime = 0;

let fetchTabsFromEventsTimeout: ReturnType<typeof setTimeout> | null = null;
const FETCH_TABS_DEBOUNCE_MS = 400;

function scheduleFetchTabsFromEvents() {
  if (fetchTabsFromEventsTimeout != null) clearTimeout(fetchTabsFromEventsTimeout);
  fetchTabsFromEventsTimeout = setTimeout(() => {
    fetchTabsFromEventsTimeout = null;
    fetchTabs(true);
  }, FETCH_TABS_DEBOUNCE_MS);
}

function fingerprintSessionTabsInner(tabs: SavedSessionTab[], collapseScopeId: string): string {
  if (tabs.length === 0) return "";
  if (groupingMode === "channel" || groupingMode === "language") {
    const groups = new Map<string, SavedSessionTab[]>();
    tabs.forEach((tab) => {
      const name = sessionTabGroupKey(tab);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(tab);
    });
    return orderSessionGroupEntries(Array.from(groups.entries()))
      .map(([groupName, tabList]) => {
        const ck = nestedChannelCollapseKey(collapseScopeId, groupName);
        const collapsed = collapsedGroups.has(ck);
        const sortedTabs = sortSessionTabsForDisplay(tabList);
        const sig = sortedTabs
          .map((tab) => `${tab.url}|${tab.sectionId ?? ""}|${sessionTabGroupKey(tab)}`)
          .join(";");
        return `${ck}:${collapsed}:${sig}`;
      })
      .join("||");
  }
  return sortSessionTabsForDisplay(tabs)
    .map((tab) => `${tab.url}|${tab.sectionId ?? ""}`)
    .join(";");
}

function fingerprintLiveVideosInner(videos: VideoData[], collapseScopeId: string): string {
  if (videos.length === 0) return "";
  if (groupingMode === "channel" || groupingMode === "language") {
    const groups = new Map<string, VideoData[]>();
    videos.forEach((video) => {
      const name = videoGroupKey(video);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name)!.push(video);
    });
    return orderLiveGroupEntries(Array.from(groups.entries()))
      .map(([groupName, groupVideos]) => {
        const ck = nestedChannelCollapseKey(collapseScopeId, groupName);
        const collapsed = collapsedGroups.has(ck);
        const sortedGroupVideos = sortVideosForDisplay(groupVideos);
        const allSelected = groupVideos.every((video) => selectedTabIds.has(video.id));
        const someSelected = !allSelected && groupVideos.some((video) => selectedTabIds.has(video.id));
        const vidSig = sortedGroupVideos.map((video) => liveVideoStructurePart(video)).join(";");
        return `${ck}:${collapsed}:${allSelected}:${someSelected}:${vidSig}`;
      })
      .join("||");
  }
  return sortVideosForDisplay(videos)
    .map((video) => liveVideoStructurePart(video))
    .join(";");
}

function sessionSectionsFingerprintSig(session: SavedSession): string {
  return orderedSections(session.sections)
    .map((s) => `${s.id}:${s.name}:${s.order}:${s.emoji ?? ""}:${s.colorIndex ?? 0}`)
    .join("|");
}

function liveAssignmentsFingerprintSig(): string {
  const entries = Object.entries(liveTabSectionsState.assignments).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([url, sid]) => `${url}→${sid}`).join(";");
}

function tabListStructureFingerprint(): string {
  if (selectedSession) {
    const session = selectedSession;
    const tabsToShow = filterSessionTabsForDisplay(session.tabs ?? []);
    const state = [
      "session",
      session.id,
      session.name,
      String(tabsToShow.length),
      searchQuery,
      String(showDuplicatesOnly),
      groupingMode,
      layoutMode,
      sortOption,
      thumbnailQuality,
      [...collapsedGroups].sort().join(","),
      [...selectedSessionTabUrls].sort().join("|"),
      sessionSectionsFingerprintSig(session),
    ].join("\x1f");
    if (tabsToShow.length === 0 && !usesSectionLayoutForSession(session)) return `${state}\x1fempty`;
    if (usesSectionLayoutForSession(session)) {
      const secs = orderedSections(session.sections);
      const { blocks, unsorted } = partitionSessionTabsBySection(tabsToShow, secs);
      const parts: string[] = [];
      for (const { section, tabs } of blocks) {
        const ck = `${SECTION_COLLAPSE_PREFIX}${section.id}`;
        const collapsed = collapsedGroups.has(ck);
        parts.push(`${section.id}:${collapsed}:${fingerprintSessionTabsInner(tabs, section.id)}`);
      }
      const uCollapsed = collapsedGroups.has(UNSORTED_COLLAPSE_KEY);
      parts.push(`__unsorted:${uCollapsed}:${fingerprintSessionTabsInner(unsorted, "__unsorted")}`);
      return `${state}\x1fseclay:${layoutMode}:${parts.join("§")}`;
    }
    if (groupingMode === "channel" || groupingMode === "language") {
      const groups = new Map<string, SavedSessionTab[]>();
      tabsToShow.forEach((tab) => {
        const name = sessionTabGroupKey(tab);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name)!.push(tab);
      });
      const groupSig = orderSessionGroupEntries(Array.from(groups.entries()))
        .map(([groupName, tabList]) => {
          const collapsed = collapsedGroups.has(groupName);
          const sortedTabs = sortSessionTabsForDisplay(tabList);
          const sig = sortedTabs
            .map((tab) => `${tab.url}|${tab.sectionId ?? ""}|${sessionTabGroupKey(tab)}`)
            .join(";");
          return `${groupName}:${collapsed}:${sig}`;
        })
        .join("||");
      return `${state}\x1fcg:${groupSig}`;
    }
    const sorted = sortSessionTabsForDisplay(tabsToShow);
    const vidSig = sorted.map((tab) => `${tab.url}|${tab.sectionId ?? ""}`).join(";");
    return `${state}\x1fflat:${vidSig}`;
  }

  let baseVideos: VideoData[] = [];
  if (currentWindowId === "all") {
    baseVideos = allVideos;
  } else {
    const group = windowGroups.find((windowGroup) => windowGroup.id === currentWindowId);
    baseVideos = group ? group.tabs : [];
  }
  const videosToShow = filterVideosForDisplay(baseVideos);
  const state = [
    "live",
    String(currentWindowId),
    searchQuery,
    String(showDuplicatesOnly),
    groupingMode,
    layoutMode,
    sortOption,
    thumbnailQuality,
    [...collapsedGroups].sort().join(","),
    [...selectedTabIds].sort((a, b) => a - b).join(","),
    orderedSections(liveTabSectionsState.sections)
      .map((s) => `${s.id}:${s.name}:${s.order}:${s.emoji ?? ""}:${s.colorIndex ?? 0}`)
      .join("|"),
    liveAssignmentsFingerprintSig(),
    // Row offsets ("+21 min") and the plan badges come from durations, which arrive after the first render.
    videosToShow.map((video) => Math.round(video.seconds / 60)).join(","),
  ].join("\x1f");
  if (videosToShow.length === 0 && !usesSectionLayoutForLive()) return `${state}\x1fempty`;
  if (usesSectionLayoutForLive()) {
    const secs = orderedSections(liveTabSectionsState.sections);
    const { blocks, unsorted } = partitionLiveVideosBySection(
      videosToShow,
      secs,
      liveTabSectionsState.assignments
    );
    const parts: string[] = [];
    for (const { section, videos } of blocks) {
      const ck = `${SECTION_COLLAPSE_PREFIX}${section.id}`;
      const collapsed = collapsedGroups.has(ck);
      parts.push(`${section.id}:${collapsed}:${fingerprintLiveVideosInner(videos, section.id)}`);
    }
    const uCollapsed = collapsedGroups.has(UNSORTED_COLLAPSE_KEY);
    parts.push(`__unsorted:${uCollapsed}:${fingerprintLiveVideosInner(unsorted, "__unsorted")}`);
    return `${state}\x1flivesec:${layoutMode}:${parts.join("§")}`;
  }
  if (groupingMode === "none") {
    const sortedVideos = sortVideosForDisplay(videosToShow);
    const vidSig = sortedVideos.map((video) => liveVideoStructurePart(video)).join(";");
    return `${state}\x1fnone:${layoutMode}:${vidSig}`;
  }
  const groups = new Map<string, VideoData[]>();
  videosToShow.forEach((video) => {
    const name = videoGroupKey(video);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(video);
  });
  const groupSig = orderLiveGroupEntries(Array.from(groups.entries()))
    .map(([groupName, videos]) => {
      const collapsed = collapsedGroups.has(groupName);
      const sortedGroupVideos = sortVideosForDisplay(videos);
      const allSelected = videos.every((video) => selectedTabIds.has(video.id));
      const someSelected = !allSelected && videos.some((video) => selectedTabIds.has(video.id));
      const vidSig = sortedGroupVideos.map((video) => liveVideoStructurePart(video)).join(";");
      return `${groupName}:${collapsed}:${allSelected}:${someSelected}:${vidSig}`;
    })
    .join("||");
  return `${state}\x1fgrp:${layoutMode}:${groupSig}`;
}

function updateLiveTabListCardsFromState() {
  if (selectedSession) return;
  document.querySelectorAll("#tab-list [data-id]").forEach((card) => {
    const id = parseInt((card as HTMLElement).dataset.id || "0", 10);
    const video = allVideos.find((candidate) => candidate.id === id);
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
      if (languageLabel) {
        langEl.textContent = languageLabel;
        langEl.classList.remove("hidden");
      } else {
        langEl.textContent = "";
        langEl.classList.add("hidden");
      }
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
  skippedTabListDom = false;
  tabListContainerInnerHtmlUpdated = false;
  const container = document.getElementById("tab-list");
  const headerTitle = document.getElementById("current-view-title");
  const headerStats = document.getElementById("current-view-stats");

  const btnSettings = document.getElementById("btn-settings");
  if (btnSettings) {
    if (isSettingsOpen) btnSettings.classList.add('text-accent', 'bg-surface-hover');
    else btnSettings.classList.remove('text-accent', 'bg-surface-hover');
  }

  const settingsModal = document.getElementById("settings-modal");
  if (settingsModal) {
    if (isSettingsOpen) {
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

    btnQualityStd?.setAttribute("aria-pressed", String(thumbnailQuality === "standard"));
    btnQualityHigh?.setAttribute("aria-pressed", String(thumbnailQuality !== "standard"));
  }
  const btnGroupNone = document.getElementById('view-list');
  const btnGroupChannel = document.getElementById('view-channel');
  const btnGroupLanguage = document.getElementById('view-language');

  if (btnGroupNone && btnGroupChannel && btnGroupLanguage) {
    [btnGroupNone, btnGroupChannel, btnGroupLanguage].forEach(btn => {
      btn.classList.remove('text-accent', 'bg-surface-hover');
      btn.classList.add('text-text-muted');
    });
    if (groupingMode === 'none') {
      btnGroupNone.classList.add('text-accent', 'bg-surface-hover');
      btnGroupNone.classList.remove('text-text-muted');
    } else if (groupingMode === 'channel') {
      btnGroupChannel.classList.add('text-accent', 'bg-surface-hover');
      btnGroupChannel.classList.remove('text-text-muted');
    } else if (groupingMode === 'language') {
      btnGroupLanguage.classList.add('text-accent', 'bg-surface-hover');
      btnGroupLanguage.classList.remove('text-text-muted');
    }
  }

  const btnLayoutList = document.getElementById('layout-list');
  const btnLayoutGrid = document.getElementById('layout-grid');

  if (btnLayoutList && btnLayoutGrid) {
    if (layoutMode === 'list') {
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

  const viewToolbar = document.getElementById("view-toolbar");

  syncTopNavState();
  if (!isReadingListView && !isSessionsView && !isTimeView) pruneStaleFacets();
  renderFacetRail();
  renderTimeBar();
  renderFacetCrumb();
  renderPlanner();
  container.classList.toggle("hidden", isSessionsView || isTimeView);

  const sessionsPanel = document.getElementById("sessions-panel");
  sessionsPanel?.classList.toggle("hidden", !isSessionsView);
  sessionsPanel?.classList.toggle("flex", isSessionsView);

  const timePanel = document.getElementById("time-panel");
  timePanel?.classList.toggle("hidden", !isTimeView);
  timePanel?.classList.toggle("flex", isTimeView);
  document.getElementById("time-bar-skeleton")?.classList.toggle("hidden", isTimeView);

  if (isTimeView) {
    if (viewToolbar) viewToolbar.classList.add("hidden");
    headerTitle.innerText = "where the time went";
    headerStats.innerText = "";
    setDeskHero({ kicker: "Time", title: "", value: "…", suffix: "" });
    lastTabListFingerprint = "";
    void renderTimePanel();
    return;
  }

  if (isSessionsView) {
    if (viewToolbar) viewToolbar.classList.add("hidden");
    headerTitle.innerText = "sets of tabs kept for later";
    headerStats.innerText = "Open one to put it on the desk, or add today's tabs to it.";
    setDeskHero({
      kicker: "Saved sessions",
      title: "",
      value: String(savedSessionsCount),
      suffix: savedSessionsCount === 1 ? "session" : "sessions",
    });
    lastTabListFingerprint = "";
    return;
  }

  if (isReadingListView) {
    if (viewToolbar) viewToolbar.classList.add("hidden");
    headerTitle.innerText = "Chrome reading list";
    headerStats.innerText = "Articles and links you saved for later.";
    setDeskHero({
      kicker: "Reading list",
      title: "",
      value: String(readingListItems.length),
      suffix: readingListItems.length === 1 ? "unread article" : "unread articles",
    });

    const fingerprintReadingList = `reading-list:${readingListItems.length}:${readingListItems.map((item) => item.url).join("|")}`;
    if (fingerprintReadingList === lastTabListFingerprint) {
      skippedTabListDom = true;
      return;
    }

    if (readingListItems.length === 0) {
      tabListContainerInnerHtmlUpdated = true;
      setTabListInnerHTML(
        container,
        `<div class="flex flex-col items-center justify-center py-16 text-center text-text-muted px-4">
          <div class="w-12 h-12 rounded-xl bg-surface-elevated border border-border flex items-center justify-center mb-3 text-text-muted">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/><path d="M6 10h10"/></svg>
          </div>
          <p class="text-sm font-semibold text-text-primary">No unread reading list articles</p>
          <p class="text-xs text-text-muted max-w-sm mt-1 leading-relaxed">Articles and links saved to Chrome's Reading List appear here for study triage and queueing.</p>
        </div>`
      );
      lastTabListFingerprint = fingerprintReadingList;
      return;
    }

    const cardsHtml = readingListItems
      .map((item) => renderReadingListCard(item))
      .join("");

    tabListContainerInnerHtmlUpdated = true;
    setTabListInnerHTML(
      container,
      `<div class="space-y-2 pb-8 max-w-4xl">${cardsHtml}</div>`
    );
    lastTabListFingerprint = fingerprintReadingList;
    return;
  }

  if (selectedSession) {
    if (viewToolbar) viewToolbar.classList.remove("hidden");
    const session = selectedSession;
    const tabsToShow = filterSessionTabsForDisplay(session.tabs ?? []);
    const duplicateSummary = summarizeDuplicates(scopeVideoIdCounts);
    updateDuplicatesFilterButton(duplicateSummary);
    const totalSec = tabsToShow.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
    headerTitle.innerText = session.name;
    headerStats.innerText = formatViewStats(tabsToShow.length, totalSec, duplicateSummary);
    setDeskHero({ kicker: "Saved session", title: "", value: formatDurationWords(totalSec), suffix: "in total" });

    const fpSession = tabListStructureFingerprint();
    if (fpSession === lastTabListFingerprint) return;

    tabListContainerInnerHtmlUpdated = true;
    if (tabsToShow.length === 0) {
      setTabListInnerHTML(container, emptyListMessage());
    } else {
      const sorted = sortSessionTabsForDisplay(tabsToShow);
      setTabListInnerHTML(container, layoutMode === "grid" ? renderSessionGrid(sorted) : `<div class="queue-card">${renderSessionList(sorted)}</div>`);
      thumbnailCacheBackfill(container);
    }
    applyRowFocus();
    lastTabListFingerprint = fpSession;
    return;
  }

  if (viewToolbar) viewToolbar.classList.remove("hidden");

  let baseVideos: VideoData[] = [];
  if (currentWindowId === 'all') {
    headerTitle.innerText = "All windows";
    baseVideos = allVideos;
  } else {
    const group = windowGroups.find(windowGroup => windowGroup.id === currentWindowId);
    if (group) {
      headerTitle.innerText = group.label;
      baseVideos = group.tabs;
    }
  }

  const videosToShow = filterVideosForDisplay(baseVideos);
  const duplicateSummary = summarizeDuplicates(scopeVideoIdCounts);
  updateDuplicatesFilterButton(duplicateSummary);
  const duration = videosToShow.reduce((accumulator, video) => accumulator + video.seconds, 0);
  headerStats.innerText = formatViewStats(videosToShow.length, duration, duplicateSummary);
  setDeskHero({
    kicker: facetCrumbText() || "On the desk",
    title: "",
    ...liveHeroTime(videosToShow),
  });

  const fpLive = tabListStructureFingerprint();
  if (fpLive === lastTabListFingerprint) {
    skippedTabListDom = true;
    return;
  }

  tabListContainerInnerHtmlUpdated = true;
  if (videosToShow.length === 0) {
    setTabListInnerHTML(container, emptyListMessage());
  } else {
    const sortedVideos = sortVideosForDisplay(videosToShow);
    setTabListInnerHTML(container, layoutMode === "grid" ? renderVideoGrid(sortedVideos) : `<div class="queue-card">${renderVideoList(sortedVideos)}</div>`);
    thumbnailCacheBackfill(container);
  }
  renderPlanner();
  applyRowFocus();
  lastTabListFingerprint = fpLive;
  saveDeskSnapshot();
}

// ───────────────────────── Facets: the desk organises itself ─────────────────────────

type FacetKind = "all" | "continue" | "language" | "channel" | "pile";
/** One choice per group; all set groups must match. */
const facets: { language?: string; channel?: string; pile?: string; continue?: boolean } = {};

const UNKNOWN_LANGUAGE = "Unknown language";
const DETECTING_LANGUAGE = "Detecting…";
const FACET_PALETTE = SECTION_RAIL_VARS;
/** Language → palette slot, assigned by share of time so the biggest language keeps its colour as filters change. */
const languageColorSlots = new Map<string, number>();

let languageOverrides: LanguageOverrides = emptyLanguageOverrides();

function hasAnyFacet(): boolean {
  return Boolean(facets.language || facets.channel || facets.pile || facets.continue);
}

function clearFacets(): void {
  delete facets.language;
  delete facets.channel;
  delete facets.pile;
  delete facets.continue;
}

function languageLabelOf(languageName: string | null | undefined, code: string | null | undefined): string {
  const stripped = languageName ? languageName.split("(")[0].trim() : "";
  if (stripped) return stripped;
  if (code) return code.toUpperCase();
  return UNKNOWN_LANGUAGE;
}

function videoLanguageLabel(video: VideoData): string {
  const override = languageOverrideFor(languageOverrides, getVideoIdFromUrl(video.url), video.channelName);
  if (override) return override.name;
  if (video.language === undefined && !video.suspended) return DETECTING_LANGUAGE;
  return languageLabelOf(video.languageName, video.language);
}

function sessionTabLanguageLabel(tab: SavedSessionTab): string {
  const override = languageOverrideFor(languageOverrides, getVideoIdFromUrl(tab.url), tab.channelName);
  if (override) return override.name;
  return languageLabelOf(tab.languageName, tab.language);
}

function languageColor(label: string): string {
  if (label === UNKNOWN_LANGUAGE || label === DETECTING_LANGUAGE) return "var(--color-border-hover)";
  const slot = languageColorSlots.get(label);
  return slot == null ? "var(--color-border-hover)" : FACET_PALETTE[slot % FACET_PALETTE.length];
}

function toggleFacet(kind: FacetKind, value = ""): void {
  if (kind === "all") {
    clearFacets();
  } else if (kind === "continue") {
    facets.continue = facets.continue ? undefined : true;
  } else if (facets[kind] === value) {
    delete facets[kind];
  } else {
    facets[kind] = value;
  }
  lastTabListFingerprint = "";
  render();
}

function facetMatchesVideo(video: VideoData): boolean {
  if (facets.continue && !(!video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds)) return false;
  if (facets.language && videoLanguageLabel(video) !== facets.language) return false;
  if (facets.channel && (video.channelName || "Unknown channel") !== facets.channel) return false;
  if (facets.pile && (liveSectionIdForVideo(video) ?? "__unsorted") !== facets.pile) return false;
  return true;
}

function facetMatchesSessionTab(tab: SavedSessionTab, sections: SessionSection[]): boolean {
  if (facets.continue) return false;
  if (facets.language && sessionTabLanguageLabel(tab) !== facets.language) return false;
  if (facets.channel && (tab.channelName || "Unknown channel") !== facets.channel) return false;
  if (facets.pile && (sessionTabSectionId(tab, sections) ?? "__unsorted") !== facets.pile) return false;
  return true;
}

/** The speed the user last chose on YouTube; every "left" figure is in real time at that speed. */
let playbackRate = 1;

function applyPlaybackRate(value: unknown): void {
  const rate = parsePlaybackRate(value);
  if (rate === playbackRate) return;
  playbackRate = rate;
  lastFacetRailHtml = "";
  lastTabListFingerprint = "";
  render();
}

function leftSuffix(): string {
  return playbackRate === 1 ? "left" : `left at ${formatPlaybackRate(playbackRate)}`;
}

function remainingOf(video: VideoData): number {
  if (video.isLive || video.excluded) return 0;
  return Math.max(0, video.seconds - video.currentTime) / playbackRate;
}

interface FacetRow { kind: FacetKind; value: string; label: string; count: number; seconds: number; color?: string; sectionId?: string; muted?: boolean }

function tally<T>(items: T[], keyOf: (item: T) => string, secondsOf: (item: T) => number): Map<string, { count: number; seconds: number }> {
  const map = new Map<string, { count: number; seconds: number }>();
  for (const item of items) {
    const key = keyOf(item);
    const entry = map.get(key) ?? { count: 0, seconds: 0 };
    entry.count += 1;
    entry.seconds += secondsOf(item);
    map.set(key, entry);
  }
  return map;
}

function assignLanguageColors(languages: Map<string, { count: number; seconds: number }>): void {
  const ordered = Array.from(languages.entries())
    .filter(([label]) => label !== UNKNOWN_LANGUAGE && label !== DETECTING_LANGUAGE)
    .sort((a, b) => b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]));
  const stillPresent = new Set(ordered.map(([label]) => label));
  for (const label of Array.from(languageColorSlots.keys())) {
    if (!stillPresent.has(label)) languageColorSlots.delete(label);
  }
  const taken = new Set(languageColorSlots.values());
  for (const [label] of ordered) {
    if (languageColorSlots.has(label)) continue;
    let slot = 0;
    while (taken.has(slot)) slot += 1;
    languageColorSlots.set(label, slot);
    taken.add(slot);
  }
}

function languageRowsFrom(languages: Map<string, { count: number; seconds: number }>): FacetRow[] {
  assignLanguageColors(languages);
  return Array.from(languages.entries())
    .sort((a, b) => {
      const rank = (label: string) => (label === DETECTING_LANGUAGE ? 2 : label === UNKNOWN_LANGUAGE ? 1 : 0);
      return rank(a[0]) - rank(b[0]) || b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]);
    })
    .map(([label, entry]) => ({
      kind: "language",
      value: label,
      label,
      count: entry.count,
      seconds: entry.seconds,
      color: languageColor(label),
      muted: label === UNKNOWN_LANGUAGE || label === DETECTING_LANGUAGE,
    }));
}

function channelRowsFrom(channels: Map<string, { count: number; seconds: number }>): FacetRow[] {
  return Array.from(channels.entries())
    .sort((a, b) => b[1].count - a[1].count || b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([label, entry]) => ({ kind: "channel", value: label, label, count: entry.count, seconds: entry.seconds }));
}

function facetRowsForLive(videos: VideoData[]): { languages: FacetRow[]; channels: FacetRow[]; piles: FacetRow[]; continueRow: FacetRow } {
  const languageRows = languageRowsFrom(tally(videos, videoLanguageLabel, remainingOf));
  const channelRows = channelRowsFrom(tally(videos, (video) => video.channelName || "Unknown channel", remainingOf));

  const sections = orderedSections(liveTabSectionsState.sections);
  const { blocks, unsorted } = partitionLiveVideosBySection(videos, sections, liveTabSectionsState.assignments);
  const pileRows: FacetRow[] = blocks.map(({ section, videos: sectionVideos }) => ({
    kind: "pile",
    value: section.id,
    label: section.name,
    count: sectionVideos.length,
    seconds: sectionVideos.reduce((sum, video) => sum + remainingOf(video), 0),
    color: sectionRailVar(section.colorIndex ?? 0),
    sectionId: section.id,
  }));
  if (sections.length > 0) {
    pileRows.push({ kind: "pile", value: "__unsorted", label: "Not in a pile", count: unsorted.length, seconds: unsorted.reduce((sum, video) => sum + remainingOf(video), 0) });
  }

  const started = videos.filter((video) => !video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds);
  const continueRow: FacetRow = { kind: "continue", value: "", label: "Continue watching", count: started.length, seconds: started.reduce((sum, video) => sum + remainingOf(video), 0) };
  return { languages: languageRows, channels: channelRows, piles: pileRows, continueRow };
}

function facetRowsForSession(tabs: SavedSessionTab[], sections: SessionSection[]): { languages: FacetRow[]; channels: FacetRow[]; piles: FacetRow[] } {
  const seconds = (tab: SavedSessionTab) => tab.seconds ?? 0;
  const languageRows = languageRowsFrom(tally(tabs, sessionTabLanguageLabel, seconds));
  const channelRows = channelRowsFrom(tally(tabs, (tab) => tab.channelName || "Unknown channel", seconds));
  const { blocks, unsorted } = partitionSessionTabsBySection(tabs, sections);
  const pileRows: FacetRow[] = blocks.map(({ section, tabs: sectionTabs }) => ({
    kind: "pile",
    value: section.id,
    label: section.name,
    count: sectionTabs.length,
    seconds: sectionTabs.reduce((sum, tab) => sum + seconds(tab), 0),
    color: sectionRailVar(section.colorIndex ?? 0),
    sectionId: section.id,
  }));
  if (sections.length > 0) {
    pileRows.push({ kind: "pile", value: "__unsorted", label: "Not in a pile", count: unsorted.length, seconds: unsorted.reduce((sum, tab) => sum + seconds(tab), 0) });
  }
  return { languages: languageRows, channels: channelRows, piles: pileRows };
}

/** A filter whose value left the desk (last Slovak tab closed) clears itself instead of showing an empty list. */
function pruneStaleFacets(): void {
  if (selectedSession) {
    const base = filterSessionTabsForDisplay(selectedSession.tabs ?? [], { ignoreFacet: true });
    const sections = orderedSections(selectedSession.sections);
    if (facets.language && !base.some((tab) => sessionTabLanguageLabel(tab) === facets.language)) delete facets.language;
    if (facets.channel && !base.some((tab) => (tab.channelName || "Unknown channel") === facets.channel)) delete facets.channel;
    if (facets.pile && facets.pile !== "__unsorted" && !sections.some((section) => section.id === facets.pile)) delete facets.pile;
    if (facets.continue) delete facets.continue;
    return;
  }
  const base = filterVideosForDisplay(currentLiveBaseVideos(), { ignoreFacet: true });
  const sections = orderedSections(liveTabSectionsState.sections);
  if (facets.language && !base.some((video) => videoLanguageLabel(video) === facets.language)) delete facets.language;
  if (facets.channel && !base.some((video) => (video.channelName || "Unknown channel") === facets.channel)) delete facets.channel;
  if (facets.pile && facets.pile !== "__unsorted" && !sections.some((section) => section.id === facets.pile)) delete facets.pile;
  if (facets.pile === "__unsorted" && sections.length === 0) delete facets.pile;
  if (facets.continue && !base.some((video) => !video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds)) delete facets.continue;
}

function facetIsActive(row: FacetRow): boolean {
  switch (row.kind) {
    case "all": return !hasAnyFacet();
    case "continue": return Boolean(facets.continue);
    case "language": return facets.language === row.value;
    case "channel": return facets.channel === row.value;
    case "pile": return facets.pile === row.value;
  }
}

const FACET_ICONS: Record<string, string> = {
  all: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  continue: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8 5 4-5 4z" fill="currentColor"/></svg>`,
  channel: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
  unsorted: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>`,
  add: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
};

function facetIconHtml(row: FacetRow): string {
  if (row.kind === "channel" && deskChannelAvatars[row.value]) {
    return `<span class="facet-icon">${deskAvatarHtml(row.value)}</span>`;
  }
  if (row.kind === "language" || (row.kind === "pile" && row.value !== "__unsorted")) {
    return `<span class="facet-icon"><span class="facet-dot" style="background: ${row.color ?? "var(--color-border-hover)"}"></span></span>`;
  }
  const icon = row.kind === "pile" ? FACET_ICONS.unsorted : FACET_ICONS[row.kind] ?? "";
  return `<span class="facet-icon">${icon}</span>`;
}

function facetButtonHtml(row: FacetRow, extraAttrs = ""): string {
  const active = facetIsActive(row);
  const dot = facetIconHtml(row);
  const hasTime = row.count > 0 && row.seconds > 0;
  const timeWords = hasTime ? `, ${formatDurationWords(row.seconds)}${selectedSession == null ? " left to watch" : ""}` : "";
  const title = `${row.label}: ${row.count} ${row.count === 1 ? "video" : "videos"}${timeWords}`;
  return `
    <button type="button" class="facet${active ? " facet--active" : ""}${row.muted ? " facet--muted" : ""}" data-facet-kind="${row.kind}" data-facet-value="${escapeHtml(row.value)}"${extraAttrs} aria-pressed="${active}" title="${escapeHtml(title)}">
      ${dot}
      <span class="facet-name">${escapeHtml(row.label)}</span>
      <span class="facet-count" aria-label="${row.count} ${row.count === 1 ? "video" : "videos"}">${row.count}</span>
      <span class="facet-time">${hasTime ? formatShortDuration(row.seconds) : ""}</span>
    </button>`;
}

function facetGroupHtml(title: string, rows: FacetRow[], trailing = "", extraClass = ""): string {
  if (rows.length === 0 && !trailing) return "";
  return `
    <div class="facet-group${extraClass ? ` ${extraClass}` : ""}">
      <div class="facet-head">${escapeHtml(title)}</div>
      ${rows.map((row) => facetButtonHtml(row, row.sectionId || row.value === "__unsorted" ? ` data-section-wrapper="${escapeHtml(row.value)}"` : "")).join("")}
      ${trailing}
    </div>`;
}

function windowScopeHtml(): string {
  if (windowGroups.length <= 1) return "";
  const chip = (label: string, active: boolean, attrs: string) =>
    `<button type="button" class="scope-chip sidebar-item${active ? " scope-chip--active" : ""}" ${attrs}>${escapeHtml(label)}</button>`;
  return `
    <div class="scope-switch" role="group" aria-label="Which windows">
      ${chip("All windows", currentWindowId === "all", `data-sidebar-type="all"`)}
      ${windowGroups.map((group) => chip(`${group.label} · ${group.tabs.length}`, currentWindowId === group.id, `data-sidebar-type="window" data-window-id="${group.id}"`)).join("")}
    </div>`;
}

let lastFacetRailHtml = "";

function renderFacetRail(): void {
  const rail = document.getElementById("facet-rail");
  if (!rail) return;
  const live = !isReadingListView && !isSessionsView && !isTimeView && selectedSession == null;
  const session = selectedSession != null && !isSessionsView && !isReadingListView;
  rail.classList.toggle("hidden", !live && !session);
  if (!live && !session) return;

  const newPile = `<button type="button" class="facet facet--add" data-pile-create="1"><span class="facet-icon">${FACET_ICONS.add}</span><span class="facet-name">New pile…</span></button>`;
  let html = "";
  if (live) {
    const base = filterVideosForDisplay(currentLiveBaseVideos(), { ignoreFacet: true });
    const rows = facetRowsForLive(base);
    const allRow: FacetRow = { kind: "all", value: "", label: "Everything", count: base.length, seconds: base.reduce((sum, video) => sum + remainingOf(video), 0) };
    html += windowScopeHtml();
    html += `<div class="facet-group">${facetButtonHtml(allRow)}${rows.continueRow.count > 0 ? facetButtonHtml(rows.continueRow) : ""}</div>`;
    html += facetGroupHtml("Languages", rows.languages);
    html += facetGroupHtml("Channels", rows.channels);
    html += facetGroupHtml("Piles", rows.piles, newPile, "facet-group--piles");
  } else if (selectedSession) {
    const sections = orderedSections(selectedSession.sections);
    const base = filterSessionTabsForDisplay(selectedSession.tabs ?? [], { ignoreFacet: true });
    const rows = facetRowsForSession(base, sections);
    const allRow: FacetRow = { kind: "all", value: "", label: "Whole session", count: base.length, seconds: base.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0) };
    html += `<div class="facet-group">${facetButtonHtml(allRow)}</div>`;
    html += facetGroupHtml("Languages", rows.languages);
    html += facetGroupHtml("Channels", rows.channels);
    html += facetGroupHtml("Piles", rows.piles, newPile, "facet-group--piles");
  }
  if (html !== lastFacetRailHtml) {
    lastFacetRailHtml = html;
    rail.innerHTML = html;
  }
}

let deskSnapshotTimeout: ReturnType<typeof setTimeout> | null = null;

/** What public/desk-init.js paints on the next load, before any tab is read. Only the plain desk, unfiltered. */
function saveDeskSnapshot(): void {
  document.documentElement.classList.remove("desk-snapshot", "desk-loading");
  if (hasAnyFacet() || currentWindowId !== "all" || searchQuery) return;
  if (deskSnapshotTimeout != null) clearTimeout(deskSnapshotTimeout);
  deskSnapshotTimeout = setTimeout(writeDeskSnapshot, 1500);
}

function writeDeskSnapshot(): void {
  deskSnapshotTimeout = null;
  if (hasAnyFacet() || currentWindowId !== "all" || searchQuery || selectedSession || isReadingListView || isSessionsView || isTimeView) return;
  const html = (id: string) => document.getElementById(id)?.innerHTML ?? "";
  const text = (id: string) => document.getElementById(id)?.textContent ?? "";
  const visible = (id: string) => !document.getElementById(id)?.classList.contains("hidden");
  try {
    localStorage.setItem(
      "desk-snapshot",
      JSON.stringify({
        v: 2,
        list: html("tab-list"),
        rail: html("facet-rail"),
        timeBar: visible("time-bar") ? html("time-bar") : "",
        timeBarRest: visible("time-bar-rest") ? html("time-bar-rest") : "",
        kicker: text("desk-kicker"),
        title: text("current-view-title"),
        timeValue: text("desk-time-value"),
        timeSuffix: text("desk-time-suffix"),
        stats: text("current-view-stats"),
        planSummary: text("plan-summary"),
        planLabel: text("btn-start-plan-label"),
        plannerVisible: visible("planner"),
      })
    );
  } catch {
    // Storage may be full or blocked; the next load just starts empty.
  }
}

function currentLiveBaseVideos(): VideoData[] {
  if (currentWindowId === "all") return allVideos;
  return windowGroups.find((group) => group.id === currentWindowId)?.tabs ?? [];
}

function facetCrumbText(): string {
  const parts: string[] = [];
  if (facets.continue) parts.push("Continue watching");
  if (facets.language) parts.push(facets.language);
  if (facets.channel) parts.push(facets.channel);
  if (facets.pile) {
    if (facets.pile === "__unsorted") parts.push("Not in a pile");
    else {
      const sections = selectedSession ? orderedSections(selectedSession.sections) : orderedSections(liveTabSectionsState.sections);
      parts.push(sections.find((section) => section.id === facets.pile)?.name ?? "Pile");
    }
  }
  return parts.join(" · ");
}

function renderFacetCrumb(): void {
  const crumb = document.getElementById("facet-crumb");
  const clear = document.getElementById("facet-clear");
  const text = facetCrumbText();
  if (crumb) crumb.textContent = text;
  clear?.classList.toggle("hidden", text === "");
}

// ───────────────────────── Time bar: where the hours go ─────────────────────────

function renderTimeBar(): void {
  const bar = document.getElementById("time-bar");
  const rest = document.getElementById("time-bar-rest");
  if (!bar) return;
  const live = !isReadingListView && !isSessionsView && !isTimeView && selectedSession == null;
  const session = selectedSession != null && !isSessionsView && !isReadingListView;
  bar.classList.toggle("hidden", !live && !session);
  rest?.classList.toggle("hidden", !live && !session);
  if (!live && !session) return;

  let entries: { label: string; seconds: number; count: number }[];
  if (live) {
    const base = filterVideosForDisplay(currentLiveBaseVideos(), { ignoreFacet: true });
    const languages = tally(base, videoLanguageLabel, remainingOf);
    assignLanguageColors(languages);
    entries = Array.from(languages.entries()).map(([label, entry]) => ({ label, seconds: entry.seconds, count: entry.count }));
  } else {
    const base = filterSessionTabsForDisplay(selectedSession!.tabs ?? [], { ignoreFacet: true });
    const languages = tally(base, sessionTabLanguageLabel, (tab) => tab.seconds ?? 0);
    assignLanguageColors(languages);
    entries = Array.from(languages.entries()).map(([label, entry]) => ({ label, seconds: entry.seconds, count: entry.count }));
  }
  const rank = (label: string) => (label === DETECTING_LANGUAGE ? 2 : label === UNKNOWN_LANGUAGE ? 1 : 0);
  entries = entries.filter((entry) => entry.seconds > 0).sort((a, b) => rank(a.label) - rank(b.label) || b.seconds - a.seconds || a.label.localeCompare(b.label));
  const total = entries.reduce((sum, entry) => sum + entry.seconds, 0);
  if (total <= 0) {
    bar.innerHTML = "";
    bar.classList.add("hidden");
    if (rest) rest.classList.add("hidden");
    return;
  }
  const small: string[] = [];
  bar.innerHTML = entries
    .map((entry) => {
      const share = (entry.seconds / total) * 100;
      const active = facets.language === entry.label;
      const dimmed = Boolean(facets.language) && !active;
      const detecting = entry.label === DETECTING_LANGUAGE;
      const labelled = share >= 9;
      if (!labelled) small.push(`<button type="button" class="time-bar-rest-item" data-facet-kind="language" data-facet-value="${escapeHtml(entry.label)}"><span class="facet-dot" style="background: ${languageColor(entry.label)}"></span>${escapeHtml(entry.label)} <span class="tabular-nums">${formatDurationWords(entry.seconds)}</span></button>`);
      const label = labelled ? `<span class="time-bar-label">${escapeHtml(entry.label)} <span class="time-bar-time">${formatDurationWords(entry.seconds)}</span></span>` : "";
      return `<button type="button" class="time-bar-seg${active ? " time-bar-seg--active" : ""}${dimmed ? " time-bar-seg--dim" : ""}${detecting ? " time-bar-seg--detecting" : ""}" style="flex: ${Math.max(1, Math.round(entry.seconds))} 1 0px; background: ${languageColor(entry.label)}" data-facet-kind="language" data-facet-value="${escapeHtml(entry.label)}" title="${escapeHtml(entry.label)}: ${entry.count} ${entry.count === 1 ? "video" : "videos"}, ${formatDurationWords(entry.seconds)} ${live ? "left" : "in total"}">${label}</button>`;
    })
    .join("");
  if (rest) {
    rest.innerHTML = small.length > 0 ? `<span class="text-text-muted">Also</span> ${small.join("")}` : "";
    rest.classList.toggle("hidden", small.length === 0);
  }
}

// ───────────────────────── Session planner ─────────────────────────

let planBudgetMinutes: number | null = 45;
let plannedTabIds = new Set<number>();
/** Plan order, so the list can show it. */
let plannedOrder: number[] = [];
let planIsPartial = false;

function planCandidates(): VideoData[] {
  return getLiveVideosForCurrentView().filter((video) => !video.isLive && !video.excluded);
}

/** Started videos first (finish what you began), then the current sort; take what fits the budget. */
function computePlan(): { ids: number[]; seconds: number; partial: VideoData | null } {
  const candidates = sortVideosForDisplay(planCandidates());
  const ordered = [
    ...candidates.filter((video) => video.currentTime > 0),
    ...candidates.filter((video) => video.currentTime <= 0),
  ];
  const budget = planBudgetMinutes == null ? Number.POSITIVE_INFINITY : planBudgetMinutes * 60;
  const ids: number[] = [];
  let seconds = 0;
  for (const video of ordered) {
    const remaining = remainingOf(video);
    if (remaining <= 0 || remaining > budget) continue;
    if (seconds + remaining > budget) continue;
    ids.push(video.id);
    seconds += remaining;
  }
  if (ids.length === 0) {
    const first = ordered.find((video) => remainingOf(video) > 0) ?? null;
    if (first) return { ids: [first.id], seconds: Math.min(budget, remainingOf(first)), partial: first };
  }
  return { ids, seconds, partial: null };
}

function renderPlanner(): void {
  const planner = document.getElementById("planner");
  const startButton = document.getElementById("btn-start-plan") as HTMLButtonElement | null;
  const startLabel = document.getElementById("btn-start-plan-label");
  const summary = document.getElementById("plan-summary");
  if (!planner || !startButton || !summary) return;

  const live =
    !isReadingListView && !isSessionsView && !isTimeView && selectedSession == null && getLiveVideosForCurrentView().length > 0;
  planner.classList.toggle("hidden", !live);
  planner.classList.toggle("flex", live);
  if (!live) {
    plannedTabIds = new Set();
    plannedOrder = [];
    planIsPartial = false;
    return;
  }

  document.querySelectorAll<HTMLButtonElement>(".budget-chip").forEach((chip) => {
    const value = chip.dataset.budget === "all" ? null : Number(chip.dataset.budget);
    chip.setAttribute("aria-pressed", String(value === planBudgetMinutes));
  });

  const plan = computePlan();
  plannedTabIds = new Set(plan.ids);
  plannedOrder = plan.ids;
  planIsPartial = plan.partial != null;
  const count = plan.ids.length;
  const scope = facetCrumbText();
  if (plan.partial) {
    summary.textContent = `Nothing fits whole. Start “${plan.partial.title}” and stop after ${formatDurationWords(plan.seconds)} of ${formatDurationWords(remainingOf(plan.partial))}.`;
  } else {
    summary.textContent =
      count === 0
        ? "Nothing in this list to plan."
        : `${count} ${count === 1 ? "video" : "videos"}, ${formatDurationWords(plan.seconds)}${scope ? ` from ${scope}` : ""}. Started videos go first when you start this plan.`;
  }
  if (startLabel) startLabel.textContent = count === 0 ? "Start" : `Start ${formatDurationWords(plan.seconds)}`;
  startButton.disabled = count === 0;
  startButton.classList.toggle("opacity-50", count === 0);

  document.querySelectorAll<HTMLElement>("#tab-list [data-id]").forEach((row) => {
    const id = parseInt(row.dataset.id || "0", 10);
    row.classList.toggle("queue-row--planned", plannedTabIds.has(id));
  });
}

// ───────────────────────── Language override modal ─────────────────────────

let languageModalTarget: { videoId: string | null; channelName: string; title: string } | null = null;

function knownLanguagesForPicker(): { name: string; code: string | null }[] {
  const seen = new Map<string, string | null>();
  const add = (name: string | null | undefined, code: string | null | undefined) => {
    const label = name ? name.split("(")[0].trim() : "";
    if (!label) return;
    if (!seen.has(label)) seen.set(label, code ?? null);
  };
  for (const video of allVideos) add(video.languageName, video.language);
  for (const session of [selectedSession]) for (const tab of session?.tabs ?? []) add(tab.languageName, tab.language);
  for (const override of Object.values(languageOverrides.videos)) add(override.name, override.code);
  for (const override of Object.values(languageOverrides.channels)) add(override.name, override.code);
  return Array.from(seen.entries())
    .map(([name, code]) => ({ name, code }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function openLanguageModal(target: { videoId: string | null; channelName: string; title: string }): void {
  const modal = document.getElementById("language-modal");
  const list = document.getElementById("language-options");
  const titleEl = document.getElementById("language-modal-title");
  const channelLabel = document.getElementById("language-channel-label");
  const channelToggle = document.getElementById("language-apply-channel") as HTMLInputElement | null;
  const custom = document.getElementById("language-custom") as HTMLInputElement | null;
  if (!modal || !list || !titleEl) return;
  languageModalTarget = target;
  titleEl.textContent = target.title;
  const current = languageOverrideFor(languageOverrides, target.videoId, target.channelName);
  const options = knownLanguagesForPicker();
  list.innerHTML = options
    .map((option) => `
      <label class="language-option">
        <input type="radio" class="ui-radio" name="language-choice" value="${escapeHtml(option.name)}" data-code="${escapeHtml(option.code ?? "")}" ${current?.name === option.name ? "checked" : ""} />
        <span>${escapeHtml(option.name)}</span>
        ${option.code ? `<span class="text-xs text-text-muted uppercase">${escapeHtml(option.code)}</span>` : ""}
      </label>`)
    .join("");
  if (custom) custom.value = "";
  if (channelLabel) channelLabel.textContent = target.channelName ? `Use this for every video from ${target.channelName}` : "Use this for the whole channel";
  if (channelToggle) {
    channelToggle.checked = Boolean(target.channelName) && Boolean(languageOverrides.channels[target.channelName]) && !target.videoId;
    channelToggle.disabled = !target.channelName;
  }
  document.getElementById("language-reset")?.classList.toggle("hidden", current == null);
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  (custom ?? modal).focus();
}

function closeLanguageModal(): void {
  const modal = document.getElementById("language-modal");
  modal?.classList.add("hidden");
  modal?.classList.remove("flex");
  languageModalTarget = null;
}

async function applyLanguageChoice(choice: LanguageOverride | null): Promise<void> {
  const target = languageModalTarget;
  if (!target) return;
  const channelToggle = document.getElementById("language-apply-channel") as HTMLInputElement | null;
  const wholeChannel = Boolean(channelToggle?.checked) && Boolean(target.channelName);
  if (choice == null) {
    if (target.videoId) delete languageOverrides.videos[target.videoId];
    if (wholeChannel || !target.videoId) delete languageOverrides.channels[target.channelName];
  } else if (wholeChannel) {
    languageOverrides.channels[target.channelName] = choice;
    if (target.videoId) delete languageOverrides.videos[target.videoId];
  } else if (target.videoId) {
    languageOverrides.videos[target.videoId] = choice;
  }
  await saveLanguageOverrides(languageOverrides);
  closeLanguageModal();
  lastFacetRailHtml = "";
  lastTabListFingerprint = "";
  render();
  showToast(choice ? `Language set to ${choice.name}${wholeChannel ? " for the whole channel" : ""}.` : "Back to detected language.");
}

// ───────────────────────── Keyboard ─────────────────────────

let focusedRowKey: string | null = null;

function queueRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#tab-list [data-id], #tab-list [data-session-tab-url]"));
}

function rowKey(row: HTMLElement): string {
  return row.dataset.id ?? row.dataset.sessionTabUrl ?? "";
}

function applyRowFocus(): void {
  const rows = queueRows();
  let found = false;
  for (const row of rows) {
    const on = focusedRowKey != null && rowKey(row) === focusedRowKey;
    row.classList.toggle("queue-row--focused", on);
    if (on) found = true;
  }
  if (!found) focusedRowKey = null;
}

function moveRowFocus(delta: number): void {
  const rows = queueRows();
  if (rows.length === 0) return;
  const index = rows.findIndex((row) => rowKey(row) === focusedRowKey);
  const next = index < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + delta));
  focusedRowKey = rowKey(rows[next]);
  applyRowFocus();
  rows[next].scrollIntoView({ block: "nearest" });
}

function focusedRow(): HTMLElement | null {
  return queueRows().find((row) => rowKey(row) === focusedRowKey) ?? null;
}

function keyboardTargetIsTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function anyDialogOpen(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], #settings-modal, #language-modal')).some(
    (element) => !element.classList.contains("hidden")
  );
}

function handleDeskKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (anyDialogOpen()) return;
  const onCheckbox = event.target instanceof HTMLInputElement && event.target.type === "checkbox";
  if (keyboardTargetIsTyping(event) && !(onCheckbox && event.key === "Escape")) {
    if (event.key !== "Escape") return;
    const target = event.target as HTMLInputElement;
    if (target.id === "search-input" && target.value !== "") document.getElementById("search-clear-btn")?.click();
    else target.blur();
    return;
  }
  switch (event.key) {
    case "/": {
      event.preventDefault();
      const search = document.getElementById("search-input") as HTMLInputElement | null;
      search?.focus();
      search?.select();
      return;
    }
    case "j":
    case "ArrowDown":
      event.preventDefault();
      moveRowFocus(1);
      return;
    case "k":
    case "ArrowUp":
      event.preventDefault();
      moveRowFocus(-1);
      return;
    case "Enter": {
      const row = focusedRow();
      (row?.querySelector(".jump-btn, .session-open-new-tab") as HTMLElement | null)?.click();
      return;
    }
    case "x": {
      const row = focusedRow();
      if (!row) return;
      const next = queueRows();
      const index = next.indexOf(row);
      const neighbour = next[index + 1] ?? next[index - 1] ?? null;
      focusedRowKey = neighbour ? rowKey(neighbour) : null;
      (row.querySelector(".close-btn, .session-remove-btn") as HTMLElement | null)?.click();
      return;
    }
    case " ": {
      const row = focusedRow();
      if (!row) return;
      event.preventDefault();
      (row.querySelector(".selection-toggle input, .session-selection-toggle input") as HTMLElement | null)?.click();
      return;
    }
    case "Escape":
      if (focusedRowKey) {
        focusedRowKey = null;
        applyRowFocus();
      } else if (selectedTabIds.size > 0 || selectedSessionTabUrls.size > 0) {
        document.getElementById("btn-clear-selection")?.click();
      } else if (hasAnyFacet()) {
        toggleFacet("all");
      }
      return;
  }
}


function queueThumbHtml(videoId: string | null, draggableOff: boolean): string {
  const thumbQuality = thumbnailQuality === "high" ? "hqdefault.jpg" : "mqdefault.jpg";
  const { src, cacheKey } = getThumbnailSrc(videoId, thumbQuality);
  if (!src) return "";
  const keyAttr = cacheKey ? ` data-thumbnail-key="${cacheKey}"` : "";
  return `<img src="${src}"${keyAttr} class="manager-card-thumb w-full h-full object-cover" loading="lazy" decoding="async" alt=""${draggableOff ? ` draggable="false"` : ""} />`;
}

function queueCheckboxHtml(toggleClass: string, checked: boolean): string {
  return `
    <div class="relative flex items-center justify-center w-5 h-5 shrink-0 cursor-pointer ${toggleClass}">
      <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-text-muted/50 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${checked ? "checked" : ""}>
      <svg class="absolute w-2.5 h-2.5 text-on-accent opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>`;
}

const QUEUE_ICON_OPEN = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;
const QUEUE_ICON_CLOSE = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const QUEUE_ICON_TRASH = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

function renderVideoList(videos: VideoData[], sectionColorIndex?: number | "unsorted"): string {
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
            <button type="button" class="video-chapters-toggle text-[11px] font-semibold text-accent hover:text-accent-hover flex items-center gap-1.5 transition-colors cursor-pointer py-0.5">
              <span class="chapter-toggle-arrow text-[9px] transition-transform">▶</span>
              <span>📑 ${video.chapters.length} Chapters</span>
            </button>
            <div class="video-chapters-list hidden mt-1.5 space-y-1 pl-2.5 border-l-2 border-accent/30 text-xs">
              ${video.chapters
                .map(
                  (chapter) => `
                <div class="video-chapter-item flex items-center justify-between py-1 px-1.5 rounded hover:bg-surface-hover/70 cursor-pointer group/chapter transition-colors" data-video-id="${video.id}" data-time="${chapter.startSeconds}">
                  <span class="truncate mr-3 font-medium text-text-secondary group-hover/chapter:text-accent transition-colors">${escapeHtml(chapter.title)}</span>
                  <span class="tabular-nums text-[11px] text-text-muted shrink-0">${formatCompact(chapter.startSeconds)}${chapter.durationSeconds ? ` · ${formatDurationWords(chapter.durationSeconds)}` : ""}</span>
                </div>
              `
                )
                .join("")}
            </div>
          </div>
        `
        : "";

    return `
      <div class="${rowClass}" data-id="${video.id}"${dnd.draggableAttr}>
        <div class="queue-offset">${offsetLabel}</div>
        <div class="queue-body">
          ${queueCheckboxHtml("selection-toggle", isSelected)}
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

function sortSessionTabs(tabs: SavedSessionTab[]): SavedSessionTab[] {
  return [...tabs].sort((a, b) => {
    const titleA = a.title ?? "";
    const titleB = b.title ?? "";
    const channelA = a.channelName ?? "";
    const channelB = b.channelName ?? "";
    const secA = a.seconds ?? 0;
    const secB = b.seconds ?? 0;
    switch (sortOption) {
      case "duration-desc": return secB - secA;
      case "duration-asc": return secA - secB;
      case "title-asc": return titleA.localeCompare(titleB);
      case "channel-asc": return channelA.localeCompare(channelB);
      case "index-asc": return 0;
      default: return secB - secA;
    }
  });
}

function renderSessionGrid(tabs: SavedSessionTab[], sectionColorIndex?: number | "unsorted"): string {
  if (tabs.length === 0) return "";
  const thumbQuality = thumbnailQuality === "high" ? "hqdefault.jpg" : "mqdefault.jpg";
  const dnd = tabCardDnDHtml(sectionColorIndex);
  const imgDragOff = sectionColorIndex !== undefined ? ` draggable="false"` : "";
  const cardsHtml = tabs.map((tab) => {
    const videoId = getVideoIdFromUrl(tab.url);
    const { src: thumbnailUrl, cacheKey: thumbnailCacheKey } = getThumbnailSrc(videoId, thumbQuality);
    const imgAttr = thumbnailCacheKey
      ? `src="${thumbnailUrl}" data-thumbnail-key="${thumbnailCacheKey}"`
      : `src="${thumbnailUrl}"`;
    const title = tab.title ?? "Untitled";
    const channel = tab.channelName ?? "";
    const sec = tab.seconds ?? 0;
    const isSelected = selectedSessionTabUrls.has(tab.url);
    const urlAttr = escapeHtml(tab.url);
    return `
      <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-[background-color,border-color] ${isSelected ? "bg-surface-hover border-border ring-1 ring-accent/50" : ""}${dnd.extraClass}" data-session-tab-url="${urlAttr}"${dnd.draggableAttr}>
        <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden session-video-click-target cursor-pointer">
          ${thumbnailUrl
        ? `<img ${imgAttr} class="manager-card-thumb w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="eager" decoding="async" alt=""${imgDragOff} />`
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
          <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? "opacity-100" : ""} session-selection-toggle flex items-center justify-center w-5 h-5">
            <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" ${isSelected ? "checked" : ""}>
            <svg class="absolute w-2.5 h-2.5 text-on-accent opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div class="absolute top-1 right-1 z-10 flex gap-1 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 transition-opacity duration-200">
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

function renderSessionList(tabs: SavedSessionTab[], sectionColorIndex?: number | "unsorted"): string {
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
        <div class="queue-offset">${offsetLabel}</div>
        <div class="queue-body">
          ${queueCheckboxHtml("session-selection-toggle", isSelected)}
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

function renderVideoGrid(videos: VideoData[], sectionColorIndex?: number | "unsorted"): string {
  if (videos.length === 0) return '';

  const thumbQuality = thumbnailQuality === 'high' ? 'hqdefault.jpg' : 'mqdefault.jpg';
  const dnd = tabCardDnDHtml(sectionColorIndex);
  const imgDragOff = sectionColorIndex !== undefined ? ` draggable="false"` : "";
  const cardsHtml = videos.map(video => {
    const isSelected = selectedTabIds.has(video.id);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
    const videoId = getVideoIdFromUrl(video.url);
    const { src: thumbnailUrl, cacheKey: thumbnailCacheKey } = getThumbnailSrc(videoId, thumbQuality);
    const imgAttr = thumbnailCacheKey
      ? `src="${thumbnailUrl}" data-thumbnail-key="${thumbnailCacheKey}"`
      : `src="${thumbnailUrl}"`;

    return `
            <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-[background-color,border-color] ${isSelected ? 'bg-surface-hover border-border ring-1 ring-accent/50' : ''}${dnd.extraClass}" data-id="${video.id}"${dnd.draggableAttr}>
                <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden video-click-target cursor-pointer">
                    ${thumbnailUrl
        ? `<img ${imgAttr} class="manager-card-thumb w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="eager" decoding="async" alt=""${imgDragOff} />`
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

                    <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'opacity-100' : ''} selection-toggle flex items-center justify-center w-5 h-5">
                        <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" ${isSelected ? 'checked' : ''}>
                        <svg class="absolute w-2.5 h-2.5 text-on-accent opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>

                    <div class="absolute top-1 right-1 z-10 flex gap-1 opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 transition-opacity duration-200">
                         <button type="button" draggable="false" class="w-7 h-7 flex items-center justify-center bg-black/40 hover:bg-accent text-white rounded-md backdrop-blur-sm border border-white/10 hover:border-accent transition-[background-color,border-color] duration-200 active:scale-[0.96] jump-btn" title="Go to tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                         </button>
                         <button type="button" draggable="false" class="w-7 h-7 flex items-center justify-center bg-black/40 hover:bg-accent text-white rounded-md backdrop-blur-sm border border-white/10 hover:border-accent transition-[background-color,border-color] duration-200 active:scale-[0.96] close-btn" title="Close tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
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
                          ${video.languageName ? `<span class="manager-card-language bg-accent/10 text-accent px-1.5 py-0.5 rounded-full font-bold uppercase shrink-0">${video.languageName.split('(')[0].trim()}</span>` : `<span class="manager-card-language hidden"></span>`}
                        </div>
                    </div>
                    ${
                      video.chapters && video.chapters.length > 0
                        ? `
                          <div class="video-chapters-container mt-1.5 pt-1.5 border-t border-border/40">
                            <button type="button" class="video-chapters-toggle text-[10px] font-semibold text-accent hover:text-accent-hover flex items-center gap-1 transition-colors cursor-pointer py-0.5">
                              <span class="chapter-toggle-arrow text-[8px] transition-transform">▶</span>
                              <span>📑 ${video.chapters.length} Chapters</span>
                            </button>
                            <div class="video-chapters-list hidden mt-1 space-y-0.5 pl-2 border-l-2 border-accent/30 text-[11px] max-h-36 overflow-y-auto custom-scrollbar">
                              ${video.chapters
                                .map(
                                  (chapter) => `
                                <div class="video-chapter-item flex items-center justify-between py-0.5 px-1 rounded hover:bg-surface-hover/70 cursor-pointer group/chapter transition-colors" data-video-id="${video.id}" data-time="${chapter.startSeconds}">
                                  <span class="truncate mr-1 font-medium text-text-secondary group-hover/chapter:text-accent transition-colors text-[10px]">${escapeHtml(chapter.title)}</span>
                                  <span class="tabular-nums text-[10px] text-text-muted shrink-0">${formatCompact(chapter.startSeconds)}</span>
                                </div>
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

function updateSelectAllCheckbox() {
  const wrap = document.getElementById("select-all-wrap");
  const checkbox = document.getElementById("select-all-checkbox") as HTMLInputElement;
  const dashEl = wrap?.querySelector(".select-all-indeterminate-dash") as HTMLElement;
  if (!wrap || !checkbox) return;

  const inSessionView = selectedSession != null;
  const tabElements = document.querySelectorAll("#tab-list [data-session-tab-url]");
  const idElements = document.querySelectorAll("#tab-list [data-id]");
  const visibleUrls = inSessionView ? Array.from(tabElements).map((el) => (el as HTMLElement).getAttribute("data-session-tab-url")!) : [];
  const visibleIds = inSessionView ? [] : Array.from(idElements).map((el) => parseInt((el as HTMLElement).dataset.id || "0", 10));

  const count = inSessionView ? visibleUrls.length : visibleIds.length;
  if (count === 0) {
    wrap.classList.add("hidden");
    wrap.classList.remove("flex");
    return;
  }
  wrap.classList.remove("hidden");
  wrap.classList.add("flex");

  const allSelected = inSessionView
    ? visibleUrls.every((url) => selectedSessionTabUrls.has(url))
    : visibleIds.every((id) => selectedTabIds.has(id));
  const someSelected = inSessionView
    ? visibleUrls.some((url) => selectedSessionTabUrls.has(url))
    : visibleIds.some((id) => selectedTabIds.has(id));

  checkbox.checked = allSelected;
  checkbox.indeterminate = someSelected && !allSelected;
  if (dashEl) dashEl.style.opacity = checkbox.indeterminate ? "1" : "0";
}

function syncFlatGroupHeaderCheckboxes(): void {
  document.querySelectorAll(".group-selection-toggle").forEach((toggle) => {
    const groupName = (toggle as HTMLElement).dataset.group;
    if (!groupName) return;

    let scopeVideos = allVideos;
    if (currentWindowId !== "all") {
      scopeVideos = allVideos.filter((video) => video.windowId === currentWindowId);
    }
    const videosInGroup = scopeVideos.filter((video) => {
      if (groupingMode === "channel") {
        return (video.channelName || "Unknown Channel") === groupName;
      }
      if (groupingMode === "language") {
        const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
        const langName = stripped ? stripped : (video.language ? video.language.toUpperCase() : "Unspecified");
        return langName === groupName;
      }
      return false;
    });

    const allSelected = videosInGroup.length > 0 && videosInGroup.every((video) => selectedTabIds.has(video.id));
    const someSelected = videosInGroup.some((video) => selectedTabIds.has(video.id));
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    if (!checkbox) return;
    checkbox.checked = allSelected;
    checkbox.indeterminate = someSelected && !allSelected;
  });
}

function syncNestedGroupHeaderCheckboxes(): void {
  document.querySelectorAll(".nested-group-selection-toggle").forEach((toggle) => {
    const el = toggle as HTMLElement;
    const scopeId = el.dataset.nestedGroupScope;
    const groupName = el.dataset.nestedGroupName;
    if (!scopeId || !groupName) return;

    let allSelected = false;
    let someSelected = false;

    if (selectedSession) {
      const secs = orderedSections(selectedSession.sections);
      const inSection = (tab: SavedSessionTab) => {
        if (scopeId === "__unsorted") return !sessionTabSectionId(tab, secs);
        return sessionTabSectionId(tab, secs) === scopeId;
      };
      const groupTabs = (selectedSession.tabs ?? []).filter((tab) => {
        if (!inSection(tab)) return false;
        if (groupingMode === "channel") return (tab.channelName ?? "Unknown Channel") === groupName;
        if (groupingMode === "language") {
          const stripped = tab.languageName ? tab.languageName.split("(")[0].trim() : "";
          const langName = stripped ? stripped : (tab.language ? tab.language.toUpperCase() : "Unspecified");
          return langName === groupName;
        }
        return false;
      });
      const urls = groupTabs.map((tab) => tab.url ?? "").filter(Boolean);
      allSelected = urls.length > 0 && urls.every((url) => selectedSessionTabUrls.has(url));
      someSelected = urls.some((url) => selectedSessionTabUrls.has(url));
    } else {
      let scopeVideos = allVideos;
      if (currentWindowId !== "all") {
        scopeVideos = allVideos.filter((video) => video.windowId === currentWindowId);
      }
      const groupVideos = scopeVideos.filter((video) => {
        const sid = liveSectionIdForVideo(video);
        const inSec = scopeId === "__unsorted" ? sid === undefined : sid === scopeId;
        if (!inSec) return false;
        if (groupingMode === "channel") return (video.channelName || "Unknown Channel") === groupName;
        if (groupingMode === "language") {
          const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
          const langName = stripped ? stripped : (video.language ? video.language.toUpperCase() : "Unspecified");
          return langName === groupName;
        }
        return false;
      });
      allSelected = groupVideos.length > 0 && groupVideos.every((video) => selectedTabIds.has(video.id));
      someSelected = groupVideos.some((video) => selectedTabIds.has(video.id));
    }

    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    if (!checkbox) return;
    checkbox.checked = allSelected;
    checkbox.indeterminate = someSelected && !allSelected;
  });
}

function currentSectionsForMove(): SessionSection[] {
  if (selectedSession) return orderedSections(selectedSession.sections);
  return orderedSections(liveTabSectionsState.sections);
}

function moveToSectionPopoverSig(): string {
  const context = selectedSession ? `s:${selectedSession.id}` : "live";
  const sections = currentSectionsForMove();
  if (sections.length === 0) return `${context}\x1f0`;
  return `${context}\x1f${orderedSections(sections).map((s) => `${s.id}:${s.name}:${s.emoji ?? ""}:${s.colorIndex ?? 0}`).join("|")}`;
}

function updateMoveToSectionPopover(): void {
  const pop = document.getElementById("move-to-section-popover");
  if (!pop) return;
  const sig = moveToSectionPopoverSig();
  if (sig === lastMoveToSectionPopoverSig) return;
  lastMoveToSectionPopoverSig = sig;

  const sections = currentSectionsForMove();
  if (sections.length === 0) {
    pop.innerHTML = `<div class="px-3 py-2.5 text-[11px] text-text-muted leading-relaxed">Create a pile with <span class="text-text-secondary font-medium">New pile</span> first.</div>`;
    return;
  }
  pop.innerHTML = `
    <div class="menu-panel-header">Move to pile</div>
    <div class="px-1 pb-1">${renderSectionPickerRows(sections)}</div>
  `;
}

function selectionRowSyncSig(): string {
  const inSession = selectedSession != null;
  const sel = inSession
    ? [...selectedSessionTabUrls].sort().join("|")
    : [...selectedTabIds].sort((a, b) => a - b).join(",");
  return `${inSession ? "s" : "l"}:${selectedSession?.id ?? ""}:${layoutMode}:${sel}`;
}

function applyTabListCheckboxIndeterminateFromAttr(): void {
  document.querySelectorAll("#tab-list input[type='checkbox']").forEach((checkbox) => {
    const input = checkbox as HTMLInputElement;
    if (input.getAttribute("indeterminate") != null) input.indeterminate = true;
  });
}

function updateSelectionUI() {
  const bar = document.getElementById("selection-actions");
  const count = document.getElementById("selection-count");
  const closeBtn = document.getElementById("btn-close-selected");
  const moveWrap = document.getElementById("move-to-section-wrap");
  const stageSelectedBtn = document.getElementById("btn-stage-study-selected");

  const inSessionView = selectedSession != null;
  const selectionSize = inSessionView ? selectedSessionTabUrls.size : selectedTabIds.size;
  const hasSections = currentSectionsForMove().length > 0;

  if (stageSelectedBtn) {
    stageSelectedBtn.classList.toggle("hidden", inSessionView || isReadingListView);
  }

  if (selectionSize > 0 && !isReadingListView) {
    bar?.classList.remove("hidden");
    if (count) count.innerText = `${selectionSize} selected`;
    if (closeBtn) closeBtn.textContent = inSessionView ? "Remove from session" : "Close tabs";
    if (moveWrap) {
      if (hasSections) {
        moveWrap.classList.remove("hidden");
        updateMoveToSectionPopover();
      } else moveWrap.classList.add("hidden");
    }
  } else {
    bar?.classList.add("hidden");
    moveWrap?.classList.add("hidden");
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  }

  const rowSig = selectionRowSyncSig();
  const skipRowSync = !tabListContainerInnerHtmlUpdated && rowSig === lastSelectionRowSyncSig;

  if (!skipRowSync) {
    lastSelectionRowSyncSig = rowSig;
    updateSelectAllCheckbox();

    if (inSessionView) {
      document.querySelectorAll("#tab-list [data-session-tab-url]").forEach((row) => {
        const url = (row as HTMLElement).getAttribute("data-session-tab-url");
        const isSelected = url != null && selectedSessionTabUrls.has(url);
        const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (checkbox) checkbox.checked = isSelected;
        if (isSelected) {
          row.classList.add("bg-surface-hover", "border-border", "ring-1", "ring-accent/50");
          row.querySelector(".session-selection-toggle")?.classList.add("opacity-100");
        } else {
          row.classList.remove("bg-surface-hover", "border-border", "ring-1", "ring-accent/50");
          row.querySelector(".session-selection-toggle")?.classList.remove("opacity-100");
        }
      });
      syncNestedGroupHeaderCheckboxes();
      return;
    }

    document.querySelectorAll('#tab-list [data-id]').forEach((row) => {
      const id = parseInt((row as HTMLElement).dataset.id || "0");
      const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const isSelected = selectedTabIds.has(id);
      if (checkbox) checkbox.checked = isSelected;

      if (layoutMode === 'list') {
        if (isSelected) row.classList.add('bg-surface-hover', 'border-border');
        else row.classList.remove('bg-surface-hover', 'border-border');
      } else {
        if (isSelected) row.classList.add('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');
        else row.classList.remove('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');

        const selectionToggle = row.querySelector('.selection-toggle');
        if (selectionToggle) {
          if (isSelected) selectionToggle.classList.add('opacity-100');
          else selectionToggle.classList.remove('opacity-100');
        }
      }
    });

    syncFlatGroupHeaderCheckboxes();
    syncNestedGroupHeaderCheckboxes();
  }
}

function openStudySessionModal(targetTabIds?: number[]): void {
  const modal = document.getElementById("study-session-modal");
  if (!modal) return;

  let queueTabIds: number[] = [];
  if (targetTabIds && targetTabIds.length > 0) {
    queueTabIds = targetTabIds;
  } else if (selectedTabIds.size > 0) {
    queueTabIds = Array.from(selectedTabIds);
  } else {
    let baseVideos: VideoData[] = [];
    if (currentWindowId === "all") {
      baseVideos = allVideos;
    } else {
      const group = windowGroups.find((windowGroup) => windowGroup.id === currentWindowId);
      if (group) baseVideos = group.tabs;
    }
    const visibleVideos = filterVideosForDisplay(baseVideos);
    queueTabIds = visibleVideos.map((video) => video.id);
  }

  if (queueTabIds.length === 0) {
    showToast("No active YouTube tabs available to stage.");
    return;
  }

  const previewContainer = document.getElementById("study-queue-preview");
  const countBadge = document.getElementById("study-queue-count");
  if (countBadge) countBadge.textContent = String(queueTabIds.length);

  if (previewContainer) {
    const queueVideos = queueTabIds
      .map((tabId) => allVideos.find((video) => video.id === tabId))
      .filter((video): video is VideoData => Boolean(video));

    if (queueVideos.length === 0) {
      previewContainer.innerHTML = `<div class="p-2 text-text-muted text-center">No tabs found.</div>`;
    } else {
      previewContainer.innerHTML = queueVideos
        .map(
          (video, index) => `
          <div class="flex items-center gap-2 p-1.5 rounded bg-surface-elevated/50 border border-border/40 text-xs text-text-primary" data-queue-tab-id="${video.id}">
            <span class="w-4 text-center tabular-nums text-[10px] text-text-muted shrink-0">${index + 1}</span>
            <span class="truncate flex-1 font-medium">${escapeHtml(video.title)}</span>
            <span class="text-[10px] tabular-nums text-text-muted shrink-0 px-1.5 py-0.5 rounded bg-surface border border-border">${formatTime(video.seconds)}</span>
          </div>
        `
        )
        .join("");
    }
  }

  updateSpeedSelectorUI(selectedPlaybackSpeed);

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeStudySessionModal(): void {
  const modal = document.getElementById("study-session-modal");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function updateSpeedSelectorUI(speed: number): void {
  selectedPlaybackSpeed = speed;
  const speedButtons = document.querySelectorAll(".study-speed-btn");
  speedButtons.forEach((button) => {
    const buttonSpeed = parseFloat(button.getAttribute("data-speed") || "1");
    if (Math.abs(buttonSpeed - speed) < 0.01) {
      button.classList.add("text-accent", "bg-surface-hover");
      button.classList.remove("text-text-muted");
    } else {
      button.classList.remove("text-accent", "bg-surface-hover");
      button.classList.add("text-text-muted");
    }
  });
}

async function handleLaunchStudyQueue(): Promise<void> {
  const previewElements = document.querySelectorAll("#study-queue-preview [data-queue-tab-id]");
  const orderedTabIds = Array.from(previewElements)
    .map((element) => parseInt(element.getAttribute("data-queue-tab-id") || "", 10))
    .filter((tabId) => Number.isInteger(tabId) && tabId > 0);

  if (orderedTabIds.length === 0) {
    showToast("No tabs queued to stage.");
    return;
  }

  const stashCheckbox = document.getElementById("study-stash-distractions") as HTMLInputElement | null;
  const stashDistractionTabs = stashCheckbox?.checked ?? false;
  const sessionNameInput = document.getElementById("study-session-name-input") as HTMLInputElement | null;
  const sessionName = sessionNameInput?.value.trim() || "Stashed Backlog";

  try {
    const response = await browser.runtime.sendMessage({
      action: "stage-focused-study-queue",
      payload: {
        orderedTabIds,
        stashDistractionTabs,
        sessionName,
        playbackSpeed: selectedPlaybackSpeed,
      },
    });

    if (response?.success) {
      closeStudySessionModal();
      selectedTabIds.clear();
      updateSelectionUI();
      showToast(
        stashDistractionTabs && response.stashedCount > 0
          ? `Focused queue started. Stashed ${response.stashedCount} distraction tabs.`
          : `Focused queue started at ${selectedPlaybackSpeed}x speed.`
      );
      await fetchTabs();
      await refreshSavedSessionsSidebar();
    } else {
      showToast(response?.errorMessage || "Failed to stage study queue.");
    }
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Error staging study queue.");
  }
}

function setupListeners() {
  const sortSelectRoot = document.getElementById("sort-select");
  if (sortSelectRoot) {
    sortSelectHandle = mountCustomSelect(sortSelectRoot, {
      options: [...SORT_SELECT_OPTIONS],
      value: sortOption,
      compact: true,
      ariaLabel: "Sort by",
      onChange: (value) => {
        sortOption = value;
        saveSettings();
        render();
      },
    });
  }

  const restoreTargetRoot = document.getElementById("restore-target-window");
  if (restoreTargetRoot) {
    restoreTargetSelect = mountCustomSelect(restoreTargetRoot, {
      block: true,
      ariaLabel: "Open in",
      value: "new",
      options: [
        { value: "new", label: "New window" },
        { value: "current", label: "Current window" },
      ],
    });
  }

  const saveSessionTargetRoot = document.getElementById("save-session-target");
  if (saveSessionTargetRoot) {
    saveSessionTargetSelect = mountCustomSelect(saveSessionTargetRoot, {
      block: true,
      ariaLabel: "Existing session",
      options: [],
      value: "",
    });
    saveSessionTargetSelect.setHidden(true);
  }

  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    fetchTabs();
  });

  document.getElementById("btn-clear-selection")?.addEventListener("click", () => {
    selectedTabIds.clear();
    selectedSessionTabUrls.clear();
    updateSelectionUI();
    render();
  });

  document.getElementById("btn-close-selected")?.addEventListener("click", async () => {
    if (selectedSession) {
      const urls = Array.from(selectedSessionTabUrls);
      if (urls.length === 0) return;
      const confirmed = await showConfirm({
        title: "Remove from session",
        message: `Remove ${urls.length} video(s) from "${selectedSession.name}"?`,
        confirmLabel: "Remove",
        confirmDanger: true,
      });
      if (!confirmed) return;
      const newTabs = (selectedSession.tabs ?? []).filter(
        (sessionTab) => !urls.some((u) => sessionTabMatchesUrl(sessionTab, u))
      );
      await updateSessionTabs(selectedSession.id, newTabs);
      selectedSession.tabs = newTabs;
      selectedSessionTabUrls.clear();
      refreshSavedSessionsSidebar();
      updateSelectionUI();
      render();
      return;
    }
    const ids = Array.from(selectedTabIds);
    const confirmed = await showConfirm({
      title: "Close tabs",
      message: `Close ${ids.length} tabs?`,
      confirmLabel: "Close",
      confirmDanger: true,
    });
    if (confirmed) {
      await browser.tabs.remove(ids);
      selectedTabIds.clear();
      updateSelectionUI();
      fetchTabs();
    }
  });

  document.getElementById("btn-stage-study-selected")?.addEventListener("click", () => {
    openStudySessionModal(Array.from(selectedTabIds));
  });

  document.getElementById("btn-stage-study-header")?.addEventListener("click", () => {
    openStudySessionModal();
  });

  document.getElementById("planner")?.addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-budget]");
    if (!chip) return;
    planBudgetMinutes = chip.dataset.budget === "all" ? null : Number(chip.dataset.budget);
    lastTabListFingerprint = "";
    render();
  });

  document.getElementById("btn-start-plan")?.addEventListener("click", () => {
    if (plannedTabIds.size === 0) return;
    openStudySessionModal(Array.from(plannedTabIds));
  });

  const onFacetClick = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-pile-create]")) {
      openAddSectionModal();
      return;
    }
    if (target.closest(".sidebar-item")) return;
    const button = target.closest<HTMLElement>("[data-facet-kind]");
    if (!button) return;
    const kind = button.dataset.facetKind as FacetKind;
    const value = button.dataset.facetValue ?? "";
    toggleFacet(kind, value);
  };
  document.getElementById("facet-rail")?.addEventListener("click", onFacetClick);
  document.getElementById("time-bar")?.addEventListener("click", onFacetClick);
  document.getElementById("time-bar-rest")?.addEventListener("click", onFacetClick);
  document.getElementById("facet-clear")?.addEventListener("click", () => toggleFacet("all"));
  document.addEventListener("keydown", handleDeskKeydown);

  document.getElementById("ctx-set-language")?.addEventListener("click", () => {
    const target = tabSectionContextTarget;
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    if (!target) return;
    if (target.mode === "live") {
      const video = allVideos.find((candidate) => candidate.id === target.tabId);
      if (!video) return;
      openLanguageModal({ videoId: getVideoIdFromUrl(video.url), channelName: video.channelName || "", title: video.title });
    } else {
      const tab = (selectedSession?.tabs ?? []).find((candidate) => candidate.url === target.url);
      if (!tab) return;
      openLanguageModal({ videoId: getVideoIdFromUrl(tab.url), channelName: tab.channelName || "", title: tab.title ?? tab.url });
    }
  });
  document.getElementById("language-cancel")?.addEventListener("click", closeLanguageModal);
  document.getElementById("language-modal")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).id === "language-modal") closeLanguageModal();
  });
  document.getElementById("language-reset")?.addEventListener("click", () => {
    void applyLanguageChoice(null);
  });
  const saveLanguageChoice = () => {
    const custom = (document.getElementById("language-custom") as HTMLInputElement | null)?.value.trim() ?? "";
    const picked = document.querySelector<HTMLInputElement>('input[name="language-choice"]:checked');
    let choice: LanguageOverride | null = null;
    if (custom) {
      const looksLikeCode = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/i.test(custom);
      choice = looksLikeCode
        ? { code: custom.toLowerCase(), name: custom.toUpperCase() }
        : { code: null, name: custom.charAt(0).toUpperCase() + custom.slice(1) };
    } else if (picked) {
      choice = { code: picked.dataset.code || null, name: picked.value };
    }
    if (!choice) {
      showToast("Pick a language or type one.");
      return;
    }
    void applyLanguageChoice(choice);
  };
  document.getElementById("language-save")?.addEventListener("click", saveLanguageChoice);
  document.getElementById("language-custom")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      saveLanguageChoice();
    }
  });

  document.getElementById("facet-rail")?.addEventListener("contextmenu", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-facet-kind=\"pile\"]");
    const sectionId = button?.dataset.facetValue;
    if (!sectionId || sectionId === "__unsorted") return;
    event.preventDefault();
    // The document-level contextmenu listener closes every menu; keep it from closing this one.
    event.stopPropagation();
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    sectionHeaderContextTarget = { sectionId };
    const menu = document.getElementById("section-header-context-menu");
    if (menu) positionFixedMenu(menu, event.clientX, event.clientY);
  });

  document.getElementById("study-modal-close")?.addEventListener("click", closeStudySessionModal);
  document.getElementById("study-modal-cancel")?.addEventListener("click", closeStudySessionModal);

  document.getElementById("study-modal-submit")?.addEventListener("click", () => {
    void handleLaunchStudyQueue();
  });

  document.getElementById("study-session-modal")?.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).id === "study-session-modal") {
      closeStudySessionModal();
    }
  });

  document.querySelectorAll(".study-speed-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const speed = parseFloat(button.getAttribute("data-speed") || "1");
      if (!isNaN(speed)) {
        updateSpeedSelectorUI(speed);
      }
    });
  });

  const stashCheckbox = document.getElementById("study-stash-distractions") as HTMLInputElement | null;
  const sessionNameWrap = document.getElementById("study-session-name-wrap");
  stashCheckbox?.addEventListener("change", () => {
    if (sessionNameWrap) {
      sessionNameWrap.classList.toggle("hidden", !stashCheckbox.checked);
    }
  });

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
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-session-action]");
    if (!button) return;
    const card = button.closest<HTMLElement>("[data-session-id]");
    const sessionId = card?.dataset.sessionId;
    if (!card || !sessionId) return;
    event.stopPropagation();
    sidebarContextTarget = { type: "session", sessionId };
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
  document.getElementById("saved-sessions-sidebar")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = (event.target as HTMLElement).closest<HTMLElement>(".session-card");
    if (!card || event.target !== card) return;
    event.preventDefault();
    card.click();
  });

  document.body.addEventListener("click", async (event) => {
    const item = (event.target as HTMLElement).closest(".sidebar-item");
    if (!item) return;
    const type = item.getAttribute("data-sidebar-type");
    if (type === "time") {
      isTimeView = true;
      isSessionsView = false;
      isReadingListView = false;
      selectedSession = null;
      selectedSessionTabUrls.clear();
      selectedTabIds.clear();
      updateSelectionUI();
      refreshSavedSessionsSidebar();
      render();
      return;
    }
    isTimeView = false;
    if (type === "sessions") {
      isSessionsView = true;
      isReadingListView = false;
      selectedSession = null;
      selectedSessionTabUrls.clear();
      selectedTabIds.clear();
      updateSelectionUI();
      refreshSavedSessionsSidebar();
      render();
      return;
    }
    isSessionsView = false;
    clearFacets();
    focusedRowKey = null;
    if (type === "all") {
      isReadingListView = false;
      selectedSession = null;
      selectedSessionTabUrls.clear();
      currentWindowId = "all";
      refreshSavedSessionsSidebar();
      render();
    } else if (type === "reading-list") {
      isReadingListView = true;
      selectedSession = null;
      selectedSessionTabUrls.clear();
      currentWindowId = "all";
      selectedTabIds.clear();
      updateSelectionUI();
      refreshSavedSessionsSidebar();
      render();
    } else if (type === "window") {
      isReadingListView = false;
      selectedSession = null;
      selectedSessionTabUrls.clear();
      const id = item.getAttribute("data-window-id");
      if (id) {
        currentWindowId = parseInt(id, 10);
        refreshSavedSessionsSidebar();
        render();
      }
    } else if (type === "session") {
      isReadingListView = false;
      const id = item.getAttribute("data-session-id");
      if (!id) return;
      const sessions = await getSavedSessions();
      const session = sessions.find((saved) => saved.id === id);
      if (session) {
        selectedSession = session;
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
    sidebarContextTarget = null;
    const groupSave = document.getElementById("ctx-group-save");
    const groupSession = document.getElementById("ctx-group-session");
    groupSave?.classList.add("hidden");
    groupSession?.classList.add("hidden");
    if (type === "all" || type === "window") {
      sidebarContextTarget = type === "all" ? { type: "all" } : { type: "window", windowId: parseInt(item.getAttribute("data-window-id") || "0", 10) };
      groupSave?.classList.remove("hidden");
    } else if (type === "session") {
      sidebarContextTarget = { type: "session", sessionId: item.getAttribute("data-session-id") || undefined };
      groupSession?.classList.remove("hidden");
      const addBtn = document.getElementById("ctx-add-to-session");
      const hasLiveTabs = allVideos.length > 0;
      addBtn?.classList.toggle("hidden", !hasLiveTabs);
      document.getElementById("ctx-divider-edit")?.classList.toggle("hidden", !hasLiveTabs);
      const pinLabel = document.getElementById("ctx-pin-label");
      const pinned = item.getAttribute("data-pinned") === "1";
      if (pinLabel) pinLabel.textContent = pinned ? "Unpin" : "Pin";
    }
    menu.classList.remove("hidden");
    positionFixedMenu(menu, event.clientX, event.clientY);
  });

  document.getElementById("tab-list")?.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;

    const readingCard = target.closest(".reading-list-card") as HTMLElement | null;
    if (readingCard) {
      const url = readingCard.getAttribute("data-reading-list-url");
      if (url) {
        if (target.closest(".reading-list-remove-btn")) {
          event.stopPropagation();
          const removed = await removeReadingListItem(url);
          if (removed) {
            showToast("Removed from Reading List");
            await loadReadingList();
            render();
          } else {
            showToast("Failed to remove item from Reading List");
          }
          return;
        }
        if (target.closest(".reading-list-open-btn")) {
          event.stopPropagation();
          await browser.tabs.create({ url, active: true });
          return;
        }
      }
    }

    if (target.closest(".section-collapse-toggle")) {
      const btn = target.closest(".section-collapse-toggle") as HTMLElement;
      const key = btn.dataset.sectionCollapse;
      if (key) {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        applySectionCollapseDom(key, collapsedGroups.has(key));
        lastTabListFingerprint = tabListStructureFingerprint();
      }
      return;
    }

    if (target.closest(".nested-group-toggle") && !target.closest(".nested-group-selection-toggle")) {
      const tg = target.closest(".nested-group-toggle") as HTMLElement;
      const key = tg.dataset.nestedGroup;
      if (key) {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        applyNestedGroupCollapseDom(key, collapsedGroups.has(key));
        lastTabListFingerprint = tabListStructureFingerprint();
      }
      return;
    }

    const sessionRow = target.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && selectedSession) {
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (url != null) {
        if (target.closest(".session-remove-btn")) {
          event.stopPropagation();
          const tab = (selectedSession.tabs ?? []).find((sessionTab) => sessionTabMatchesUrl(sessionTab, url));
          const title = tab?.title ?? "this video";
          const confirmed = await showConfirm({
            title: "Remove from session",
            message: `Remove "${title}" from "${selectedSession.name}"?`,
            confirmLabel: "Remove",
            confirmDanger: true,
          });
          if (!confirmed) return;
          const newTabs = (selectedSession.tabs ?? []).filter((sessionTab) => !sessionTabMatchesUrl(sessionTab, url));
          await updateSessionTabs(selectedSession.id, newTabs);
          selectedSession.tabs = newTabs;
          selectedSessionTabUrls.delete(url);
          refreshSavedSessionsSidebar();
          updateSelectionUI();
          render();
          return;
        }
        if (target.closest(".session-selection-toggle")) {
          event.stopPropagation();
          if (selectedSessionTabUrls.has(url)) selectedSessionTabUrls.delete(url);
          else selectedSessionTabUrls.add(url);
          updateSelectionUI();
          return;
        }
        if (target.closest(".session-open-new-tab")) {
          event.stopPropagation();
          openSessionVideoInNewTab(url);
          return;
        }
        if (target.closest(".session-video-click-target")) {
          event.stopPropagation();
          if (selectedSessionTabUrls.size > 0) {
            if (selectedSessionTabUrls.has(url)) selectedSessionTabUrls.delete(url);
            else selectedSessionTabUrls.add(url);
            updateSelectionUI();
            return;
          }
          void openOrFocusSessionVideo(url);
          return;
        }
      }
      return;
    }

    const row = target.closest("[data-id]") as HTMLElement | null;
    const id = row ? parseInt(row.dataset.id || "0", 10) : 0;

    const chapterItem = target.closest(".video-chapter-item") as HTMLElement | null;
    if (chapterItem) {
      event.stopPropagation();
      const videoId = parseInt(chapterItem.dataset.videoId || "", 10);
      const startSeconds = parseInt(chapterItem.dataset.time || "0", 10);
      const video = allVideos.find((candidate) => candidate.id === videoId);
      if (video) {
        const rawUrl = video.url.split("&t=")[0].split("?t=")[0];
        const separator = rawUrl.includes("?") ? "&" : "?";
        const targetUrl = `${rawUrl}${separator}t=${startSeconds}`;
        await browser.tabs.update(video.id, { url: targetUrl, active: true });
        if (video.windowId !== undefined) {
          await browser.windows.update(video.windowId, { focused: true });
        }
      }
      return;
    }

    const chapterToggle = target.closest(".video-chapters-toggle") as HTMLElement | null;
    if (chapterToggle) {
      event.stopPropagation();
      const container = chapterToggle.closest(".video-chapters-container");
      const list = container?.querySelector(".video-chapters-list");
      if (list) {
        list.classList.toggle("hidden");
        const isExpanded = !list.classList.contains("hidden");
        const arrow = chapterToggle.querySelector(".chapter-toggle-arrow");
        if (arrow) {
          arrow.textContent = isExpanded ? "▼" : "▶";
        }
      }
      return;
    }

    if (target.closest(".selection-toggle")) {
      event.stopPropagation();
      if (selectedTabIds.has(id)) selectedTabIds.delete(id);
      else selectedTabIds.add(id);
      updateSelectionUI();
      return;
    }
    if (target.closest(".jump-btn")) {
      event.stopPropagation();
      const video = allVideos.find((candidate) => candidate.id === id);
      if (video) {
        await focusLiveVideoTab(video);
      }
      return;
    }
    if (target.closest(".close-btn")) {
      event.stopPropagation();
      await browser.tabs.remove(id);
      row?.remove();
      allVideos = allVideos.filter((video) => video.id !== id);
      for (const group of windowGroups) {
        group.tabs = group.tabs.filter((video) => video.id !== id);
        group.duration = group.tabs.reduce((accumulator, video) => accumulator + video.seconds, 0);
      }
      windowGroups = windowGroups.filter((group) => group.tabs.length > 0);
      lastTabListFingerprint = tabListStructureFingerprint();
      renderSidebar();
      updateSelectionUI();
      return;
    }
    if (target.closest(".video-click-target")) {
      event.stopPropagation();
      if (selectedTabIds.size > 0) {
        if (selectedTabIds.has(id)) selectedTabIds.delete(id);
        else selectedTabIds.add(id);
        updateSelectionUI();
        return;
      }
      const video = allVideos.find((candidate) => candidate.id === id);
      if (video) await focusLiveVideoTab(video);
      return;
    }
    if (target.closest(".nested-group-selection-toggle")) {
      event.stopPropagation();
      const el = target.closest(".nested-group-selection-toggle") as HTMLElement;
      const scopeId = el.dataset.nestedGroupScope;
      const groupName = el.dataset.nestedGroupName;
      if (!scopeId || !groupName) return;
      if (selectedSession) {
        const secs = orderedSections(selectedSession.sections);
        const inSection = (tab: SavedSessionTab) => {
          if (scopeId === "__unsorted") return !sessionTabSectionId(tab, secs);
          return sessionTabSectionId(tab, secs) === scopeId;
        };
        const groupTabs = (selectedSession.tabs ?? []).filter((t) => {
          if (!inSection(t)) return false;
          if (groupingMode === "channel") {
            return (t.channelName ?? "Unknown Channel") === groupName;
          } else if (groupingMode === "language") {
            const stripped = t.languageName ? t.languageName.split('(')[0].trim() : "";
            const langName = stripped ? stripped : (t.language ? t.language.toUpperCase() : "Unspecified");
            return langName === groupName;
          }
          return false;
        });
        const urls = groupTabs.map((t) => t.url ?? "").filter(Boolean);
        const allSelected = urls.length > 0 && urls.every((u) => selectedSessionTabUrls.has(u));
        urls.forEach((u) => {
          if (allSelected) selectedSessionTabUrls.delete(u);
          else selectedSessionTabUrls.add(u);
        });
      } else {
        let scopeVideos = allVideos;
        if (currentWindowId !== "all") {
          scopeVideos = allVideos.filter((video) => video.windowId === currentWindowId);
        }
        const groupVideos = scopeVideos.filter((v) => {
          const sid = liveSectionIdForVideo(v);
          const inSec = scopeId === "__unsorted" ? sid === undefined : sid === scopeId;
          if (!inSec) return false;
          if (groupingMode === "channel") {
            return (v.channelName || "Unknown Channel") === groupName;
          } else if (groupingMode === "language") {
            const stripped = v.languageName ? v.languageName.split('(')[0].trim() : "";
            const langName = stripped ? stripped : (v.language ? v.language.toUpperCase() : "Unspecified");
            return langName === groupName;
          }
          return false;
        });
        const allSelected =
          groupVideos.length > 0 && groupVideos.every((v) => selectedTabIds.has(v.id));
        groupVideos.forEach((v) => {
          if (allSelected) selectedTabIds.delete(v.id);
          else selectedTabIds.add(v.id);
        });
      }
      updateSelectionUI();
      return;
    }
    const groupToggle = target.closest(".group-toggle");
    if (groupToggle) {
      const groupName = (groupToggle as HTMLElement).dataset.group;
      if (groupName) {
        if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
        else collapsedGroups.add(groupName);
        applyFlatChannelGroupCollapseDom(groupName, collapsedGroups.has(groupName));
        lastTabListFingerprint = tabListStructureFingerprint();
      }
      return;
    }
    if (target.closest(".group-selection-toggle")) {
      event.stopPropagation();
      const groupEl = target.closest("[data-group]") as HTMLElement;
      const groupName = groupEl?.dataset.group;
      if (groupName) {
        let scopeVideos = allVideos;
        if (currentWindowId !== "all") {
          scopeVideos = allVideos.filter((video) => video.windowId === currentWindowId);
        }
        const videosInGroup = scopeVideos.filter((video) => {
          if (groupingMode === "channel") {
            return (video.channelName || "Unknown Channel") === groupName;
          } else if (groupingMode === "language") {
            const stripped = video.languageName ? video.languageName.split('(')[0].trim() : "";
            const langName = stripped ? stripped : (video.language ? video.language.toUpperCase() : "Unspecified");
            return langName === groupName;
          }
          return false;
        });
        const allSelected = videosInGroup.every((video) => selectedTabIds.has(video.id));
        videosInGroup.forEach((video) => {
          if (allSelected) selectedTabIds.delete(video.id);
          else selectedTabIds.add(video.id);
        });
        updateSelectionUI();
      }
    }
  });

  document.getElementById("tab-list")?.addEventListener("dragstart", (e) => {
    const t = e.target as HTMLElement;
    if (
      t.closest(
        "button, input, .session-selection-toggle, .selection-toggle, .session-open-new-tab, .session-remove-btn, .jump-btn, .close-btn, .nested-group-selection-toggle, .nested-group-toggle, .group-toggle, .section-collapse-toggle"
      )
    ) {
      e.preventDefault();
      return;
    }
    const sessionRow = t.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && selectedSession) {
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (!url) return;
      e.dataTransfer?.setData(TAB_MANAGER_DRAG_MIME, JSON.stringify({ kind: "session", url }));
      e.dataTransfer!.effectAllowed = "move";
      sessionRow.classList.add("tab-card-dragging");
      return;
    }
    const liveRow = t.closest("[data-id]") as HTMLElement | null;
    if (liveRow && !selectedSession) {
      const id = parseInt(liveRow.dataset.id || "0", 10);
      if (Number.isNaN(id)) return;
      e.dataTransfer?.setData(TAB_MANAGER_DRAG_MIME, JSON.stringify({ kind: "live", tabId: id }));
      e.dataTransfer!.effectAllowed = "move";
      liveRow.classList.add("tab-card-dragging");
    }
    if (document.querySelector(".tab-card-dragging")) document.body.classList.add("is-dragging");
  });

  document.getElementById("tab-list")?.addEventListener("dragend", () => {
    document.querySelectorAll(".tab-card-dragging").forEach((el) => el.classList.remove("tab-card-dragging"));
    document.body.classList.remove("is-dragging");
    clearSectionDropHighlight();
  });

  const dropRoots = [document.getElementById("tab-list"), document.getElementById("facet-rail")];

  dropRoots.forEach((root) => root?.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MANAGER_DRAG_MIME)) return;
    const zone = (e.target as HTMLElement).closest("[data-section-wrapper]");
    setSectionDropHighlight(zone as HTMLElement | null);
    if (zone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }));

  dropRoots.forEach((root) => root?.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MANAGER_DRAG_MIME)) return;
    const zone = (e.target as HTMLElement).closest("[data-section-wrapper]");
    e.preventDefault();
    clearSectionDropHighlight();
    if (!zone) return;
    const raw = e.dataTransfer.getData(TAB_MANAGER_DRAG_MIME);
    const payload = parseTabManagerDrag(raw);
    if (!payload) return;
    const sectionKey = zone.getAttribute("data-section-wrapper");
    const targetSectionId = sectionKey === "__unsorted" || sectionKey == null ? null : sectionKey;

    if (payload.kind === "session") {
      if (!selectedSession) return;
      const secs = orderedSections(selectedSession.sections);
      const tab = (selectedSession.tabs ?? []).find((x) => (x.url ?? "") === payload.url);
      const cur = tab ? sessionTabSectionId(tab, secs) : undefined;
      const curNorm = cur ?? null;
      const tgtNorm = targetSectionId ?? null;
      if (curNorm === tgtNorm) return;
      await moveSessionTabsToSection([payload.url], targetSectionId);
    } else {
      if (selectedSession) return;
      const video = allVideos.find((v) => v.id === payload.tabId);
      if (!video) return;
      const cur = liveSectionIdForVideo(video);
      const curNorm = cur ?? null;
      const tgtNorm = targetSectionId ?? null;
      if (curNorm === tgtNorm) return;
      await moveLiveVideosToSection([payload.tabId], targetSectionId);
    }
  }));

  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  const searchClearBtn = document.getElementById("search-clear-btn") as HTMLButtonElement | null;

  function updateSearchClearBtnVisibility() {
    if (searchInput && searchClearBtn) {
      searchClearBtn.classList.toggle("hidden", searchInput.value === "");
    }
  }

  searchInput?.addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value;
    updateSearchClearBtnVisibility();
    if (searchDebounceTimeout != null) clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
      searchDebounceTimeout = null;
      searchQuery = value;
      render();
    }, SEARCH_DEBOUNCE_MS);
  });

  document.getElementById("tab-list")?.addEventListener("click", (event) => {
    if ((event.target as Element).closest('[data-empty-action="clear-search"]')) searchClearBtn?.click();
  });

  searchClearBtn?.addEventListener("click", () => {
    if (searchInput) {
      searchInput.value = "";
      updateSearchClearBtnVisibility();
    }
    if (searchDebounceTimeout != null) clearTimeout(searchDebounceTimeout);
    searchQuery = "";
    render();
  });

  document.getElementById("view-list")?.addEventListener("click", () => {
    groupingMode = "none";
    saveSettings();
    render();
  });
  document.getElementById("view-channel")?.addEventListener("click", () => {
    groupingMode = "channel";
    saveSettings();
    render();
  });
  document.getElementById("view-language")?.addEventListener("click", () => {
    groupingMode = "language";
    saveSettings();
    render();
  });

  document.getElementById("layout-list")?.addEventListener("click", () => {
    layoutMode = "list";
    saveSettings();
    render();
  });
  document.getElementById("layout-grid")?.addEventListener("click", () => {
    layoutMode = "grid";
    saveSettings();
    render();
  });

  document.getElementById("btn-filter-duplicates")?.addEventListener("click", () => {
    if (showDuplicatesOnly) {
      showDuplicatesOnly = false;
    } else {
      const summary = summarizeDuplicates(scopeVideoIdCounts);
      if (summary.duplicateVideoCount === 0) return;
      showDuplicatesOnly = true;
    }
    render();
  });

  document.getElementById("btn-save-session")?.addEventListener("click", async () => {
    await saveVideosAsSession(allVideos);
  });

  document.getElementById("select-all-checkbox")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const inSessionView = selectedSession != null;
    const tabElements = document.querySelectorAll("#tab-list [data-session-tab-url]");
    const idElements = document.querySelectorAll("#tab-list [data-id]");
    const visibleUrls = inSessionView ? Array.from(tabElements).map((el) => (el as HTMLElement).getAttribute("data-session-tab-url")!) : [];
    const visibleIds = inSessionView ? [] : Array.from(idElements).map((el) => parseInt((el as HTMLElement).dataset.id || "0", 10));
    const checkbox = document.getElementById("select-all-checkbox") as HTMLInputElement;
    const allSelected = inSessionView
      ? visibleUrls.every((url) => selectedSessionTabUrls.has(url))
      : visibleIds.every((id) => selectedTabIds.has(id));
    if (allSelected) {
      if (inSessionView) visibleUrls.forEach((url) => selectedSessionTabUrls.delete(url));
      else visibleIds.forEach((id) => selectedTabIds.delete(id));
    } else {
      if (inSessionView) visibleUrls.forEach((url) => selectedSessionTabUrls.add(url));
      else visibleIds.forEach((id) => selectedTabIds.add(id));
    }
    updateSelectionUI();
  });

  document.getElementById("ctx-save")?.addEventListener("click", async () => {
    const context = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (!context || (context.type !== "all" && context.type !== "window")) return;
    const videosToSave =
      context.type === "all" ? allVideos : allVideos.filter((video) => video.windowId === context.windowId);
    const windowLabel =
      context.type === "window"
        ? windowGroups.find((g) => g.id === context.windowId)?.label
        : undefined;
    await saveVideosAsSession(videosToSave, windowLabel);
  });

  document.getElementById("ctx-add-to-session")?.addEventListener("click", async () => {
    const context = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const liveSecs = orderedSections(liveTabSectionsState.sections);
    const { tabs, sections } = buildTabsFromVideos(
      allVideos,
      liveTabSectionsState.assignments,
      liveSecs,
      { excludeHidden: true }
    );
    if (tabs.length === 0) {
      showToast("No YouTube tabs to add.");
      return;
    }
    const sessions = await getSavedSessions();
    const session = sessions.find((s) => s.id === context.sessionId);
    if (!session) return;
    const confirmed = await showConfirm({
      title: "Add to session",
      message: `Add ${tabs.length} tab${tabs.length === 1 ? "" : "s"} to "${session.name}"?`,
      confirmLabel: "Add",
    });
    if (!confirmed) return;
    try {
      const merged = await mergeIntoSession(context.sessionId, tabs, sections.length > 0 ? sections : undefined);
      lastSavedSessionsFingerprint = "";
      await refreshSavedSessionsSidebar();
      if (selectedSession?.id === context.sessionId) await reloadSelectedSessionFromStorage();
      showToast(merged ? `Added tabs to "${merged.name}"` : "Could not update session.");
      render();
    } catch (error) {
      console.error("Add to session failed:", error);
      showToast(error instanceof Error ? error.message : "Could not add tabs.");
    }
  });

  document.getElementById("ctx-duplicate-session")?.addEventListener("click", async () => {
    const context = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const sessions = await getSavedSessions();
    const session = sessions.find((s) => s.id === context.sessionId);
    if (!session) return;
    try {
      const copy = await duplicateSession(context.sessionId);
      lastSavedSessionsFingerprint = "";
      await refreshSavedSessionsSidebar();
      showToast(copy ? `Duplicated as "${copy.name}"` : "Could not duplicate session.");
    } catch (error) {
      console.error("Duplicate session failed:", error);
      showToast(error instanceof Error ? error.message : "Could not duplicate session.");
    }
  });

  document.getElementById("ctx-open-tabs")?.addEventListener("click", async () => {
    const context = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type === "session" && context.sessionId) {
      await loadSessionInNewWindow(context.sessionId);
    }
  });

  document.getElementById("ctx-rename-session")?.addEventListener("click", async () => {
    const context = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const sessions = await getSavedSessions();
    const session = sessions.find((saved) => saved.id === context.sessionId);
    if (!session) return;
    const name = await showNameSessionModal(session.name, "Rename session");
    if (name === null) return;
    const trimmed = name.trim();
    const nextName = trimmed.length > 0 ? trimmed : "Untitled";
    if (nextName === session.name) return;
    try {
      await renameSession(context.sessionId, nextName);
      await reloadSelectedSessionFromStorage();
      await refreshSavedSessionsSidebar();
      showToast(`Renamed to "${nextName}"`);
      render();
    } catch (error) {
      console.error("Rename session failed:", error);
      showToast("Could not rename session.");
    }
  });

  document.getElementById("ctx-pin")?.addEventListener("click", async () => {
    const context = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const sessions = await getSavedSessions();
    const session = sessions.find((saved) => saved.id === context.sessionId);
    if (!session) return;
    await setSessionPinned(context.sessionId, !session.pinned);
    lastSavedSessionsFingerprint = "";
    refreshSavedSessionsSidebar();
  });

  document.getElementById("ctx-delete")?.addEventListener("click", async () => {
    const context = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const confirmed = await showConfirm({
      title: "Delete session",
      message: "Delete this saved session?",
      confirmLabel: "Delete",
      confirmDanger: true,
    });
    if (confirmed) {
      const deletedId = context.sessionId;
      await deleteSession(deletedId);
      if (selectedSession?.id === deletedId) {
        selectedSession = null;
        selectedSessionTabUrls.clear();
        currentWindowId = "all";
        render();
      }
      lastSavedSessionsFingerprint = "";
      refreshSavedSessionsSidebar();
    }
  });

  document.getElementById("session-sidebar-search")?.addEventListener("input", (event) => {
    sessionSidebarSearch = (event.target as HTMLInputElement).value;
    lastSavedSessionsFingerprint = "";
    void refreshSavedSessionsSidebar();
  });
  document.getElementById("session-sidebar-search")?.addEventListener("keydown", (event) => {
    const input = event.target as HTMLInputElement;
    if (event.key !== "Escape" || input.value === "") return;
    event.stopPropagation();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  function openTabSectionContextMenu(
    clientX: number,
    clientY: number,
    target: { mode: "session"; url: string } | { mode: "live"; tabId: number }
  ) {
    tabSectionContextTarget = target;
    const menu = document.getElementById("tab-section-context-menu");
    const items = document.getElementById("tab-section-context-items");
    if (!menu || !items) return;
    const sections = currentSectionsForMove();
    if (sections.length === 0) {
      items.innerHTML = `<div class="px-3 py-2.5 text-[11px] text-text-muted leading-relaxed">Create a pile with <span class="text-text-secondary font-medium">New pile</span> first.</div>`;
    } else {
      items.innerHTML = renderSectionPickerRows(sections);
    }
    positionFixedMenu(menu, clientX, clientY);
  }

  document.getElementById("btn-add-section")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openAddSectionModal();
  });

  document.getElementById("btn-collapse-all")?.addEventListener("click", () => {
    const keys = new Set<string>();
    document.querySelectorAll("button[data-section-collapse]").forEach((element) => {
      const value = (element as HTMLElement).dataset.sectionCollapse;
      if (value) {
        keys.add(value);
      }
    });
    document.querySelectorAll("button[data-nested-group]").forEach((element) => {
      const value = (element as HTMLElement).dataset.nestedGroup;
      if (value) {
        keys.add(value);
      }
    });
    document.querySelectorAll("button.group-toggle").forEach((element) => {
      const value = (element as HTMLElement).dataset.group;
      if (value) {
        keys.add(value);
      }
    });

    let allCollapsed = true;
    for (const key of keys) {
      if (!collapsedGroups.has(key)) {
        allCollapsed = false;
        break;
      }
    }

    if (allCollapsed) {
      collapsedGroups.clear();
    } else {
      for (const key of keys) {
        collapsedGroups.add(key);
      }
    }
    render();
  });

  document.getElementById("add-section-close")?.addEventListener("click", () => closeAddSectionModal());
  document.getElementById("add-section-modal")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "add-section-modal") closeAddSectionModal();
  });

  document.getElementById("add-section-presets")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest(".section-preset-btn") as HTMLElement | null;
    if (!b) return;
    const name = b.dataset.presetName;
    const emoji = b.dataset.presetEmoji;
    const color = parseInt(b.dataset.presetColor || "0", 10);
    if (!name) return;
    closeAddSectionModal();
    void addNewSection(name, emoji || undefined, color);
  });

  document.getElementById("add-section-custom-submit")?.addEventListener("click", () => {
    const input = document.getElementById("add-section-custom") as HTMLInputElement | null;
    const v = input?.value?.trim();
    if (!v) return;
    closeAddSectionModal();
    const n = selectedSession
      ? orderedSections(selectedSession.sections).length
      : orderedSections(liveTabSectionsState.sections).length;
    void addNewSection(v, undefined, n % SECTION_RAIL_VARS.length);
  });

  document.getElementById("add-section-custom")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (document.getElementById("add-section-custom-submit") as HTMLButtonElement | null)?.click();
    }
  });

  document.getElementById("btn-move-to-section")?.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("move-to-section-popover")?.classList.toggle("hidden");
  });

  document.getElementById("move-to-section-popover")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const button = (event.target as HTMLElement).closest("[data-ctx-section-id], [data-move-section-id]") as HTMLElement | null;
    if (!button) return;
    const raw = button.getAttribute("data-ctx-section-id") ?? button.getAttribute("data-move-section-id");
    void moveSelectionToSection(raw === "" || raw === null ? null : raw);
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  });

  document.getElementById("move-to-section-wrap")?.addEventListener("click", (event) => event.stopPropagation());

  document.getElementById("tab-section-context-items")?.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest("[data-ctx-section-id]") as HTMLElement | null;
    if (!button || !tabSectionContextTarget) return;
    const raw = button.getAttribute("data-ctx-section-id");
    const sectionId = raw === "" || raw === null ? null : raw;
    const currentTarget = tabSectionContextTarget;
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    tabSectionContextTarget = null;
    if (currentTarget.mode === "session") {
      await moveSessionTabsToSection([currentTarget.url], sectionId);
    } else {
      await moveLiveVideosToSection([currentTarget.tabId], sectionId);
    }
  });

  document.getElementById("section-ctx-rename")?.addEventListener("click", async () => {
    const targetContext = sectionHeaderContextTarget;
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    if (!targetContext) return;
    const sections = currentSectionsForMove();
    const section = sections.find((s) => s.id === targetContext.sectionId);
    if (!section) return;
    const name = await showNameSessionModal(section.name, "Rename section");
    if (name === null) return;
    await renameSectionById(targetContext.sectionId, name);
    sectionHeaderContextTarget = null;
  });

  document.getElementById("section-ctx-delete")?.addEventListener("click", async () => {
    const targetContext = sectionHeaderContextTarget;
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    if (!targetContext) return;
    sectionHeaderContextTarget = null;
    const sections = currentSectionsForMove();
    const section = sections.find((s) => s.id === targetContext.sectionId);
    const confirmed = await showConfirm({
      title: "Delete pile",
      message: `Delete “${section?.name ?? "pile"}”? Its videos stay on the desk, just not in a pile.`,
      confirmLabel: "Delete",
      confirmDanger: true,
    });
    if (confirmed) await deleteSectionById(targetContext.sectionId);
  });

  document.getElementById("tab-list")?.addEventListener("contextmenu", (event) => {
    const t = event.target as HTMLElement;
    const sessionRow = t.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && selectedSession) {
      event.preventDefault();
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (url) openTabSectionContextMenu(event.clientX, event.clientY, { mode: "session", url });
      return;
    }
    const liveRow = t.closest("[data-id]") as HTMLElement | null;
    if (liveRow && !selectedSession) {
      event.preventDefault();
      const id = parseInt(liveRow.dataset.id || "0", 10);
      if (!Number.isNaN(id)) openTabSectionContextMenu(event.clientX, event.clientY, { mode: "live", tabId: id });
      return;
    }
    const titleTarget = t.closest(".section-title-target") as HTMLElement | null;
    const sid = titleTarget?.dataset.sectionId;
    if (sid && t.closest(".session-section-shell")) {
      event.preventDefault();
      sectionHeaderContextTarget = { sectionId: sid };
      const menu = document.getElementById("section-header-context-menu");
      if (menu) positionFixedMenu(menu, event.clientX, event.clientY);
    }
  });

  document.getElementById("tab-list")?.addEventListener("dblclick", async (event) => {
    const titleEl = (event.target as HTMLElement).closest(".section-title-target") as HTMLElement | null;
    const sid = titleEl?.dataset.sectionId;
    if (!sid) return;
    event.preventDefault();
    const sections = currentSectionsForMove();
    const sec = sections.find((s) => s.id === sid);
    if (!sec) return;
    const name = await showNameSessionModal(sec.name, "Rename section");
    if (name === null) return;
    await renameSectionById(sid, name);
  });

  document.addEventListener("click", () => {
    closeAllCustomSelects();
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  });
  document.getElementById("sidebar-context-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.getElementById("tab-section-context-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.getElementById("section-header-context-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("contextmenu", () => {
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeAllCustomSelects();
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  });

  document.getElementById("btn-settings")?.addEventListener("click", () => {
    isSettingsOpen = true;
    render();
  });
  const closeSettings = () => {
    if (!isSettingsOpen) return;
    isSettingsOpen = false;
    render();
    document.getElementById("btn-settings")?.focus();
  };
  document.getElementById("close-settings")?.addEventListener("click", closeSettings);
  document.getElementById("settings-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isSettingsOpen && !document.querySelector("#confirm-modal:not(.hidden)")) closeSettings();
  });

  document.getElementById("quality-standard")?.addEventListener("click", () => {
    thumbnailQuality = "standard";
    saveSettings();
    render();
  });

  document.getElementById("quality-high")?.addEventListener("click", () => {
    thumbnailQuality = "high";
    saveSettings();
    render();
  });

  document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
    const confirmed = await showConfirm({
      title: "Clear video details?",
      message: "Saved titles and lengths are forgotten and load again from open tabs. Sessions, history and settings stay.",
      confirmLabel: "Clear",
      confirmDanger: true,
    });
    if (confirmed) {
      await clearCache();
      storeState.metadataCache = {};
      await fetchTabs();
      isSettingsOpen = false;
      document.getElementById("settings-modal")?.classList.add("hidden");
    }
  });

  document.getElementById("btn-export-sessions")?.addEventListener("click", async () => {
    try {
      const json = await exportSessionsJson();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `youtube-tab-sessions-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast("Sessions exported.");
    } catch (error) {
      console.error("Export failed:", error);
      showToast("Could not export sessions.");
    }
  });

  document.getElementById("import-sessions-file")?.addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const merge = await showConfirm({
        title: "Import sessions",
        message: "Merge imported sessions with your existing saved sessions?",
        confirmLabel: "Merge",
        cancelLabel: "Not now",
      });
      if (!merge) {
        const replace = await showConfirm({
          title: "Replace all sessions?",
          message: "Replace every saved session with only the sessions from this file? This cannot be undone.",
          confirmLabel: "Replace all",
          confirmDanger: true,
        });
        if (!replace) return;
        const count = await importSessionsJson(text, "replace");
        lastSavedSessionsFingerprint = "";
        await refreshSavedSessionsSidebar();
        showToast(`Replaced with ${count} imported session${count === 1 ? "" : "s"}.`);
        return;
      }
      const count = await importSessionsJson(text, "merge");
      lastSavedSessionsFingerprint = "";
      await refreshSavedSessionsSidebar();
      showToast(`Imported ${count} session${count === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("Import failed:", error);
      showToast(error instanceof Error ? error.message : "Could not import sessions.");
    }
  });

  document.getElementById("btn-perf-refresh")?.addEventListener("click", async () => {
    const container = document.getElementById("dev-perf-list");
    if (!container) return;
    container.innerHTML = "<span class='text-text-muted/70'>Fetching…</span>";
    const rows: string[] = [];
    for (const video of allVideos) {
      try {
        const stats = await browser.tabs.sendMessage(video.id, { action: "get-perf-stats" }) as {
          totalMutations?: number;
          totalReads?: number;
          ratio?: string;
          debounceMs?: number;
        } | undefined;
        if (stats && typeof stats.totalMutations === "number") {
          const title = video.title.slice(0, 20) + (video.title.length > 20 ? "…" : "");
          rows.push(`Tab ${video.id} · ${title} · mut: ${stats.totalMutations} read: ${stats.totalReads ?? "—"} ratio: ${stats.ratio ?? "—"}`);
        } else {
          rows.push(`Tab ${video.id} · (no content script)`);
        }
      } catch {
        rows.push(`Tab ${video.id} · (unavailable)`);
      }
    }
    if (rows.length === 0) {
      container.innerHTML = "<span class='text-text-muted/70'>No YouTube tabs open</span>";
    } else {
      container.innerHTML = rows.map((row) => `<div class="truncate" title="${row}">${row}</div>`).join("");
    }
  });
}

/* ───────────────────────── Time: where the week went ───────────────────────── */

let timeRange: 7 | 30 | 90 = 7;
let lastTimeResponse: TimeSummaryResponse | null = null;
let timePanelWired = false;
let showAllChannels = false;
let openChannel: string | null = null;
let channelLanguageFilter: string | null = null;
let videoRowsShown = 0;
let newRuleKind: "goal" | "limit" = "goal";
let ruleSaveTimer: ReturnType<typeof setTimeout> | null = null;
const RULE_SAVE_DELAY_MS = 600;

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const TIME_RANGES = [7, 30, 90] as const;
const CHANNEL_ROWS = 8;
const VIDEO_ROWS_PAGE = 20;
const CHANNEL_TOOLTIP_TITLES = 10;
const HEAT_LEVELS = 5;

const TRASH_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
const CHEVRON_RIGHT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-text-muted transition-transform" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>`;

function dayLetter(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return DAY_LETTERS[new Date(year, month - 1, day).getDay()];
}

function longDate(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function timeAgoWords(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function hourWords(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, { hour: "numeric" });
}

function shareWords(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

function speedWords(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, "")}×`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function timeSectionHeading(title: string, extra = ""): string {
  return `<div class="flex items-center gap-3 flex-wrap"><h2 class="font-display text-[22px] font-medium m-0 flex-1">${escapeHtml(title)}</h2>${extra}</div>`;
}

function watchStatTile(label: string, value: string, note: string): string {
  return `<div class="flex flex-col gap-0.5 min-w-0 rounded-[10px] border border-border bg-surface-elevated px-4 py-3">
    <span class="text-[11px] uppercase tracking-[0.1em] text-text-muted">${escapeHtml(label)}</span>
    <span class="font-display text-[26px] leading-tight text-text-primary tabular-nums truncate">${escapeHtml(value)}</span>
    <span class="text-xs text-text-muted truncate min-h-4">${escapeHtml(note)}</span>
  </div>`;
}

function languageDot(color: string): string {
  return `<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>`;
}

/** One colour per language for the whole page, in the order of time spent, so charts and lists agree. */
function languageColorMap(watch: WatchSummary): Map<string, string> {
  const colors = new Map<string, string>();
  watch.byLanguage.forEach((row, index) => colors.set(row.label, row.label === UNKNOWN_LANGUAGE ? "var(--color-border-hover)" : FACET_PALETTE[index % FACET_PALETTE.length]));
  return colors;
}

function colorOfLanguage(colors: Map<string, string>, label: string): string {
  return colors.get(label) ?? "var(--color-border-hover)";
}

function watchVideoRowHtml(video: WatchVideoRow, colors: Map<string, string>): string {
  const url = video.isShort ? `https://www.youtube.com/shorts/${encodeURIComponent(video.videoId)}` : `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}`;
  const progress = video.isLive ? "Live" : video.durationSeconds > 0 ? shareWords(video.coverage, 1) : "";
  const speed = video.playedSeconds > 0 ? video.videoSeconds / video.playedSeconds : 1;
  const faster = !video.isLive && Math.abs(speed - 1) >= 0.05;
  return `<li class="grid grid-cols-[4rem_minmax(0,1fr)_3.5rem_3rem_5.5rem] items-center gap-3 min-w-0 text-sm">
    <img src="https://i.ytimg.com/vi/${encodeURIComponent(video.videoId)}/mqdefault.jpg" alt="" loading="lazy" class="w-16 h-9 rounded object-cover bg-surface-hover manager-card-thumb" />
    <span class="min-w-0 flex flex-col">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="truncate text-text-primary no-underline hover:text-accent" title="${escapeHtml(video.title || video.videoId)}">${escapeHtml(video.title || video.videoId)}</a>
      <span class="truncate text-xs text-text-muted flex items-center gap-1.5">${languageDot(colorOfLanguage(colors, video.language))}<span class="truncate">${escapeHtml([video.channelName, video.language, timeAgoWords(video.lastAt)].filter(Boolean).join(" · "))}</span></span>
    </span>
    <span class="justify-self-start">${faster ? `<span class="speed-chip" title="${escapeHtml(`${formatMinutesWords(video.videoSeconds)} of video in ${formatMinutesWords(video.playedSeconds)}`)}">${speedWords(speed)}</span>` : ""}</span>
    <span class="text-right text-xs text-text-muted tabular-nums" title="${video.durationSeconds > 0 ? `Of ${formatMinutesWords(video.durationSeconds)}` : ""}">${progress}</span>
    <span class="text-right text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(video.playedSeconds)}</span>
  </li>`;
}

function channelLetterHtml(letter: string, size = "w-5 h-5 text-[10px]"): string {
  return `<span class="ui-avatar ${size}" aria-hidden="true">${escapeHtml(letter)}</span>`;
}

function channelAvatarHtml(channelName: string, avatarUrl: string | null, size = "w-5 h-5 text-[10px]"): string {
  const letter = Array.from(channelName.trim())[0]?.toUpperCase() ?? "?";
  if (!avatarUrl) return channelLetterHtml(letter, size);
  return `<img src="${escapeHtml(avatarUrl)}" alt="" class="channel-avatar ui-avatar ${size}" loading="lazy" referrerpolicy="no-referrer" data-letter="${escapeHtml(letter)}" data-size="${escapeHtml(size)}">`;
}

function dayBarsHtml(watch: WatchSummary, colors: Map<string, string>): string {
  const peakDay = Math.max(60, ...watch.days.map((day) => day.seconds));
  const dense = watch.days.length > 30;
  const order = watch.byLanguage.map((row) => row.label);
  const bars = watch.days
    .map((day, index) => {
      const segments = order
        .filter((label) => (day.byLanguage[label] ?? 0) > 0)
        .map((label) => `<div class="w-full shrink-0 ${dense ? "" : "rounded-[3px]"}" style="height:${((day.byLanguage[label] / peakDay) * 100).toFixed(2)}%;background:${colorOfLanguage(colors, label)}"></div>`)
        .join("");
      const breakdown = order
        .filter((label) => (day.byLanguage[label] ?? 0) >= 60)
        .map((label) => `${label}: ${formatMinutesWords(day.byLanguage[label])}`);
      const tip = [`${longDate(day.key)}: ${formatMinutesWords(day.seconds)}`, ...breakdown].join("\n");
      const label = timeRange === 7 ? dayLetter(day.key) : !dense || index % 15 === 0 ? day.key.slice(dense ? 5 : 8) : "";
      return `<div class="flex flex-col items-center gap-1.5 min-w-0" title="${escapeHtml(tip)}">
        <div class="w-full h-40 flex flex-col-reverse ${dense ? "" : "gap-[2px]"} rounded-md bg-surface-elevated overflow-hidden">${segments}</div>
        <span class="text-[11px] text-text-muted tabular-nums whitespace-nowrap">${label || "&nbsp;"}</span>
        ${dense ? "" : `<span class="font-display text-[13px] text-text-secondary tabular-nums whitespace-nowrap">${day.seconds >= 60 ? formatMinutesWords(day.seconds) : "·"}</span>`}
      </div>`;
    })
    .join("");
  const legend = watch.byLanguage
    .map((row) => `<span class="flex items-center gap-1.5">${languageDot(colorOfLanguage(colors, row.label))}${escapeHtml(row.label)}</span>`)
    .join("");
  const busiest = watch.days.reduce((best, day) => (day.seconds > best.seconds ? day : best), watch.days[0]);
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("By day", busiest && busiest.seconds >= 60 ? `<span class="text-xs text-text-muted">Most on ${escapeHtml(longDate(busiest.key))}</span>` : "")}
    <div class="grid ${dense ? "gap-px" : "gap-2"}" style="grid-template-columns: repeat(${watch.days.length}, minmax(0, 1fr))">${bars}</div>
    <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">${legend}</div>
  </section>`;
}

function heatmapHtml(watch: WatchSummary): string {
  const peak = Math.max(...watch.byWeekdayHour.flat());
  if (peak <= 0) return "";
  let peakDay = 0;
  let peakHour = 0;
  watch.byWeekdayHour.forEach((hours, weekday) =>
    hours.forEach((seconds, hour) => {
      if (seconds === peak) {
        peakDay = weekday;
        peakHour = hour;
      }
    })
  );
  const hourLabels = Array.from({ length: 24 }, (_unused, hour) => `<span class="text-[10px] text-text-muted tabular-nums text-center">${hour % 3 === 0 ? escapeHtml(hourWords(hour)) : ""}</span>`).join("");
  const rows = watch.byWeekdayHour
    .map(
      (hours, weekday) =>
        `<span class="text-[11px] text-text-muted self-center">${WEEKDAY_NAMES[weekday]}</span>` +
        hours
          .map((seconds, hour) => {
            const level = seconds <= 0 ? 0 : Math.max(1, Math.ceil((seconds / peak) * (HEAT_LEVELS - 1)));
            return `<span class="heat-cell" data-level="${level}" title="${escapeHtml(`${WEEKDAY_NAMES[weekday]} ${hourWords(hour)}: ${formatMinutesWords(seconds)}`)}"></span>`;
          })
          .join("")
    )
    .join("");
  const legend = Array.from({ length: HEAT_LEVELS }, (_unused, level) => `<span class="heat-cell legend-swatch" data-level="${level}"></span>`).join("");
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("When you watch", `<span class="text-xs text-text-muted">Most on ${WEEKDAY_NAMES[peakDay]} around ${escapeHtml(hourWords(peakHour))}</span>`)}
    <div class="grid gap-[3px]" style="grid-template-columns: 2.5rem repeat(24, minmax(0, 1fr))"><span></span>${hourLabels}${rows}</div>
    <div class="flex items-center justify-end gap-1.5 text-[11px] text-text-muted">Less ${legend} More</div>
  </section>`;
}

function speedSectionHtml(watch: WatchSummary): string {
  const rows = watch.bySpeed.filter((row) => row.playedSeconds >= 60);
  if (rows.length === 0 || (rows.length === 1 && rows[0].rate === 1)) return "";
  const realTime = rows.reduce((sum, row) => sum + row.playedSeconds, 0);
  const videoTime = rows.reduce((sum, row) => sum + row.videoSeconds, 0);
  const longest = Math.max(...rows.map((row) => row.playedSeconds));
  const rowsHtml = rows
    .map(
      (row) => `<li class="grid grid-cols-[4rem_minmax(0,1fr)_6rem_9rem] items-center gap-3 text-sm">
        <span class="speed-chip justify-self-start${row.rate === 1 ? " speed-chip--plain" : ""}">${speedWords(row.rate)}</span>
        <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex"><span class="h-full rounded-full bg-accent" style="width:${Math.max(2, (row.playedSeconds / longest) * 100)}%;opacity:${(0.45 + Math.min(1, (row.rate - 0.75) / 1.25) * 0.55).toFixed(2)}"></span></span>
        <span class="text-right text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(row.playedSeconds)}</span>
        <span class="text-right text-xs text-text-muted tabular-nums whitespace-nowrap">${row.rate === 1 ? "" : `${formatMinutesWords(row.videoSeconds)} of video`}</span>
      </li>`
    )
    .join("");
  const saved = videoTime - realTime;
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Playback speed")}
    <p class="text-xs text-text-muted m-0">${formatMinutesWords(videoTime)} of video took ${formatMinutesWords(realTime)} of real time${saved >= 60 ? `, ${formatMinutesWords(saved)} saved by watching faster` : ""}. Goals, limits and every total here use real time.</p>
    <ul class="m-0 p-0 list-none flex flex-col gap-2">${rowsHtml}</ul>
  </section>`;
}

function channelsSectionHtml(watch: WatchSummary, colors: Map<string, string>): string {
  // The summary names channel-less videos "Unknown channel", so match it the same way.
  const videosByChannel = new Map<string, WatchVideoRow[]>();
  for (const video of watch.videos) {
    const name = video.channelName || "Unknown channel";
    videosByChannel.set(name, [...(videosByChannel.get(name) ?? []), video]);
  }
  const languages = [...new Set(watch.byChannel.map((channel) => channel.language))];
  if (channelLanguageFilter && !languages.includes(channelLanguageFilter)) channelLanguageFilter = null;
  const filtered = channelLanguageFilter ? watch.byChannel.filter((channel) => channel.language === channelLanguageFilter) : watch.byChannel;
  const shown = showAllChannels ? filtered : filtered.slice(0, CHANNEL_ROWS);
  const longest = filtered[0]?.seconds ?? 1;
  const rowsHtml = shown
    .map((channel, index) => {
      const open = openChannel === channel.channelName;
      const channelVideos = [...(videosByChannel.get(channel.channelName) ?? [])].sort((first, second) => second.playedSeconds - first.playedSeconds);
      const titles = channelVideos.slice(0, CHANNEL_TOOLTIP_TITLES).map((video) => `• ${video.title || video.videoId}`);
      if (channelVideos.length > CHANNEL_TOOLTIP_TITLES) titles.push(`and ${channelVideos.length - CHANNEL_TOOLTIP_TITLES} more`);
      const color = colorOfLanguage(colors, channel.language);
      return `<li class="border-b border-border/60">
        <button type="button" class="time-channel channel-row${open ? " channel-row--open" : ""}" data-channel="${escapeHtml(channel.channelName)}" aria-expanded="${open}" title="${escapeHtml(open ? "" : titles.join("\n"))}">
          <span class="font-display text-[15px] text-text-muted tabular-nums w-5 text-right">${index + 1}</span>
          ${channelAvatarHtml(channel.channelName, channel.avatarUrl, "w-8 h-8 text-xs")}
          <span class="min-w-0 flex flex-col text-left">
            <span class="truncate text-sm text-text-primary">${escapeHtml(channel.channelName)}</span>
            <span class="truncate text-xs text-text-muted flex items-center gap-1.5">${languageDot(color)}${escapeHtml(channel.language)} · ${plural(channel.videos, "video")}</span>
          </span>
          <span class="h-2 rounded-full overflow-hidden flex"><span class="h-full rounded-full" style="width:${Math.max(2, (channel.seconds / longest) * 100)}%;background:${color}"></span></span>
          <span class="text-right text-sm text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(channel.seconds)}</span>
          ${CHEVRON_RIGHT_ICON}
        </button>
        ${open ? `<ul class="m-0 list-none flex flex-col gap-2.5 pl-[4.25rem] pr-2 pt-1 pb-4">${channelVideos.map((video) => watchVideoRowHtml(video, colors)).join("")}</ul>` : ""}
      </li>`;
    })
    .join("");
  const filterHtml =
    languages.length > 1
      ? `<span class="flex flex-wrap gap-1.5" role="group" aria-label="Filter channels by language">
          <button type="button" class="time-channel-filter chip h-7 text-xs" data-language="" aria-pressed="${channelLanguageFilter === null}">All</button>
          ${languages
            .map(
              (language) =>
                `<button type="button" class="time-channel-filter chip h-7 text-xs" data-language="${escapeHtml(language)}" aria-pressed="${channelLanguageFilter === language}">${languageDot(colorOfLanguage(colors, language))}${escapeHtml(language)}</button>`
            )
            .join("")}
        </span>`
      : "";
  const hidden = filtered.length - CHANNEL_ROWS;
  const toggleHtml =
    hidden > 0 ? `<button type="button" id="time-channels-toggle" class="chip h-8 text-xs self-start">${showAllChannels ? `Show top ${CHANNEL_ROWS}` : `Show all ${filtered.length} channels`}</button>` : "";
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Channels", `<span class="text-xs text-text-muted tabular-nums">${watch.byChannel.length}</span>`)}
    ${filterHtml}
    <ul class="m-0 p-0 list-none flex flex-col">${rowsHtml}</ul>
    ${toggleHtml}
  </section>`;
}

function watchSectionsHtml(watch: WatchSummary, prefs: TimeTrackingPrefs): string {
  const total = watch.total;
  if (total.playedSeconds <= 0) {
    return `<p class="text-sm text-text-muted m-0">${prefs.watchHistory ? "Nothing watched yet." : "Watch history is off."}</p>`;
  }
  const colors = languageColorMap(watch);

  const speed = total.videoSeconds / total.playedSeconds;
  const saved = total.videoSeconds - total.playedSeconds;
  const background = Math.max(0, total.playedSeconds - total.visibleSeconds);
  const tilesHtml = [
    watchStatTile("Videos", String(total.videos), `${total.completed} finished`),
    watchStatTile("Speed", speedWords(speed), saved >= 60 ? `${formatMinutesWords(saved)} saved` : ""),
    watchStatTile("Subtitles", shareWords(total.captionSeconds, total.playedSeconds), formatMinutesWords(total.captionSeconds)),
    watchStatTile("Background", shareWords(background, total.playedSeconds), formatMinutesWords(background)),
    watchStatTile("Active days", `${total.activeDays} of ${watch.days.length}`, total.activeDays > 0 ? `${formatMinutesWords(total.playedSeconds / total.activeDays)} a day` : ""),
    watchStatTile("Ads", formatMinutesWords(total.adSeconds), ""),
  ].join("");

  const longestLanguage = watch.byLanguage[0]?.seconds ?? 1;
  const languagesHtml = watch.byLanguage
    .map(
      (row) => `<li class="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
        <span class="truncate font-medium text-text-primary flex items-center gap-2">${languageDot(colorOfLanguage(colors, row.label))}${escapeHtml(row.label)}</span>
        <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex"><span class="h-full rounded-full" style="width:${Math.max(2, (row.seconds / longestLanguage) * 100)}%;background:${colorOfLanguage(colors, row.label)}"></span></span>
        <span class="text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(row.seconds)} <span class="text-text-muted">· ${shareWords(row.seconds, total.playedSeconds)} · ${plural(row.videos, "video")}</span></span>
      </li>`
    )
    .join("");

  const shownVideos = Math.min(watch.videos.length, Math.max(videoRowsShown, VIDEO_ROWS_PAGE));
  const videosHtml = watch.videos.slice(0, shownVideos).map((video) => watchVideoRowHtml(video, colors)).join("");
  const moreVideos = Math.min(VIDEO_ROWS_PAGE * 2, watch.videos.length - shownVideos);
  const videosMoreHtml = moreVideos > 0 ? `<button type="button" id="time-videos-more" class="chip h-8 text-xs self-start" data-shown="${shownVideos}">Show ${moreVideos} more</button>` : "";

  return `
    <div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">${tilesHtml}</div>
    ${dayBarsHtml(watch, colors)}
    <section class="flex flex-col gap-3">
      ${timeSectionHeading("Languages")}
      <ul class="m-0 p-0 list-none flex flex-col gap-2">${languagesHtml}</ul>
    </section>
    ${heatmapHtml(watch)}
    ${speedSectionHtml(watch)}
    ${channelsSectionHtml(watch, colors)}
    <section class="flex flex-col gap-3">
      ${timeSectionHeading("Videos", `<span class="text-xs text-text-muted tabular-nums">${shownVideos < watch.videos.length ? `${shownVideos} of ${watch.videos.length}` : watch.videos.length}</span>`)}
      <ul class="m-0 p-0 list-none flex flex-col gap-2.5">${videosHtml}</ul>
      ${videosMoreHtml}
    </section>
  `;
}

function ruleStatusHtml(rule: LanguageLimitUsage): string {
  const target = rule.minutes * 60;
  if (isGoal(rule)) {
    return rule.usedSeconds >= target
      ? `<span class="text-success font-medium">✓ Done</span>`
      : `<span class="text-text-muted">${formatMinutesWords(target - rule.usedSeconds)} to go</span>`;
  }
  return rule.usedSeconds > target
    ? `<span class="text-danger font-medium">${formatMinutesWords(rule.usedSeconds - target)} over</span>`
    : `<span class="text-text-muted">${formatMinutesWords(target - rule.usedSeconds)} left</span>`;
}

function dailyRulesHtml(rules: LanguageLimitUsage[], watch: WatchSummary, prefs: TimeTrackingPrefs): string {
  const colors = languageColorMap(watch);
  // Goals first, as the things to do today; limits after.
  const ordered = [...rules].sort((first, second) => Number(isGoal(second)) - Number(isGoal(first)));
  const rowsHtml = ordered
    .map((rule) => {
      const share = Math.min(1, rule.usedSeconds / (rule.minutes * 60));
      const barColor = isGoal(rule)
        ? rule.level === "met"
          ? "var(--color-success)"
          : colorOfLanguage(colors, rule.language)
        : rule.level === "over"
          ? "var(--color-danger)"
          : rule.level === "near"
            ? "var(--color-warning)"
            : "var(--color-accent)";
      const kindWord = isGoal(rule) ? "goal" : "limit";
      return `<li class="grid grid-cols-[minmax(0,10rem)_4.5rem_minmax(0,1fr)_8.5rem_7.5rem_auto_auto] items-center gap-3 text-sm">
        <span class="truncate font-medium text-text-primary flex items-center gap-2">${languageDot(colorOfLanguage(colors, rule.language))}${escapeHtml(rule.language)}</span>
        <span class="rule-kind${isGoal(rule) ? " rule-kind--goal" : ""}">${isGoal(rule) ? "At least" : "At most"}</span>
        <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex" role="meter" aria-valuemin="0" aria-valuemax="${rule.minutes}" aria-valuenow="${Math.floor(rule.usedSeconds / 60)}" aria-label="${escapeHtml(rule.language)} ${kindWord} today"><span class="h-full rounded-full transition-[width] duration-500" style="width:${Math.max(share > 0 ? 2 : 0, share * 100)}%;background:${barColor}"></span></span>
        <span class="text-right text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(rule.usedSeconds)} <span class="text-text-muted">of</span></span>
        ${stepperHtml({ value: rule.minutes, min: 1, max: MAX_LIMIT_MINUTES, step: 5, className: "time-rule-minutes", suffix: "min", ariaLabel: `Daily minutes for the ${escapeHtml(rule.language)} ${kindWord}`, attributes: { "data-language": rule.language, "data-kind": rule.kind ?? "" } })}
        <span class="text-xs whitespace-nowrap">${ruleStatusHtml(rule)}</span>
        <button type="button" class="time-rule-delete icon-btn w-8 h-8 hover:text-danger" data-language="${escapeHtml(rule.language)}" data-kind="${escapeHtml(rule.kind ?? "")}" title="Remove the ${escapeHtml(rule.language)} ${kindWord}">${TRASH_ICON}</button>
      </li>`;
    })
    .join("");
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Daily goals and limits")}
    <p class="text-xs text-text-muted m-0">A goal is the least you want in a language each day, a limit the most. The player shows a note when a goal is reached and when a limit is close or passed. Time is real time, so 2× speed counts half.${prefs.watchHistory ? "" : " Goals and limits need YouTube history, which is off."}</p>
    ${rowsHtml ? `<ul class="m-0 p-0 list-none flex flex-col gap-2.5">${rowsHtml}</ul>` : ""}
    <form id="time-rule-add" class="flex flex-wrap items-center gap-2">
      <span class="ui-segmented" role="group" aria-label="Kind">
        <button type="button" class="time-rule-kind budget-chip text-xs" data-kind="goal" aria-pressed="${newRuleKind === "goal"}">At least</button>
        <button type="button" class="time-rule-kind budget-chip text-xs" data-kind="limit" aria-pressed="${newRuleKind === "limit"}">At most</button>
      </span>
      <span class="ui-combobox"><input type="text" id="time-rule-language" name="language" required maxlength="80" placeholder="Language, e.g. Slovak" class="ui-field w-48" aria-label="Language" /></span>
      ${stepperHtml({ name: "minutes", min: 1, max: MAX_LIMIT_MINUTES, step: 5, required: true, placeholder: "30", suffix: "min a day", ariaLabel: "Minutes per day" })}
      <button type="submit" class="chip chip--accent h-8 text-xs">Add ${newRuleKind === "goal" ? "goal" : "limit"}</button>
    </form>
  </section>`;
}

function streakSectionHtml(streaks: GoalStreaks, watch: WatchSummary): string {
  const colors = languageColorMap(watch);
  const byRules = streaks.mode === "rules";
  const goals = streaks.rules.filter((rule) => isGoal(rule)).length;
  const what = !byRules ? "Days with at least a minute watched" : goals > 0 ? "Days that reached every goal and kept every limit" : "Days that kept every limit";
  const statusWords: Record<string, string> = {
    all: byRules ? "Everything kept" : "Watched",
    some: "Some goals reached",
    none: byRules ? "Not kept" : "Nothing watched",
    before: "Before your history",
    future: "",
  };
  const weeks: string[] = [];
  for (let week = 0; week < CALENDAR_WEEKS; week++) {
    const days = streaks.calendar.slice(week * 7, week * 7 + 7);
    weeks.push(
      `<div class="flex flex-col gap-1.5">${days
        .map((day) => {
          const today = day.key === dateKeyOf(Date.now());
          const words = today && day.status !== "all" ? "Today, still open" : statusWords[day.status];
          return `<span class="streak-day streak-day--${day.status}${today ? " streak-day--today" : ""}"${day.status === "future" ? "" : ` title="${escapeHtml(`${longDate(day.key)}${words ? `\n${words}` : ""}`)}"`}></span>`;
        })
        .join("")}</div>`
    );
  }
  const dayLabels = WEEKDAY_NAMES.map((name) => `<span class="h-[26px] leading-[26px] text-[11px] text-text-muted">${name}</span>`).join("");
  const rulesHtml = streaks.rules
    .map(
      (rule) => `<li class="flex items-center gap-2.5 py-2 border-b border-border/60 text-sm">
        ${languageDot(colorOfLanguage(colors, rule.language))}
        <span class="flex-1 min-w-0 truncate text-text-primary">${escapeHtml(rule.language)} <span class="text-text-muted">${isGoal(rule) ? "goal" : "limit kept"}</span></span>
        <span class="font-display text-lg tabular-nums text-text-primary">${rule.current}</span>
        <span class="w-9 text-xs text-text-muted">${rule.current === 1 ? "day" : "days"}</span>
      </li>`
    )
    .join("");
  const legend = (byRules ? (["all", "some", "none"] as const) : (["all", "none"] as const))
    .map((status) => `<span class="flex items-center gap-1.5"><span class="streak-day streak-day--${status} legend-swatch"></span>${statusWords[status]}</span>`)
    .join("");
  return `<section class="flex flex-col gap-3">
    ${timeSectionHeading("Streak")}
    <div class="streak-card">
      <div class="flex flex-col gap-4 min-w-0">
        <div>
          <div class="flex items-baseline gap-2"><span class="font-display text-[56px] leading-none tabular-nums text-text-primary">${streaks.current}</span><span class="font-display text-2xl text-text-secondary">${streaks.current === 1 ? "day" : "days"} in a row</span></div>
          <p class="text-xs text-text-muted mt-1.5 mb-0">${escapeHtml(what)} · best ${plural(streaks.longest, "day")}</p>
        </div>
        <div class="flex gap-1.5"><div class="flex flex-col gap-1.5 pr-1">${dayLabels}</div>${weeks.join("")}</div>
        <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">${legend}<span class="flex items-center gap-1.5"><span class="streak-day streak-day--today legend-swatch"></span>Today</span></div>
      </div>
      ${
        rulesHtml
          ? `<div class="min-w-0 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-6"><div class="text-xs text-text-muted mb-1">Each on its own</div><ul class="m-0 p-0 list-none">${rulesHtml}</ul></div>`
          : `<div class="min-w-0 border-t md:border-t-0 md:border-l border-border pt-4 md:pt-0 md:pl-6 text-sm text-text-muted self-center">Add a daily goal above and the streak counts the days you reach it.</div>`
      }
    </div>
  </section>`;
}

async function saveDailyRules(rules: LanguageLimit[]): Promise<void> {
  await browser.runtime.sendMessage({ action: "set-language-limits", limits: rules });
  await renderTimePanel();
}

function plainRules(): LanguageLimit[] {
  return (lastTimeResponse?.limits ?? []).map(({ language, minutes, kind }) => (kind ? { language, minutes, kind } : { language, minutes }));
}

function sameRule(rule: LanguageLimit, language: string | undefined, kind: string | undefined): boolean {
  return rule.language === language && (rule.kind ?? "") === (kind ?? "");
}

function mandalaSectionHtml(data: TimeSummaryResponse): string {
  const { summary, rules, mandala, piles } = data;

  const pillarRows = summary.byPillar
    .map((totals, pillarIndex) => ({ pillarIndex, ...totals, total: totals.active + totals.passive }))
    .filter((row) => row.total > 0)
    .sort((first, second) => second.total - first.total);
  const longest = pillarRows[0]?.total ?? 1;
  const pillarsHtml = pillarRows.length
    ? pillarRows
        .map(
          (row) => `<li class="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <span class="truncate font-medium text-text-primary flex items-center gap-2">${languageDot(pillarColor(row.pillarIndex))}${escapeHtml(pillarTitleOf(mandala, row.pillarIndex))}</span>
            <span class="h-2 rounded-full bg-surface-elevated overflow-hidden flex"><span class="h-full" style="width:${Math.max(2, (row.active / longest) * 100)}%;background:${pillarColor(row.pillarIndex)}"></span><span class="h-full opacity-40" style="width:${(row.passive / longest) * 100}%;background:${pillarColor(row.pillarIndex)}"></span></span>
            <span class="text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(row.active)}${row.passive > 0 ? ` <span class="text-text-muted">+ ${formatMinutesWords(row.passive)}</span>` : ""}</span>
          </li>`
        )
        .join("")
    : `<li class="text-sm text-text-muted">Nothing counted yet.</li>`;

  const sitesHtml = summary.bySite.length
    ? summary.bySite
        .map((site) => {
          const rule = rules.find((each) => each.kind === "host" && (site.host === each.pattern || site.host.endsWith(`.${each.pattern}`)));
          return `<tr class="border-t border-border/60">
            <td class="py-2 pr-3 text-sm text-text-primary truncate max-w-[18rem]" title="${escapeHtml(site.host)}">${escapeHtml(site.host)}</td>
            <td class="py-2 pr-3"><div class="time-select" data-select="site-pillar" data-host="${escapeHtml(site.host)}" data-rule-id="${escapeHtml(rule?.id ?? "")}" data-value="${site.pillarIndex ?? ""}" data-label="Pillar for ${escapeHtml(site.host)}"></div></td>
            <td class="py-2 pr-3 text-sm text-text-secondary tabular-nums whitespace-nowrap">${formatMinutesWords(site.active)}</td>
            <td class="py-2 pr-3 text-sm text-text-muted tabular-nums whitespace-nowrap">${site.passive > 0 ? formatMinutesWords(site.passive) : "·"}</td>
            <td class="py-2 pr-3 text-xs text-text-muted whitespace-nowrap">${timeAgoWords(site.lastAt)}</td>
            <td class="py-2 text-right">${rule ? `<button type="button" class="time-rule-remove chip h-7 px-2.5 text-xs chip--danger" data-rule-id="${escapeHtml(rule.id)}">Stop counting</button>` : ""}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="py-3 text-sm text-text-muted">No sites yet.</td></tr>`;

  const pileRows = (piles?.sections ?? [])
    .map((section) => {
      const rule = rules.find((each) => each.kind === "pile" && each.pattern === section.id);
      return `<li class="flex items-center gap-3 text-sm">
        <span class="flex-1 min-w-0 truncate text-text-primary">${section.emoji ? `${escapeHtml(section.emoji)} ` : ""}${escapeHtml(section.name)}</span>
        <div class="time-select" data-select="pile-pillar" data-section-id="${escapeHtml(section.id)}" data-section-name="${escapeHtml(section.name)}" data-rule-id="${escapeHtml(rule?.id ?? "")}" data-value="${rule ? rule.pillarIndex : ""}" data-label="Pillar for the pile ${escapeHtml(section.name)}"></div>
        ${rule ? `<div class="time-select" data-select="pile-action" data-section-id="${escapeHtml(section.id)}" data-pillar="${rule.pillarIndex}" data-value="${escapeHtml(rule.actionId ?? "")}" data-label="Action for the pile ${escapeHtml(section.name)}"></div>` : ""}
      </li>`;
    })
    .join("");

  const prefixHtml = rules
    .filter((rule) => rule.kind === "prefix")
    .map(
      (rule) => `<li class="flex items-center gap-3 text-sm">
        ${languageDot(pillarColor(rule.pillarIndex))}
        <span class="flex-1 min-w-0 truncate text-text-primary" title="${escapeHtml(rule.pattern)}">${escapeHtml(rule.label || rule.pattern)}</span>
        <span class="text-xs text-text-muted">${escapeHtml(pillarTitleOf(mandala, rule.pillarIndex))}</span>
        <button type="button" class="time-rule-remove chip h-7 px-2.5 text-xs chip--danger" data-rule-id="${escapeHtml(rule.id)}">Stop counting</button>
      </li>`
    )
    .join("");

  const pendingHtml =
    summary.pendingMinutes > 0
      ? `<div class="flex items-center gap-3 rounded-[10px] border border-border bg-surface-elevated px-4 py-3 text-sm text-text-secondary"><span class="flex-1">${summary.pendingMinutes} min not sent yet</span><button type="button" id="time-open-mandala" class="chip h-8 text-xs">Open Mandala</button></div>`
      : "";
  const noPillars = !mandala || pillarChoices(mandala).every((pillar) => !mandala.pillars.find((each) => each.index === pillar.index)?.named);
  const counted = summary.total.active + summary.total.passive;
  const inUse = rules.length > 0 || counted > 0 || summary.pendingMinutes > 0;

  return `
    <details class="group flex flex-col gap-4"${inUse ? " open" : ""}>
      <summary class="flex items-center gap-3 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        <h2 class="font-display text-[22px] font-medium m-0 flex items-center gap-2">Mandala<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-text-muted transition-transform group-open:rotate-90" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></h2>
        ${counted > 0 ? `<span class="text-sm text-text-muted tabular-nums">${formatMinutesWords(counted)}</span>` : ""}
      </summary>
      <div class="flex flex-col gap-4 mt-4">
      ${pendingHtml}
      ${noPillars ? `<p class="text-sm text-text-muted m-0">Open Mandala once to load your pillar names.</p>` : ""}
      <h3 class="text-sm font-semibold text-text-secondary m-0">By pillar</h3>
      <ul class="m-0 p-0 list-none flex flex-col gap-2">${pillarsHtml}</ul>
      <h3 class="text-sm font-semibold text-text-secondary m-0 mt-2">Sites</h3>
      <table class="w-full border-collapse"><thead><tr class="text-[11px] uppercase tracking-[0.1em] text-text-muted text-left"><th class="font-semibold pb-1 pr-3">Site</th><th class="font-semibold pb-1 pr-3">Counts for</th><th class="font-semibold pb-1 pr-3">Active</th><th class="font-semibold pb-1 pr-3">Background</th><th class="font-semibold pb-1 pr-3">Last</th><th></th></tr></thead><tbody>${sitesHtml}</tbody></table>
      ${prefixHtml ? `<h3 class="text-sm font-semibold text-text-secondary m-0 mt-2">Pages</h3><ul class="m-0 p-0 list-none flex flex-col gap-2">${prefixHtml}</ul>` : ""}
      <h3 class="text-sm font-semibold text-text-secondary m-0 mt-2">Piles</h3>
      ${pileRows ? `<ul class="m-0 p-0 list-none flex flex-col gap-2">${pileRows}</ul>` : `<p class="text-sm text-text-muted m-0">No piles yet.</p>`}
      </div>
    </details>
  `;
}

const IDLE_CHOICES = [30, 60, 120, 300];

function mountTimeSelects(panel: HTMLElement, data: TimeSummaryResponse): void {
  const saveRule = async (rule: Omit<SiteRule, "id" | "createdAt"> & { id?: string }) => {
    await browser.runtime.sendMessage({ action: "set-site-rule", rule });
    await renderTimePanel();
  };
  for (const root of panel.querySelectorAll<HTMLElement>(".time-select")) {
    const { select, value = "", label = "" } = root.dataset;
    if (select === "idle") {
      mountCustomSelect(root, {
        options: IDLE_CHOICES.map((seconds) => ({ value: String(seconds), label: seconds < 60 ? `${seconds} s` : `${seconds / 60} min` })),
        value,
        size: "field",
        ariaLabel: label,
        onChange: (next) => void saveTrackingPrefs(panel, { idleSeconds: Number(next) }),
      });
    } else if (select === "site-pillar") {
      const host = root.dataset.host ?? "";
      mountCustomSelect(root, {
        options: [...(value === "" ? [{ value: "", label: "Not counted" }] : []), ...pillarSelectOptions(data.mandala)],
        value,
        size: "field",
        ariaLabel: label,
        onChange: (next) => void (next ? saveRule({ id: root.dataset.ruleId || undefined, kind: "host", pattern: host, label: host, pillarIndex: Number(next) }) : undefined),
      });
    } else if (select === "pile-pillar") {
      mountCustomSelect(root, {
        options: [{ value: "", label: "Not counted" }, ...pillarSelectOptions(data.mandala)],
        value,
        size: "field",
        ariaLabel: label,
        onChange: async (next) => {
          if (!next) {
            if (root.dataset.ruleId) await browser.runtime.sendMessage({ action: "remove-site-rule", id: root.dataset.ruleId });
            await renderTimePanel();
            return;
          }
          await saveRule({ id: root.dataset.ruleId || undefined, kind: "pile", pattern: root.dataset.sectionId ?? "", label: root.dataset.sectionName ?? "", pillarIndex: Number(next) });
        },
      });
    } else if (select === "pile-action") {
      mountCustomSelect(root, {
        options: actionSelectOptions(data.mandala, Number(root.dataset.pillar)),
        value,
        size: "field",
        ariaLabel: label,
        onChange: async (next) => {
          const rule = data.rules.find((each) => each.kind === "pile" && each.pattern === root.dataset.sectionId);
          if (rule) await saveRule({ ...rule, actionId: next || undefined });
        },
      });
    }
  }
}

async function saveTrackingPrefs(panel: HTMLElement, change: Partial<TimeTrackingPrefs>): Promise<void> {
  const current = lastTimeResponse?.prefs;
  const prefs: TimeTrackingPrefs = {
    enabled: panel.querySelector<HTMLInputElement>("#time-enabled")?.checked ?? current?.enabled ?? true,
    idleSeconds: current?.idleSeconds ?? 60,
    watchHistory: panel.querySelector<HTMLInputElement>("#time-watch-history")?.checked ?? current?.watchHistory ?? true,
    ...change,
  };
  await browser.runtime.sendMessage({ action: "set-time-tracking-prefs", prefs });
  if (lastTimeResponse) lastTimeResponse.prefs = prefs;
  if (change.watchHistory !== undefined) await renderTimePanel();
}

async function renderTimePanel(): Promise<void> {
  const panel = document.getElementById("time-panel");
  if (!panel) return;
  wireTimePanel(panel);
  let data: TimeSummaryResponse;
  try {
    data = (await browser.runtime.sendMessage({ action: "get-time-summary", days: timeRange })) as TimeSummaryResponse;
    if (!data || data.errorMessage) throw new Error(data?.errorMessage || "No answer");
  } catch (error) {
    panel.innerHTML = `<p class="text-sm text-text-muted m-0">Could not read the time log: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`;
    panel.setAttribute("aria-busy", "false");
    return;
  }
  if (!isTimeView) return;
  lastTimeResponse = data;
  const { watch, prefs } = data;
  const headerStats = document.getElementById("current-view-stats");
  if (headerStats) {
    headerStats.textContent = watch.total.videos > 0 ? [plural(watch.total.videos, "video"), plural(watch.byLanguage.length, "language"), plural(watch.byChannel.length, "channel")].join(" · ") : "";
  }
  setDeskHero({
    kicker: "Time",
    title: "",
    value: formatMinutesWords(watch.total.playedSeconds),
    suffix: timeRange === 7 ? " watched this week" : ` watched in ${timeRange} days`,
  });

  const rangeHtml = `<span class="ui-segmented" role="group" aria-label="Range">
    ${TIME_RANGES.map((days) => `<button type="button" class="time-range budget-chip" data-days="${days}" aria-pressed="${timeRange === days}">${days} days</button>`).join("")}
  </span>`;

  // Keep what was being typed in the add form across the re-render that a save causes.
  const typedLanguage = panel.querySelector<HTMLInputElement>("#time-rule-language")?.value ?? "";

  panel.innerHTML = `
    <div class="flex justify-end">${rangeHtml}</div>
    ${dailyRulesHtml(data.limits ?? [], watch, prefs)}
    ${data.streaks ? streakSectionHtml(data.streaks, watch) : ""}
    <div id="time-watch" class="contents">${watchSectionsHtml(watch, prefs)}</div>
    ${mandalaSectionHtml(data)}
    <section class="flex flex-col gap-3 pb-6">
      <h2 class="font-display text-[22px] font-medium m-0">Tracking</h2>
      <div class="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label class="flex items-center gap-2.5 text-sm text-text-primary cursor-pointer"><input type="checkbox" role="switch" id="time-watch-history" class="ui-switch"${prefs.watchHistory ? " checked" : ""} /> YouTube history</label>
        <label class="flex items-center gap-2.5 text-sm text-text-primary cursor-pointer"><input type="checkbox" role="switch" id="time-enabled" class="ui-switch"${prefs.enabled ? " checked" : ""} /> Mandala page time</label>
        <span class="flex items-center gap-2 text-sm text-text-secondary">Idle after <div class="time-select" data-select="idle" data-value="${prefs.idleSeconds}" data-label="Idle after"></div></span>
        <span class="flex-1"></span>
        <button type="button" id="time-export-csv" class="chip h-8 text-xs">Export CSV</button>
        <button type="button" id="time-export" class="chip h-8 text-xs" title="Everything, including Mandala page time, as JSON">Back up JSON</button>
        <button type="button" id="time-clear" class="chip h-8 text-xs chip--danger">Delete all time data</button>
      </div>
      <p class="text-xs text-text-muted m-0">Stored only in this browser.</p>
    </section>
  `;
  mountTimeSelects(panel, data);
  const languageInput = panel.querySelector<HTMLInputElement>("#time-rule-language");
  if (languageInput) {
    languageInput.value = typedLanguage;
    wireCombobox(languageInput, () => {
      const taken = new Set((lastTimeResponse?.limits ?? []).filter((rule) => (newRuleKind === "goal") === isGoal(rule)).map((rule) => languageKey(rule.language)));
      return (lastTimeResponse?.watch.byLanguage ?? []).map((row) => row.label).filter((label) => label !== UNKNOWN_LANGUAGE && !taken.has(languageKey(label)));
    });
  }
  panel.setAttribute("aria-busy", "false");
}

function repaintWatchSections(panel: HTMLElement): void {
  const box = panel.querySelector<HTMLElement>("#time-watch");
  if (box && lastTimeResponse) box.innerHTML = watchSectionsHtml(lastTimeResponse.watch, lastTimeResponse.prefs);
}

let exportDays: number | null = 30;
let exportColumns = new Set<CsvColumn>(DEFAULT_CSV_COLUMNS);
const EXPORT_RANGES: { days: number | null; label: string }[] = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: null, label: "All time" },
];
const EXPORT_PREVIEW_ROWS = 4;

async function requestWatchCsv(): Promise<{ csv: string; rows: number } | null> {
  const response = (await browser.runtime.sendMessage({ action: "export-watch-csv", days: exportDays, columns: [...exportColumns] })) as { csv?: string; rows?: number };
  return typeof response?.csv === "string" ? { csv: response.csv, rows: response.rows ?? 0 } : null;
}

async function refreshExportPreview(): Promise<void> {
  const range = document.getElementById("export-range");
  const columns = document.getElementById("export-columns");
  const preview = document.getElementById("export-preview");
  const count = document.getElementById("export-count");
  const download = document.getElementById("export-download") as HTMLButtonElement | null;
  if (range) {
    range.innerHTML = EXPORT_RANGES.map(
      (option) => `<button type="button" class="export-range budget-chip text-xs" data-days="${option.days ?? ""}" aria-pressed="${exportDays === option.days}">${option.label}</button>`
    ).join("");
  }
  if (columns) {
    columns.innerHTML = CSV_COLUMNS.map(
      (column) => `<label class="flex items-center gap-2.5 text-sm text-text-secondary cursor-pointer"><input type="checkbox" class="ui-check export-column" value="${column.id}"${exportColumns.has(column.id) ? " checked" : ""} /> ${escapeHtml(column.label)}</label>`
    ).join("");
  }
  const result = exportColumns.size > 0 ? await requestWatchCsv() : null;
  const lines = result?.csv.trimEnd().split("\r\n") ?? [];
  if (preview) {
    const more = lines.length - 1 - EXPORT_PREVIEW_ROWS;
    preview.textContent = exportColumns.size === 0 ? "Pick at least one column." : [...lines.slice(0, EXPORT_PREVIEW_ROWS + 1), ...(more > 0 ? [`… ${more} more ${more === 1 ? "row" : "rows"}`] : [])].join("\n");
  }
  if (count) count.textContent = result ? plural(result.rows, "sitting") : "";
  if (download) download.disabled = !result || result.rows === 0;
}

function openExportModal(): void {
  const modal = document.getElementById("export-modal");
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  void refreshExportPreview().then(() => document.getElementById("export-download")?.focus());
}

function closeExportModal(): void {
  const modal = document.getElementById("export-modal");
  modal?.classList.add("hidden");
  modal?.classList.remove("flex");
}

function downloadText(text: string, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function wireExportModal(): void {
  const modal = document.getElementById("export-modal");
  const form = document.getElementById("export-form") as HTMLFormElement | null;
  if (!modal || !form) return;
  modal.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target === modal || target.closest("#export-cancel")) {
      closeExportModal();
      return;
    }
    const range = target.closest<HTMLElement>(".export-range");
    if (range) {
      exportDays = range.dataset.days ? Number(range.dataset.days) : null;
      void refreshExportPreview();
    }
  });
  modal.addEventListener("change", (event) => {
    const box = event.target as HTMLInputElement;
    if (!box.classList.contains("export-column")) return;
    if (box.checked) exportColumns.add(box.value as CsvColumn);
    else exportColumns.delete(box.value as CsvColumn);
    void refreshExportPreview();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeExportModal();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await requestWatchCsv();
    if (!result) return;
    // A byte order mark makes Excel read the file as UTF-8, so titles in other scripts survive.
    downloadText(`﻿${result.csv}`, "text/csv;charset=utf-8", `study-harvester-history-${new Date().toISOString().slice(0, 10)}.csv`);
    closeExportModal();
  });
}

function wireTimePanel(panel: HTMLElement): void {
  if (timePanelWired) return;
  timePanelWired = true;
  wireSteppers(panel);
  wireExportModal();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CHANNEL_AVATARS_KEY] || !lastTimeResponse || !isTimeView) return;
    const avatars = (changes[CHANNEL_AVATARS_KEY].newValue ?? {}) as Record<string, string>;
    let found = false;
    for (const channel of lastTimeResponse.watch.byChannel) {
      if (!channel.avatarUrl && avatars[channel.channelName]) {
        channel.avatarUrl = avatars[channel.channelName];
        found = true;
      }
    }
    if (found) repaintWatchSections(panel);
  });

  panel.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const range = target.closest<HTMLElement>(".time-range");
    if (range) {
      timeRange = TIME_RANGES.find((days) => String(days) === range.dataset.days) ?? 7;
      showAllChannels = false;
      openChannel = null;
      videoRowsShown = 0;
      await renderTimePanel();
      return;
    }
    const kind = target.closest<HTMLElement>(".time-rule-kind");
    if (kind) {
      newRuleKind = kind.dataset.kind === "limit" ? "limit" : "goal";
      for (const button of panel.querySelectorAll<HTMLElement>(".time-rule-kind")) button.setAttribute("aria-pressed", String(button === kind));
      const submit = panel.querySelector<HTMLElement>("#time-rule-add [type=submit]");
      if (submit) submit.textContent = newRuleKind === "goal" ? "Add goal" : "Add limit";
      return;
    }
    if (target.closest("#time-channels-toggle")) {
      showAllChannels = !showAllChannels;
      repaintWatchSections(panel);
      return;
    }
    const filter = target.closest<HTMLElement>(".time-channel-filter");
    if (filter) {
      channelLanguageFilter = filter.dataset.language || null;
      showAllChannels = false;
      openChannel = null;
      repaintWatchSections(panel);
      return;
    }
    const channelRow = target.closest<HTMLElement>(".time-channel");
    if (channelRow && !target.closest("a")) {
      openChannel = openChannel === channelRow.dataset.channel ? null : (channelRow.dataset.channel ?? null);
      repaintWatchSections(panel);
      return;
    }
    const moreVideos = target.closest<HTMLElement>("#time-videos-more");
    if (moreVideos) {
      videoRowsShown = Number(moreVideos.dataset.shown) + VIDEO_ROWS_PAGE * 2;
      repaintWatchSections(panel);
      return;
    }
    const removeRule = target.closest<HTMLElement>(".time-rule-delete");
    if (removeRule) {
      await saveDailyRules(plainRules().filter((rule) => !sameRule(rule, removeRule.dataset.language, removeRule.dataset.kind)));
      return;
    }
    const remove = target.closest<HTMLElement>(".time-rule-remove");
    if (remove?.dataset.ruleId) {
      await browser.runtime.sendMessage({ action: "remove-site-rule", id: remove.dataset.ruleId });
      await renderTimePanel();
      return;
    }
    if (target.closest("#time-open-mandala")) {
      await browser.tabs.create({ url: "https://mandalamethod.vercel.app/" });
      return;
    }
    if (target.closest("#time-export-csv")) {
      openExportModal();
      return;
    }
    if (target.closest("#time-export")) {
      const response = (await browser.runtime.sendMessage({ action: "export-time-log" })) as { json?: string };
      if (response?.json) downloadText(response.json, "application/json", `study-harvester-time-${new Date().toISOString().slice(0, 10)}.json`);
      return;
    }
    if (target.closest("#time-clear")) {
      const confirmed = await showConfirm({
        title: "Delete all time data",
        message: "Delete the YouTube watch history and every measured minute from this browser? Minutes that already reached Mandala stay there.",
        confirmLabel: "Delete",
        confirmDanger: true,
      });
      if (confirmed) {
        await browser.runtime.sendMessage({ action: "clear-time-log" });
        await renderTimePanel();
      }
    }
  });

  panel.addEventListener("submit", async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.id !== "time-rule-add") return;
    event.preventDefault();
    const fields = new FormData(form);
    const language = String(fields.get("language") ?? "").trim();
    const minutes = Number(fields.get("minutes"));
    if (!language || !(minutes > 0)) return;
    // Pick up the label as the Time page spells it, so "english" still matches "English".
    const known = lastTimeResponse?.watch.byLanguage.find((row) => languageKey(row.label) === languageKey(language));
    const rule: LanguageLimit = newRuleKind === "goal" ? { language: known?.label ?? language, minutes, kind: "goal" } : { language: known?.label ?? language, minutes };
    const others = plainRules().filter((each) => ruleKey(each) !== ruleKey(rule));
    form.querySelector<HTMLInputElement>("#time-rule-language")!.value = "";
    await saveDailyRules([...others, rule]);
  });

  panel.addEventListener("change", async (event) => {
    const target = event.target as HTMLElement;
    if (target.id === "time-enabled" || target.id === "time-watch-history") {
      const checked = (target as HTMLInputElement).checked;
      await saveTrackingPrefs(panel, target.id === "time-enabled" ? { enabled: checked } : { watchHistory: checked });
      return;
    }
    if (target instanceof HTMLInputElement && target.classList.contains("time-rule-minutes")) {
      const minutes = Number(target.value);
      if (!target.checkValidity() || !(minutes > 0)) return;
      // Each press of a stepper button fires change; saving after a pause keeps the panel from redrawing under the pointer.
      if (ruleSaveTimer !== null) clearTimeout(ruleSaveTimer);
      ruleSaveTimer = setTimeout(() => {
        ruleSaveTimer = null;
        void saveDailyRules(plainRules().map((rule) => (sameRule(rule, target.dataset.language, target.dataset.kind) ? { ...rule, minutes } : rule)));
      }, RULE_SAVE_DELAY_MS);
    }
  });
}

function render() {
  if (renderTimeout != null) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => {
    renderTimeout = null;
    renderSidebar();
    renderMain();
    if (!selectedSession && skippedTabListDom) updateLiveTabListCardsFromState();
    updateSelectionUI();
    if (tabListContainerInnerHtmlUpdated) {
      setTimeout(() => applyTabListCheckboxIndeterminateFromAttr(), 0);
    }
  }, 0);
}

document.addEventListener("DOMContentLoaded", () => {
  const appearanceControl = document.getElementById("appearance-control");
  if (appearanceControl) {
    appearanceControl.innerHTML = THEME_CONTROL_HTML;
    mountThemeControl(appearanceControl);
  }
  installTooltips();
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
    deskChannelAvatars = avatars;
    lastFacetRailHtml = "";
    lastTabListFingerprint = "";
    render();
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CHANNEL_AVATARS_KEY]) return;
    deskChannelAvatars = (changes[CHANNEL_AVATARS_KEY].newValue ?? {}) as ChannelAvatars;
    if (isTimeView) return;
    lastFacetRailHtml = "";
    lastTabListFingerprint = "";
    render();
  });
  setupListeners();
  const urlParameters = new URLSearchParams(window.location.search);
  if (urlParameters.get("view") === "reading-list") {
    isReadingListView = true;
  }
  if (urlParameters.get("view") === "time") {
    isTimeView = true;
  }
  void loadReadingList();
  void loadLanguageOverrides().then((overrides) => {
    languageOverrides = overrides;
    lastFacetRailHtml = "";
    lastTabListFingerprint = "";
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
      const video = allVideos.find((candidate) => candidate.id === message.tabId);
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
