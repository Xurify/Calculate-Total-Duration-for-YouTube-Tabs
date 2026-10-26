import "./style.css";
import { initTheme, mountThemeControl, THEME_CONTROL_HTML } from "../../utils/theme";
import packageJson from "../../package.json";

initTheme();
import {
  VideoData,
  CachedMetadata,
  lookupCachedMetadata,
  saveStorage as saveStorageUtil,
  requestMetadataUpdate,
  normalizeYoutubeUrl,
  clearCache,
} from "../../utils/storage";
import {
  applyStorePatch,
  fetchStoreState,
  isStoreUpdatedMessage,
  type StoreState,
} from "../../utils/store";
import { formatTime, formatCompact, formatDurationWords, formatOffset, parseTimeParam, getVideoIdFromUrl } from "../../utils/format";
import { queryReadingList } from "../../utils/readingList";
import { loadCachedMandalaSummary, type CachedMandalaSummary } from "../../utils/storage";
import { hostOf, isTrackableUrl, pagePrefixOf, pillarColor, type SiteRule } from "../../utils/timeLog";
import { actionSelectOptions, escapeHtml as escapeText, matchWords, pillarChoices, pillarSelectOptions, type CurrentSiteResponse } from "../../utils/timeUi";
import { closeAllCustomSelects, mountCustomSelect } from "../manager/custom-select";
import { installTooltips, syncRangeFill } from "../../utils/controls";
import { loadChannelAvatars, type ChannelAvatars } from "../../utils/channelAvatars";

let popupChannelAvatars: ChannelAvatars = {};

const VERSION_NUMBER = packageJson.version;

let videoData: VideoData[] = [];
let sortByDuration = false;
let currentView: "dashboard" | "settings" = "dashboard";
let popupWindowId: number | null = null;
let lastPlayingTabId: number | null = null;
let resolvedNowPlayingTabIds: number[] = [];
let pinnedNowPlayingTabId: number | null = null;

const LAST_PLAYING_SESSION_KEY = "lastPlayingByWindow";

let storeState: StoreState = {
  prefs: {
    sortByDuration: false,
    excludedUrls: [],
    thumbnailQuality: "high",
    layoutMode: "grid",
    groupingMode: "none",
    sortOption: "duration-desc",
  },
  metadataCache: {},
};

function applyStoreToVideos(): void {
  const { prefs, metadataCache } = storeState;
  sortByDuration = prefs.sortByDuration;
  videoData.forEach((video) => {
    video.excluded = prefs.excludedUrls.includes(normalizeYoutubeUrl(video.url));
    const cached = lookupCachedMetadata(metadataCache, video.url);
    if (cached) applyCachedDurableMetadataToVideo(video, cached);
  });
}

function handleStoreUpdated(message: { prefs?: StoreState["prefs"]; metadataCache?: StoreState["metadataCache"] }): void {
  applyStorePatch(storeState, message);
  if (videoData.length > 0) {
    applyStoreToVideos();
    scheduleProbeRender();
  }
}

/** Persist prefs in background — UI already updated in memory. */
function saveStorage(): void {
  void saveStorageUtil(videoData, sortByDuration).catch((error) => {
    console.warn("Failed to save prefs:", error);
  });
}

function titleFromTab(tab: Browser.tabs.Tab): string {
  const raw = tab.title?.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();
  return raw && raw !== "YouTube" ? raw : "YouTube Video";
}

function persistVideoPlaybackToCache(video: VideoData): void {
  void requestMetadataUpdate(video.url, buildMetadataForCache(video));
}

function buildMetadataForCache(
  video: VideoData,
  videoId?: string
): Omit<CachedMetadata, "timestamp"> {
  return {
    seconds: video.isLive ? 0 : video.seconds,
    title: video.title,
    channelName: video.channelName,
    currentTime: video.isLive ? 0 : video.currentTime,
    isLive: video.isLive,
    videoId: videoId ?? getVideoIdFromUrl(video.url) ?? undefined,
    paused: video.paused,
    volume: video.volume,
    muted: video.muted,
  };
}

function applyProbedMetadataToVideo(
  video: VideoData,
  metadata: {
    title?: string;
    channelName?: string;
    seconds?: number;
    currentTime?: number;
    isLive?: boolean;
    paused?: boolean;
    volume?: number;
    muted?: boolean;
  }
): void {
  if (metadata.title) video.title = metadata.title;
  if (metadata.channelName !== undefined) video.channelName = metadata.channelName;
  if (metadata.isLive) {
    markVideoAsLive(video);
  } else if (metadata.isLive === false) {
    video.isLive = false;
    if (metadata.seconds !== undefined) video.seconds = metadata.seconds;
    if (metadata.currentTime !== undefined) {
      applyPlaybackTimeToVideo(video, metadata.currentTime);
    }
  } else if (metadata.seconds !== undefined) {
    video.seconds = metadata.seconds;
    if (metadata.currentTime !== undefined) {
      applyPlaybackTimeToVideo(video, metadata.currentTime);
    }
  } else if (metadata.currentTime !== undefined) {
    applyPlaybackTimeToVideo(video, metadata.currentTime);
  }
  if (metadata.paused !== undefined) video.paused = metadata.paused;
  if (metadata.volume !== undefined) video.volume = metadata.volume;
  if (metadata.muted !== undefined) video.muted = metadata.muted;
}

function getEffectiveWatchedSeconds(video: VideoData): number {
  if (video.isLive || video.excluded) return 0;
  if (video.seconds <= 0) return 0;
  return Math.min(video.currentTime, video.seconds);
}

function getWatchedPercent(video: VideoData): number {
  if (video.isLive || video.seconds <= 0) return 0;
  return Math.min(100, Math.max(0, (video.currentTime / video.seconds) * 100));
}

function getQueueVideos(): VideoData[] {
  return videoData.filter((video) => !video.excluded && !video.isLive);
}

function estimateCurrentTimeFromCache(video: VideoData, cached: CachedMetadata): number {
  if (cached.isLive || video.isLive) return 0;
  const base = cached.currentTime ?? 0;
  const shouldEstimate =
    cached.timestamp != null &&
    (cached.paused === false || (cached.paused === undefined && video.audible));
  if (!shouldEstimate) return base;
  const elapsed = (Date.now() - cached.timestamp) / 1000;
  const estimated = base + elapsed;
  if (cached.seconds > 0) return Math.min(cached.seconds, estimated);
  if (video.seconds > 0) return Math.min(video.seconds, estimated);
  return estimated;
}

function clampVideoCurrentTime(video: VideoData): void {
  if (video.isLive || video.seconds <= 0) return;
  video.currentTime = Math.min(video.currentTime, video.seconds);
}

function applyPlaybackTimeToVideo(video: VideoData, currentTime: number): void {
  if (video.isLive) {
    video.currentTime = 0;
    return;
  }
  video.currentTime = currentTime;
  clampVideoCurrentTime(video);
}

function markVideoAsLive(video: VideoData): void {
  video.isLive = true;
  video.seconds = 0;
  video.currentTime = 0;
}

function applyCachedDurableMetadataToVideo(video: VideoData, cached: CachedMetadata): void {
  video.title = cached.title || video.title;
  video.channelName = cached.channelName || "";
  video.language = cached.language;
  video.languageName = cached.languageName;
  video.isLive = cached.isLive || false;
  if (video.isLive) {
    markVideoAsLive(video);
    return;
  }
  video.seconds = cached.seconds || 0;
}

function applyCachedPlaybackToVideo(video: VideoData, cached: CachedMetadata): void {
  if (video.isLive || cached.isLive) {
    markVideoAsLive(video);
    return;
  }
  video.paused = cached.paused;
  video.volume = cached.volume;
  video.muted = cached.muted;
  if (cached.currentTime != null || cached.timestamp != null) {
    video.currentTime = estimateCurrentTimeFromCache(video, cached);
    clampVideoCurrentTime(video);
  }
}

function applyCachedMetadataToVideo(video: VideoData, cached: CachedMetadata): void {
  applyCachedDurableMetadataToVideo(video, cached);
  applyCachedPlaybackToVideo(video, cached);
}

function buildVideoFromTab(
  tab: Browser.tabs.Tab,
  index: number,
  excludedUrls: string[]
): VideoData {
  const url = tab.url!;
  const normalizedUrl = normalizeYoutubeUrl(url);
  return {
    id: tab.id || 0,
    title: titleFromTab(tab),
    channelName: "",
    seconds: 0,
    currentTime: parseTimeParam(url),
    excluded: excludedUrls.includes(normalizedUrl),
    index,
    url,
    suspended: tab.discarded || false,
    active: tab.active,
    audible: tab.audible || false,
    isLive: false,
    windowId: tab.windowId,
  };
}

// Global listener for background cache updates (content script + auto sync for suspended tabs)
browser.runtime.onMessage.addListener((message) => {
  if (isStoreUpdatedMessage(message)) {
    handleStoreUpdated(message);
    return;
  }
  if (message.action === "tab-synced") {
    const video = videoData.find((v) => v.id === message.tabId);
    if (video) {
      applyProbedMetadataToVideo(video, {
        title: message.metadata.title,
        channelName: message.metadata.channelName,
        seconds: message.metadata.seconds,
        isLive: message.metadata.isLive || false,
      });
      video.suspended = false;
      scheduleProbeRender();
    }
  }
  if (message.action === "sync-complete") {
    flushProbeRender();
  }
});

function getSortedVideos(): VideoData[] {
  return [...videoData].sort((a, b) => {
    if (sortByDuration) return b.seconds - a.seconds;
    return a.index - b.index;
  });
}

function getVideosInPopupWindow(): VideoData[] {
  const included = videoData.filter((video) => !video.excluded && !video.suspended);
  if (popupWindowId == null) return included;
  return included.filter((video) => video.windowId === popupWindowId);
}

async function loadLastPlayingTabId(windowId: number): Promise<number | null> {
  try {
    const data = await browser.storage.session.get(LAST_PLAYING_SESSION_KEY);
    const map = (data[LAST_PLAYING_SESSION_KEY] as Record<string, number>) ?? {};
    const tabId = map[String(windowId)];
    return typeof tabId === "number" && tabId > 0 ? tabId : null;
  } catch {
    return null;
  }
}

async function persistLastPlayingTabId(tabId: number): Promise<void> {
  lastPlayingTabId = tabId;
  if (popupWindowId == null) return;
  try {
    const data = await browser.storage.session.get(LAST_PLAYING_SESSION_KEY);
    const map = { ...((data[LAST_PLAYING_SESSION_KEY] as Record<string, number>) ?? {}) };
    map[String(popupWindowId)] = tabId;
    await browser.storage.session.set({ [LAST_PLAYING_SESSION_KEY]: map });
  } catch {
    // Session storage may be unavailable in some contexts
  }
}

async function clearLastPlayingTabId(): Promise<void> {
  lastPlayingTabId = null;
  if (popupWindowId == null) return;
  try {
    const data = await browser.storage.session.get(LAST_PLAYING_SESSION_KEY);
    const map = { ...((data[LAST_PLAYING_SESSION_KEY] as Record<string, number>) ?? {}) };
    delete map[String(popupWindowId)];
    await browser.storage.session.set({ [LAST_PLAYING_SESSION_KEY]: map });
  } catch {
    // ignore
  }
}

function isVideoEligibleForNowPlaying(video: VideoData | undefined): video is VideoData {
  if (!video || video.excluded || video.suspended) return false;
  if (popupWindowId != null && video.windowId !== popupWindowId) return false;
  return true;
}

function getNowPlayingTabIds(): Set<number> {
  return new Set(resolvedNowPlayingTabIds);
}

function isTabActivelyPlaying(video: VideoData): boolean {
  return resolvedNowPlayingTabIds.includes(video.id);
}

function nowPlayingIdsFingerprint(): string {
  return resolvedNowPlayingTabIds.join(",");
}

function sortNowPlayingCandidates(videos: VideoData[]): VideoData[] {
  return [...videos].sort((a, b) => b.currentTime - a.currentTime);
}

function getPrimaryNowPlayingSync(): VideoData | null {
  if (resolvedNowPlayingTabIds.length > 0) {
    for (const id of resolvedNowPlayingTabIds) {
      const video = findVideoByTabId(id);
      if (isVideoEligibleForNowPlaying(video)) return video;
    }
  }

  const audible = sortNowPlayingCandidates(getVideosInPopupWindow().filter((video) => video.audible));
  if (audible.length > 0) return audible[0] ?? null;

  if (pinnedNowPlayingTabId) {
    const pinned = findVideoByTabId(pinnedNowPlayingTabId);
    if (isVideoEligibleForNowPlaying(pinned)) return pinned;
  }

  if (lastPlayingTabId) {
    const last = findVideoByTabId(lastPlayingTabId);
    if (isVideoEligibleForNowPlaying(last)) return last;
  }

  return getVideosInPopupWindow().find((video) => video.active) ?? null;
}

function getVideosForUpNext(): VideoData[] {
  const playingIds = getNowPlayingTabIds();
  return getSortedVideos().filter((video) => !playingIds.has(video.id));
}

function getNowPlayingTabId(): number | null {
  const section = document.getElementById("now-playing");
  const tabId = section?.dataset.tabId ? parseInt(section.dataset.tabId, 10) : 0;
  if (tabId) {
    const pinned = videoData.find((video) => video.id === tabId);
    if (pinned && !pinned.excluded && !pinned.suspended) return tabId;
  }
  return getPrimaryNowPlayingSync()?.id ?? null;
}

function findVideoByTabId(tabId: number): VideoData | undefined {
  return videoData.find((video) => video.id === tabId);
}

interface PlaybackState {
  paused: boolean;
  volume: number;
  muted: boolean;
  currentTime: number;
}

function isPlaybackActive(state: PlaybackState): boolean {
  return !state.paused && !state.muted && state.volume > 0;
}

function isConfirmedPlaying(video: VideoData, playback: PlaybackState): boolean {
  return !!video.audible && isPlaybackActive(playback);
}

async function refreshWindowAudibleFlags(): Promise<void> {
  if (popupWindowId == null) return;
  const tabs = await browser.tabs.query({ windowId: popupWindowId });
  const flags = new Map<number, boolean>();
  for (const tab of tabs) {
    if (tab.id != null) flags.set(tab.id, tab.audible === true);
  }
  for (const video of videoData) {
    if (video.windowId === popupWindowId) {
      video.audible = flags.get(video.id) ?? false;
    }
  }
}

async function applyPlaybackStateToVideo(video: VideoData): Promise<PlaybackState | null> {
  const playback = await getPlaybackState(video.id);
  if (!playback) return null;
  video.paused = playback.paused;
  video.volume = playback.volume;
  video.muted = playback.muted;
  applyPlaybackTimeToVideo(video, playback.currentTime);
  return playback;
}

async function refreshNowPlayingDetectionInner(): Promise<VideoData[]> {
  await refreshWindowAudibleFlags();
  const inWindow = getVideosInPopupWindow();
  if (inWindow.length === 0) {
    resolvedNowPlayingTabIds = [];
    pinnedNowPlayingTabId = null;
    return [];
  }

  const probeIds = new Set<number>();
  for (const video of inWindow) {
    if (video.audible) probeIds.add(video.id);
  }
  if (lastPlayingTabId) probeIds.add(lastPlayingTabId);
  if (pinnedNowPlayingTabId) probeIds.add(pinnedNowPlayingTabId);
  const active = inWindow.find((video) => video.active);
  if (active) probeIds.add(active.id);

  const actuallyPlaying: VideoData[] = [];
  await Promise.all(
    inWindow
      .filter((video) => probeIds.has(video.id))
      .map(async (video) => {
        const playback = await applyPlaybackStateToVideo(video);
        if (playback && isConfirmedPlaying(video, playback)) {
          actuallyPlaying.push(video);
        }
      })
  );

  if (actuallyPlaying.length > 0) {
    const sorted = sortNowPlayingCandidates(actuallyPlaying);
    resolvedNowPlayingTabIds = sorted.map((video) => video.id);
    pinnedNowPlayingTabId = null;
    const primary = sorted[0];
    if (primary) await persistLastPlayingTabId(primary.id);
    return sorted;
  }

  resolvedNowPlayingTabIds = [];

  if (lastPlayingTabId) {
    const last = findVideoByTabId(lastPlayingTabId);
    if (isVideoEligibleForNowPlaying(last)) {
      await applyPlaybackStateToVideo(last);
      pinnedNowPlayingTabId = last.id;
      return [last];
    }
    await clearLastPlayingTabId();
  }

  if (active) {
    await applyPlaybackStateToVideo(active);
    pinnedNowPlayingTabId = active.id;
    return [active];
  }

  pinnedNowPlayingTabId = null;
  return [];
}

async function refreshNowPlayingDetection(): Promise<VideoData[]> {
  if (nowPlayingDetectPromise) return nowPlayingDetectPromise;
  nowPlayingDetectPromise = refreshNowPlayingDetectionInner().finally(() => {
    nowPlayingDetectPromise = null;
  });
  return nowPlayingDetectPromise;
}

function scheduleNowPlayingRefine(): void {
  if (nowPlayingRefineTimeout != null) clearTimeout(nowPlayingRefineTimeout);
  nowPlayingRefineTimeout = setTimeout(() => {
    nowPlayingRefineTimeout = null;
    void refineNowPlaying();
  }, NOW_PLAYING_REFINE_DEBOUNCE_MS);
}

function applyLocalPlaybackControl(tabId: number, video: VideoData, state: PlaybackState): boolean {
  video.paused = state.paused;
  video.volume = state.volume;
  video.muted = state.muted;
  applyPlaybackTimeToVideo(video, state.currentTime);
  const activelyPlaying = isPlaybackActive(state);
  if (activelyPlaying) {
    if (!resolvedNowPlayingTabIds.includes(tabId)) {
      resolvedNowPlayingTabIds = sortNowPlayingCandidates([
        video,
        ...resolvedNowPlayingTabIds
          .map((id) => findVideoByTabId(id))
          .filter(isVideoEligibleForNowPlaying),
      ]).map((entry) => entry.id);
    }
    pinnedNowPlayingTabId = null;
  } else {
    resolvedNowPlayingTabIds = resolvedNowPlayingTabIds.filter((id) => id !== tabId);
    pinnedNowPlayingTabId = tabId;
  }
  return activelyPlaying;
}

function syncUpNextIfNowPlayingChanged(previousIds: string): void {
  if (nowPlayingIdsFingerprint() === previousIds) return;
  resetVideoListFingerprint();
  updateVideoList(getVideosForUpNext());
}

function updateAlsoPlayingLine(confirmedPlaying: VideoData[], primary: VideoData): void {
  const alsoEl = document.getElementById("np-also-playing");
  if (!alsoEl) return;
  const others = confirmedPlaying.filter((video) => video.id !== primary.id);
  if (others.length === 0) {
    alsoEl.classList.add("hidden");
    alsoEl.textContent = "";
    return;
  }
  const preview = others
    .slice(0, 2)
    .map((video) => video.title)
    .join(", ");
  const extra = others.length > 2 ? ` (+${others.length - 2} more)` : "";
  alsoEl.textContent = `Also playing: ${preview}${extra}`;
  alsoEl.classList.remove("hidden");
}

async function getPlaybackState(tabId: number): Promise<PlaybackState | null> {
  try {
    const state = await browser.tabs.sendMessage(tabId, { action: "get-playback-state" });
    if (state && typeof state.paused === "boolean") return state as PlaybackState;
  } catch {
    // Content script may not be loaded yet
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const videoEl = document.querySelector("video");
        if (!videoEl) return { paused: true, volume: 1, muted: false, currentTime: 0 };
        return {
          paused: videoEl.paused,
          volume: videoEl.volume,
          muted: videoEl.muted,
          currentTime: videoEl.currentTime,
        };
      },
    });
    return (results[0]?.result as PlaybackState) ?? null;
  } catch {
    return null;
  }
}

async function togglePlayback(tabId: number): Promise<PlaybackState | null> {
  try {
    const state = await browser.tabs.sendMessage(tabId, { action: "toggle-play" });
    if (state && typeof state.paused === "boolean") return state as PlaybackState;
  } catch {
    // fall through
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const videoEl = document.querySelector("video");
        if (!videoEl) return { paused: true, volume: 1, muted: false, currentTime: 0 };
        if (videoEl.paused) void videoEl.play();
        else videoEl.pause();
        return {
          paused: videoEl.paused,
          volume: videoEl.volume,
          muted: videoEl.muted,
          currentTime: videoEl.currentTime,
        };
      },
    });
    return (results[0]?.result as PlaybackState) ?? null;
  } catch {
    return null;
  }
}

async function setPlaybackVolume(tabId: number, volume: number): Promise<PlaybackState | null> {
  try {
    const state = await browser.tabs.sendMessage(tabId, { action: "set-volume", volume });
    if (state && typeof state.volume === "number") return state as PlaybackState;
  } catch {
    // fall through
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [volume],
      func: (nextVolume: number) => {
        const videoEl = document.querySelector("video");
        if (!videoEl) return { paused: true, volume: 1, muted: false, currentTime: 0 };
        const clamped = Math.min(1, Math.max(0, nextVolume));
        videoEl.volume = clamped;
        if (clamped > 0 && videoEl.muted) videoEl.muted = false;
        return {
          paused: videoEl.paused,
          volume: videoEl.volume,
          muted: videoEl.muted,
          currentTime: videoEl.currentTime,
        };
      },
    });
    return (results[0]?.result as PlaybackState) ?? null;
  } catch {
    return null;
  }
}

const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>`;

function getConfirmedNowPlayingVideos(): VideoData[] {
  return resolvedNowPlayingTabIds
    .map((id) => findVideoByTabId(id))
    .filter(isVideoEligibleForNowPlaying);
}

function getThumbnailUrl(url: string): string | null {
  const id = getVideoIdFromUrl(url);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}

const SYNC_COOLDOWN_MS = 30_000;
let lastSyncTime = 0;

let renderTimeout: ReturnType<typeof setTimeout> | null = null;
let probeRenderTimeout: ReturnType<typeof setTimeout> | null = null;
const PROBE_RENDER_DEBOUNCE_MS = 100;
let lastVideoListFingerprint = "";
const LIVE_TICK_MS = 1000;
const NOW_PLAYING_DETECT_MS = 5000;
const NOW_PLAYING_REFINE_DEBOUNCE_MS = 300;
let liveTickInterval: ReturnType<typeof setInterval> | null = null;
let liveTickInFlight = false;
let lastNowPlayingDetectAt = 0;
let nowPlayingDetectPromise: Promise<VideoData[]> | null = null;
let nowPlayingRefineTimeout: ReturnType<typeof setTimeout> | null = null;
let lastVolumeInputTime = 0;

const app = document.getElementById("app")!;

function resetVideoListFingerprint(): void {
  lastVideoListFingerprint = "";
}

function videoListStructureFingerprint(videos: VideoData[]): string {
  const sig = videos
    .map(
      (video) =>
        `${video.id}|${video.url}|${video.title}|${video.channelName}|${video.seconds}|${video.isLive ? 1 : 0}|${video.excluded ? 1 : 0}|${video.suspended ? 1 : 0}|${video.active ? 1 : 0}|${video.audible ? 1 : 0}`
    )
    .join(";");
  return `${sortByDuration ? 1 : 0}|np:${nowPlayingIdsFingerprint()}|${sig}`;
}

function getQueueStats(): {
  totalSeconds: number;
  totalWatched: number;
  totalRemaining: number;
  videoCount: number;
} {
  const queueVideos = getQueueVideos();
  const totalSeconds = queueVideos.reduce((sum, video) => sum + video.seconds, 0);
  const totalWatched = queueVideos.reduce((sum, video) => sum + getEffectiveWatchedSeconds(video), 0);
  return {
    totalSeconds,
    totalWatched,
    totalRemaining: Math.max(0, totalSeconds - totalWatched),
    videoCount: queueVideos.length,
  };
}

function refreshQueueStatsFromState(): void {
  const { totalSeconds, totalWatched, totalRemaining, videoCount } = getQueueStats();
  updateHeaderStats(totalSeconds, totalRemaining, videoCount, totalWatched);
}

function startLiveTick(): void {
  if (liveTickInterval != null) return;
  liveTickInterval = setInterval(() => void livePlaybackTick(), LIVE_TICK_MS);
}

function stopLiveTick(): void {
  const primaryId = getNowPlayingTabId();
  const primary = primaryId ? findVideoByTabId(primaryId) : undefined;
  if (primary && primary.seconds > 0 && !primary.isLive) {
    persistVideoPlaybackToCache(primary);
  }

  if (liveTickInterval != null) {
    clearInterval(liveTickInterval);
    liveTickInterval = null;
  }
  if (nowPlayingRefineTimeout != null) {
    clearTimeout(nowPlayingRefineTimeout);
    nowPlayingRefineTimeout = null;
  }
  liveTickInFlight = false;
}

async function livePlaybackTick(): Promise<void> {
  if (liveTickInFlight) return;
  if (currentView !== "dashboard" || !document.getElementById("stat-remaining")) return;

  liveTickInFlight = true;
  try {
    const primaryId = getNowPlayingTabId();
    const primary = primaryId ? findVideoByTabId(primaryId) : undefined;

    if (primary) {
      const card = document.getElementById("np-card");
      const playback = await getPlaybackState(primary.id);
      if (card && playback) {
        primary.paused = playback.paused;
        primary.volume = playback.volume;
        primary.muted = playback.muted;
        applyPlaybackTimeToVideo(primary, playback.currentTime);
        updateNowPlayingCard(card, primary, playback, isTabActivelyPlaying(primary));
      }
    }

    refreshQueueStatsFromState();
    updateVideoListCardsFromState();

    const now = Date.now();
    if (now - lastNowPlayingDetectAt < NOW_PLAYING_DETECT_MS) return;
    lastNowPlayingDetectAt = now;

    const previousIds = nowPlayingIdsFingerprint();
    const previousPrimaryId = primaryId;
    const videos = await refreshNowPlayingDetection();
    const nextPrimary = videos[0] ?? null;

    if (nowPlayingIdsFingerprint() !== previousIds) {
      renderNowPlayingCard(nextPrimary, getConfirmedNowPlayingVideos());
      if (nextPrimary) {
        const card = document.getElementById("np-card");
        const playback = await getPlaybackState(nextPrimary.id);
        if (card && playback) {
          nextPrimary.paused = playback.paused;
          nextPrimary.volume = playback.volume;
          nextPrimary.muted = playback.muted;
          applyPlaybackTimeToVideo(nextPrimary, playback.currentTime);
          updateNowPlayingCard(card, nextPrimary, playback, isTabActivelyPlaying(nextPrimary));
        }
      }
      syncUpNextIfNowPlayingChanged(previousIds);
      return;
    }

    if (nextPrimary && nextPrimary.id === previousPrimaryId) {
      updateAlsoPlayingLine(getConfirmedNowPlayingVideos(), nextPrimary);
    }
  } finally {
    liveTickInFlight = false;
  }
}

function goToSettings(): void {
  currentView = "settings";
  render();
}

async function openManager(queryParameter = ""): Promise<void> {
  const managerBaseUrl = browser.runtime.getURL("/manager.html");
  const targetUrl = browser.runtime.getURL(`/manager.html${queryParameter}`);
  const tabs = await browser.tabs.query({ url: managerBaseUrl });
  if (tabs.length > 0 && tabs[0].id != null) {
    await browser.tabs.update(tabs[0].id, { url: targetUrl, active: true });
    if (tabs[0].windowId != null) {
      await browser.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await browser.tabs.create({ url: targetUrl });
  }
}

function renderNow(): void {
  if (currentView === "settings") {
    stopLiveTick();
    resetVideoListFingerprint();
    app.innerHTML = `
          <div data-v-header class="pt-3.5 px-4 pb-3 relative">
            <div class="flex items-center gap-2 mb-4">
              <button id="back-to-dashboard" class="popup-icon -ml-1" aria-label="Back">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <h2 class="font-display text-[18px] font-medium text-text-primary m-0">Settings</h2>
            </div>
            <div class="rounded-xl border border-border bg-surface-elevated px-3">
              <div class="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <div class="text-[12px] font-semibold text-text-primary">Appearance</div>
                  <div class="text-[10px] text-text-muted">System follows your computer</div>
                </div>
                <div id="appearance-control" class="shrink-0"></div>
              </div>
              <div class="flex items-center justify-between gap-3 py-2.5 border-t border-border">
                <div>
                  <div class="text-[12px] font-semibold text-text-primary">Clear video details</div>
                  <div class="text-[10px] text-text-muted">Titles and lengths load again from open tabs</div>
                </div>
                <button type="button" id="btn-clear-cache" class="chip chip--danger h-7 px-2.5 text-[12px] shrink-0">Clear</button>
              </div>
            </div>
            <div class="mt-3 pt-3 pb-0 border-t border-border/50 text-center">
              <div class="text-[11px] text-text-muted"><span class="font-display">Study Harvester</span> · v${VERSION_NUMBER}</div>
            </div>
          </div>
          <div id="popup-confirm-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm" aria-modal="true" role="dialog">
            <div class="bg-surface-elevated border border-border rounded-lg shadow-xl w-full max-w-[calc(100%-2rem)] mx-4 p-4">
              <h3 id="popup-confirm-title" class="text-sm font-bold text-text-primary mb-2"></h3>
              <p id="popup-confirm-message" class="text-xs text-text-secondary mb-4"></p>
              <div class="flex justify-end gap-2">
                <button type="button" id="popup-confirm-cancel" class="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-surface-hover text-text-primary hover:bg-surface cursor-pointer">Cancel</button>
                <button type="button" id="popup-confirm-ok" class="px-3 py-1.5 text-xs font-medium rounded-md border-0 bg-danger text-on-accent hover:bg-danger-hover cursor-pointer transition-colors">Clear</button>
              </div>
            </div>
          </div>
        `;
    const appearanceControl = document.getElementById("appearance-control");
    if (appearanceControl) {
      appearanceControl.innerHTML = THEME_CONTROL_HTML;
      mountThemeControl(appearanceControl);
    }
    document.getElementById("back-to-dashboard")!.addEventListener("click", () => {
      currentView = "dashboard";
      render();
    });

    document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
      const confirmed = await showConfirm({
        title: "Clear video details?",
        message: "Saved titles and lengths are forgotten and load again from open tabs. Sessions, history and settings stay.",
      });
      if (confirmed) {
        await clearCache();
        storeState.metadataCache = {};
        await getYouTubeTabs();
        currentView = "dashboard";
        render();
      }
    });
    return;
  }

  if (videoData.length === 0) {
    stopLiveTick();
    resetVideoListFingerprint();
    setupApp();
  if (!siteBlockLoaded) {
    siteBlockLoaded = true;
    void loadSiteBlock();
  }
    if (!siteBlockLoaded) {
      siteBlockLoaded = true;
      void loadSiteBlock();
    }

    document.getElementById("now-playing")?.classList.add("hidden");
    document.getElementById("up-next-divider")?.classList.add("hidden");

    updateHeaderStats(0, 0, 0, 0);

    const listEl = document.getElementById("video-list");
    if (listEl) {
      listEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full min-h-[260px] px-8 text-center">
          <p class="font-display text-xl text-text-primary mb-1">The desk is clear</p>
          <p class="text-xs text-text-muted leading-relaxed max-w-[240px]">Open YouTube videos in this window and they will line up here with the time they take.</p>
        </div>
      `;
    }
    return;
  }

  setupApp();
  document.getElementById("up-next-divider")?.classList.remove("hidden");

  const { totalSeconds, totalWatched, totalRemaining, videoCount } = getQueueStats();
  updateHeaderStats(totalSeconds, totalRemaining, videoCount, totalWatched);
  syncPopulateNowPlaying();
  startLiveTick();
  void refineNowPlaying();

  const queueVideos = getVideosForUpNext();
  const fp = videoListStructureFingerprint(queueVideos);
  const listEl = document.getElementById("video-list");

  if (fp === lastVideoListFingerprint && listEl) {
    updateVideoListCardsFromState();
    return;
  }

  lastVideoListFingerprint = fp;
  updateVideoList(queueVideos);
}

function scheduleProbeRender(): void {
  if (probeRenderTimeout != null) clearTimeout(probeRenderTimeout);
  probeRenderTimeout = setTimeout(() => {
    probeRenderTimeout = null;
    renderNow();
  }, PROBE_RENDER_DEBOUNCE_MS);
}

function flushProbeRender(): void {
  if (probeRenderTimeout != null) {
    clearTimeout(probeRenderTimeout);
    probeRenderTimeout = null;
  }
  renderNow();
}

function showConfirm(options: { title: string; message: string }): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = document.getElementById("popup-confirm-modal");
    const titleEl = document.getElementById("popup-confirm-title");
    const messageEl = document.getElementById("popup-confirm-message");
    const cancelBtn = document.getElementById("popup-confirm-cancel");
    const okBtn = document.getElementById("popup-confirm-ok");
    if (!modal || !titleEl || !messageEl || !cancelBtn || !okBtn) {
      resolve(false);
      return;
    }
    titleEl.textContent = options.title;
    messageEl.textContent = options.message;
    const close = (result: boolean) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
      modal.removeEventListener("click", onBackdrop);
    };
    const onCancel = () => close(false);
    const onOk = () => close(true);
    const onBackdrop = (e: MouseEvent) => {
      if ((e.target as HTMLElement).id === "popup-confirm-modal") close(false);
    };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  });
}

/* ───────────── This site: where the open tab's time goes ───────────── */

let siteBlockLoaded = false;
let sitePickerOpen = false;
let pickedPillarIndex: number | null = null;
let pickedActionId: string | null = null;
let pickedScope: "host" | "prefix" | null = null;
let siteBlockTab: Browser.tabs.Tab | null = null;
let siteBlockSummary: CachedMandalaSummary | null = null;
let siteBlockStatus: CurrentSiteResponse | null = null;

async function loadSiteBlock(): Promise<void> {
  const block = document.getElementById("site-block");
  if (!block) return;
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isTrackableUrl(tab.url)) {
      block.classList.add("hidden");
      return;
    }
    const [status, summary] = await Promise.all([
      browser.runtime.sendMessage({ action: "get-current-site", tabId: tab.id, url: tab.url }) as Promise<CurrentSiteResponse>,
      loadCachedMandalaSummary(),
    ]);
    siteBlockTab = tab;
    siteBlockSummary = summary;
    siteBlockStatus = status;
    renderSiteBlock();
  } catch {
    block.classList.add("hidden");
  }
}

function renderSiteBlock(): void {
  const block = document.getElementById("site-block");
  const tab = siteBlockTab;
  const status = siteBlockStatus;
  if (!block || !tab || !status || !isTrackableUrl(tab.url)) return;
  const host = hostOf(tab.url);
  const match = status.match;
  const swatch = match ? `<span class="inline-block w-2 h-2 rounded-full shrink-0" style="background:${pillarColor(match.pillarIndex)}"></span>` : "";
  const where = match ? matchWords(match, siteBlockSummary) : "Not counted";
  const minutes = match && status.todayMinutes > 0 ? ` · ${status.todayMinutes} min today` : "";
  const canRemove = match && match.ruleId && match.source !== "pile";
  const shownPillarIndex = pickedPillarIndex ?? match?.pillarIndex ?? pillarChoices(siteBlockSummary)[0]?.index ?? 0;

  block.classList.remove("hidden");
  block.innerHTML = `
    <div class="rounded-[10px] border border-border bg-surface-elevated px-3 py-2 flex flex-col gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <div class="flex-1 min-w-0 flex flex-col gap-0.5">
          <div class="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-muted truncate">This site · ${escapeText(host)}</div>
          <div class="text-[12px] text-text-primary flex items-center gap-1.5 min-w-0"><span class="truncate">${swatch} ${escapeText(where)}${escapeText(minutes)}</span></div>
        </div>
        <button type="button" id="site-pick" class="shrink-0 h-7 px-2.5 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer">${match ? "Change" : "Count for…"}</button>
      </div>
      ${
        sitePickerOpen
          ? `<div class="flex flex-col gap-1.5 pt-1 border-t border-border/60">
              ${
                siteBlockSummary
                  ? ""
                  : `<p class="m-0 text-[10px] text-text-muted">Open Mandala once so your pillars show here. Until then the rule counts for a pillar by its number.</p>`
              }
              <div class="grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5 text-[11px] text-text-secondary">
                <span>Pillar</span><div id="site-pillar"></div>
                <span>Action</span><div id="site-action"></div>
                <span>Scope</span><div id="site-scope"></div>
              </div>
              <div class="flex items-center gap-2 pt-0.5">
                <button type="button" id="site-save" class="h-7 px-3 rounded-md border-0 bg-accent text-on-accent text-[11px] font-semibold cursor-pointer hover:bg-accent-hover transition-colors">Count it</button>
                ${canRemove ? `<button type="button" id="site-remove" class="h-7 px-2.5 rounded-md border border-border bg-surface text-[11px] font-medium text-text-secondary hover:text-danger hover:border-danger/40 cursor-pointer transition-colors">Stop counting</button>` : ""}
                <span class="flex-1"></span>
                <button type="button" id="site-cancel" class="h-7 px-2 rounded-md border-0 bg-transparent text-[11px] text-text-muted hover:text-text-primary cursor-pointer">Cancel</button>
              </div>
            </div>`
          : ""
      }
    </div>
  `;

  const shownActionId = pickedActionId ?? (pickedPillarIndex === null ? (match?.actionId ?? "") : "");
  const shownScope = pickedScope ?? (match?.source === "prefix" ? "prefix" : "host");
  const pillarRoot = document.getElementById("site-pillar");
  const actionRoot = document.getElementById("site-action");
  const scopeRoot = document.getElementById("site-scope");
  if (pillarRoot && actionRoot && scopeRoot) {
    mountCustomSelect(pillarRoot, {
      options: pillarSelectOptions(siteBlockSummary),
      value: String(shownPillarIndex),
      block: true,
      size: "small",
      ariaLabel: "Pillar",
      onChange: (value) => {
        pickedPillarIndex = Number(value);
        pickedActionId = "";
        renderSiteBlock();
      },
    });
    mountCustomSelect(actionRoot, {
      options: actionSelectOptions(siteBlockSummary, shownPillarIndex),
      value: shownActionId,
      block: true,
      size: "small",
      ariaLabel: "Action",
      onChange: (value) => (pickedActionId = value),
    });
    mountCustomSelect(scopeRoot, {
      options: [
        { value: "host", label: `Whole site (${host})` },
        { value: "prefix", label: "This page and what is under it" },
      ],
      value: shownScope,
      block: true,
      size: "small",
      ariaLabel: "Scope",
      onChange: (value) => (pickedScope = value === "prefix" ? "prefix" : "host"),
    });
  }

  const resetPicks = () => {
    pickedPillarIndex = null;
    pickedActionId = null;
    pickedScope = null;
  };
  document.getElementById("site-pick")?.addEventListener("click", () => {
    sitePickerOpen = !sitePickerOpen;
    resetPicks();
    renderSiteBlock();
  });
  document.getElementById("site-cancel")?.addEventListener("click", () => {
    sitePickerOpen = false;
    resetPicks();
    renderSiteBlock();
  });
  document.getElementById("site-save")?.addEventListener("click", async () => {
    const pillarIndex = shownPillarIndex;
    const actionId = (pickedActionId ?? shownActionId) || undefined;
    const scope = pickedScope ?? shownScope;
    const pattern = scope === "host" ? host : pagePrefixOf(tab.url!);
    const rule: Omit<SiteRule, "id" | "createdAt"> & { id?: string } = {
      id: match?.ruleId && match.source === scope ? match.ruleId : undefined,
      kind: scope,
      pattern,
      label: scope === "host" ? host : pattern.replace(/^https?:\/\//, ""),
      pillarIndex,
      actionId,
    };
    await browser.runtime.sendMessage({ action: "set-site-rule", rule });
    sitePickerOpen = false;
    resetPicks();
    await loadSiteBlock();
  });
  document.getElementById("site-remove")?.addEventListener("click", async () => {
    if (match?.ruleId) await browser.runtime.sendMessage({ action: "remove-site-rule", id: match.ruleId });
    sitePickerOpen = false;
    resetPicks();
    await loadSiteBlock();
  });
}

function setupApp() {
  // Check if the dashboard shell is actually present, not just "not empty"
  // logic: if 'stat-total' exists, we are in the dashboard view.
  if (document.getElementById("stat-total")) return;

  app.innerHTML = `
    <div class="flex flex-col h-popup max-h-popup w-full bg-surface overflow-hidden">
      <header data-v-header class="shrink-0 px-4 pt-3.5 pb-1">
        <div class="flex items-center gap-1">
          <span class="font-display text-[18px] font-medium text-text-primary leading-none flex-1 min-w-0 truncate">Study Harvester</span>
          <span class="inline-flex items-center gap-1 px-1.5 py-0.5 mr-1 rounded-full text-[9px] font-semibold bg-success/12 text-success border border-success/30" title="WebMCP active"><span class="w-1.5 h-1.5 rounded-full bg-success"></span>WebMCP</span>
          <button id="refresh-tabs" type="button" class="popup-icon group/refresh" title="Refresh tabs" aria-label="Refresh tabs"><span class="group-active/refresh:rotate-180 transition-transform duration-500 flex"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></span></button>
          <button id="go-to-settings" type="button" class="popup-icon" title="Settings" aria-label="Settings"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
        </div>
        <div class="mt-4 flex flex-col gap-2.5">
          <div class="font-display text-[34px] leading-none tracking-[-0.02em] text-text-primary"><span id="stat-remaining">0 min</span> <span class="text-text-muted">left</span></div>
          <div class="h-1 rounded-full bg-border overflow-hidden"><div id="stat-overall-progress" class="h-full rounded-full bg-accent transition-[width] duration-700" style="width: 0%"></div></div>
          <div class="flex items-center justify-between gap-2 text-[12px] text-text-secondary tabular-nums">
            <span id="stat-video-count">0 videos</span>
            <span><span id="stat-watched">0 min</span> watched · <span id="stat-watched-pct">0%</span></span>
          </div>
          <div id="popup-lang-bar" class="popup-lang-bar hidden" role="img" aria-label="Time left by language"></div>
          <span id="stat-total" class="hidden"></span>
        </div>
      </header>

      <section id="site-block" class="hidden shrink-0 px-3 pt-2.5"></section>

      <section id="now-playing" class="hidden shrink-0 px-3 pt-3">
        <div id="np-card" class="np-card" data-np-tab-id="">
          <div class="flex gap-3">
            <button type="button" class="np-thumb-btn relative shrink-0 w-[8.25rem] aspect-video rounded-lg overflow-hidden bg-surface-hover border-0 p-0 cursor-pointer" title="Open tab" aria-label="Open tab">
              <img class="np-thumb w-full h-full object-cover hidden" alt="" width="132" height="74" />
              <div class="absolute bottom-0 left-0 right-0 h-[3px] bg-black/40">
                <div class="np-progress h-full bg-accent transition-[width] duration-500" style="width: 0%"></div>
              </div>
            </button>
            <div class="flex-1 min-w-0 flex flex-col justify-center gap-1">
              <div class="np-kicker text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">Playing now</div>
              <button type="button" class="np-title font-display text-left text-[17px] font-medium leading-tight text-text-primary line-clamp-2 border-0 bg-transparent p-0 cursor-pointer hover:text-accent transition-colors" title="Open tab"></button>
              <p class="np-channel text-[12px] text-text-muted truncate m-0"></p>
            </div>
          </div>
          <div class="mt-2.5 flex items-center gap-2.5">
            <button type="button" class="np-play-pause w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-accent text-on-accent border-0 cursor-pointer hover:bg-accent-hover active:scale-95 transition-colors" title="Play / Pause"></button>
            <span class="np-time text-[12px] text-text-secondary tabular-nums shrink-0 min-w-[5rem]"></span>
            <svg class="np-volume-icon shrink-0 text-text-muted" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            <div class="flex-1 min-w-0 flex items-center h-3">
              <input type="range" class="np-volume ui-range w-full" min="0" max="100" value="0" aria-label="Volume" />
            </div>
            <button type="button" class="np-go-to-tab shrink-0 text-[12px] font-semibold text-accent hover:text-accent-hover border-0 bg-transparent p-0 cursor-pointer" title="Go to tab">Go to tab</button>
          </div>
        </div>
        <p id="np-also-playing" class="hidden px-1 pt-1.5 text-[11px] text-text-muted truncate m-0"></p>
      </section>

      <div id="up-next-divider" class="flex items-center gap-3 px-4 pt-4 pb-1 shrink-0">
        <span class="font-display text-[17px] font-medium text-text-primary flex-1">Up next</span>
        <span class="inline-flex gap-0.5 rounded-lg border border-border bg-surface p-0.5" role="group" aria-label="Order">
          <button id="sort-order" type="button" class="theme-option theme-option--small" aria-pressed="true">Tab order</button>
          <button id="sort-duration" type="button" class="theme-option theme-option--small" aria-pressed="false">Longest first</button>
        </span>
      </div>

      <div id="video-list" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"></div>

      <footer class="shrink-0 px-3 py-3 border-t border-border bg-surface flex items-center gap-2">
        <button id="popup-stage-study" type="button" class="flex-1 h-[38px] rounded-[10px] border-0 bg-accent text-on-accent text-[13px] font-semibold flex items-center justify-center gap-2 cursor-pointer hover:bg-accent-hover transition-colors active:scale-[0.98]" title="Start a focused study session from this window's tabs">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Start study session
        </button>
        <button id="open-manager" type="button" class="h-[38px] px-3.5 rounded-[10px] border border-border bg-surface-elevated text-text-primary text-[13px] font-medium cursor-pointer hover:bg-surface-hover transition-colors" title="Open the full desk">Open desk</button>
        <button id="popup-reading-list" type="button" class="h-[38px] px-3 rounded-[10px] border border-border bg-surface-elevated text-text-secondary text-[12px] font-medium cursor-pointer hover:bg-surface-hover transition-colors flex items-center gap-1.5" title="Open reading list on the desk">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z"/><path d="M6 6h10"/></svg>
          <span id="popup-reading-count" class="tabular-nums">0</span>
        </button>
      </footer>
    </div>
  `;

  document.getElementById("go-to-settings")?.addEventListener("click", goToSettings);
  document.getElementById("open-manager")?.addEventListener("click", () => {
    void openManager();
  });
  document.getElementById("popup-reading-list")?.addEventListener("click", () => {
    void openManager("?view=reading-list");
  });
  document.getElementById("popup-stage-study")?.addEventListener("click", async () => {
    const queueVideos = getQueueVideos();
    if (queueVideos.length === 0) return;
    const orderedTabIds = queueVideos.map((video) => video.id);
    try {
      const response = await browser.runtime.sendMessage({
        action: "stage-focused-study-queue",
        payload: {
          orderedTabIds,
          stashDistractionTabs: false,
          playbackSpeed: 1.0,
        },
      });
      if (response?.success) {
        window.close();
      }
    } catch (error) {
      console.warn("Failed to stage study queue from popup:", error);
    }
  });
  document.getElementById("refresh-tabs")?.addEventListener("click", getYouTubeTabs);
  document.getElementById("sort-order")?.addEventListener("click", () => {
    sortByDuration = false;
    saveStorage();
    render();
  });
  document.getElementById("sort-duration")?.addEventListener("click", () => {
    sortByDuration = true;
    saveStorage();
    render();
  });

  bindNowPlayingCardEvents();

  document.getElementById("video-list")?.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest("button");
    if (!button) return;
    const item = button.closest<HTMLElement>("[data-id]");
    const tabId = item ? parseInt(item.dataset.id || "0", 10) : 0;
    if (!tabId) return;
    const video = videoData.find((entry) => entry.id === tabId);
    if (!video) return;

    if (button.classList.contains("jump-btn")) {
      await browser.tabs.update(tabId, { active: true });
      return;
    }
    if (button.classList.contains("toggle-btn")) {
      video.excluded = !video.excluded;
      render();
      saveStorage();
      return;
    }
    if (button.classList.contains("wake-up-btn")) {
      button.innerText = "Waking...";
      (button as HTMLButtonElement).disabled = true;
      await browser.tabs.update(tabId, { active: true });
      setTimeout(getYouTubeTabs, 1500);
    }
  });
}

const VOLUME_ICON_LOW = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>`;
const VOLUME_ICON_MED = `${VOLUME_ICON_LOW}<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
const VOLUME_ICON_HIGH = `${VOLUME_ICON_MED}<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`;
const VOLUME_ICON_MUTE = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/>`;

function bindNowPlayingCardEvents(): void {
  const card = document.getElementById("np-card");
  if (!card || card.dataset.bound === "1") return;
  card.dataset.bound = "1";

  card.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const tabId = parseInt(card.dataset.npTabId || "0", 10);
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;

    if (target.closest(".np-play-pause")) {
      const previousIds = nowPlayingIdsFingerprint();
      const state = await togglePlayback(tabId);
      if (!state) return;
      const activelyPlaying = applyLocalPlaybackControl(tabId, video, state);
      updateNowPlayingCard(card, video, state, activelyPlaying);
      refreshQueueStatsFromState();
      syncUpNextIfNowPlayingChanged(previousIds);
      if (activelyPlaying) void persistLastPlayingTabId(tabId);
      scheduleNowPlayingRefine();
      return;
    }

    if (target.closest(".np-go-to-tab") || target.closest(".np-title") || target.closest(".np-thumb-btn")) {
      await browser.tabs.update(tabId, { active: true });
      if (video.windowId != null) {
        await browser.windows.update(video.windowId, { focused: true });
      }
    }
  });

  card.addEventListener("input", async (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("np-volume")) return;
    syncRangeFill(target as HTMLInputElement);
    const tabId = parseInt(card.dataset.npTabId || "0", 10);
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;
    lastVolumeInputTime = Date.now();
    const value = parseInt((target as HTMLInputElement).value, 10);
    const volumeIcon = card.querySelector(".np-volume-icon") as SVGElement | null;
    if (volumeIcon) {
      const vol = value / 100;
      const paths =
        vol === 0 ? VOLUME_ICON_MUTE : vol < 0.35 ? VOLUME_ICON_LOW : vol < 0.7 ? VOLUME_ICON_MED : VOLUME_ICON_HIGH;
      volumeIcon.innerHTML = paths;
    }
    const state = await setPlaybackVolume(tabId, value / 100);
    if (!state) return;
    const activelyPlaying = applyLocalPlaybackControl(tabId, video, state);
    updateNowPlayingCard(card, video, state, activelyPlaying);
    void persistLastPlayingTabId(tabId);
    scheduleNowPlayingRefine();
  });

  card.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("np-volume")) return;
    const tabId = parseInt(card.dataset.npTabId || "0", 10);
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;
    const value = parseInt((target as HTMLInputElement).value, 10);
    video.volume = value / 100;
    video.muted = value === 0;
    persistVideoPlaybackToCache(video);
  });
}

function updateNowPlayingCardTime(card: HTMLElement, video: VideoData): void {
  const watchedPercent = getWatchedPercent(video);
  const progressEl = card.querySelector(".np-progress") as HTMLElement | null;
  if (progressEl) {
    if (video.isLive) {
      progressEl.style.width = "0%";
    } else {
      progressEl.style.width = `${watchedPercent}%`;
    }
  }

  const timeEl = card.querySelector(".np-time") as HTMLElement | null;
  if (!timeEl) return;

  if (video.isLive) {
    timeEl.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-youtube/15 text-youtube text-[9px] font-bold">LIVE</span>`;
  } else if (video.seconds > 0) {
    timeEl.innerHTML = `
      <span class="${watchedPercent > 0 ? "text-text-secondary" : ""}">${formatCompact(video.currentTime)}</span>
      <span class="mx-0.5 opacity-30">/</span>
      <span>${formatCompact(video.seconds)}</span>
    `;
  } else {
    timeEl.innerText = formatCompact(video.currentTime);
  }
}

function updateNowPlayingCard(
  card: HTMLElement,
  video: VideoData,
  state: PlaybackState,
  isActivelyPlaying: boolean
): void {
  card.dataset.npTabId = String(video.id);

  const channelEl = card.querySelector(".np-channel") as HTMLElement | null;
  const channelName = formatNowPlayingChannelName(video);
  if (channelEl) {
    channelEl.textContent = channelName || "\u00a0";
    channelEl.classList.toggle("invisible", !channelName);
  }

  const titleEl = card.querySelector(".np-title") as HTMLElement | null;
  if (titleEl) {
    titleEl.textContent = video.title;
    titleEl.title = video.title;
  }

  const thumbEl = card.querySelector(".np-thumb") as HTMLImageElement | null;
  const thumbUrl = getThumbnailUrl(video.url);
  if (thumbEl) {
    if (thumbUrl) {
      if (thumbEl.src !== thumbUrl) thumbEl.src = thumbUrl;
      thumbEl.classList.remove("hidden");
    } else {
      thumbEl.removeAttribute("src");
      thumbEl.classList.add("hidden");
    }
  }

  updateNowPlayingCardTime(card, video);

  const playBtn = card.querySelector(".np-play-pause") as HTMLButtonElement | null;
  const volumeInput = card.querySelector(".np-volume") as HTMLInputElement | null;
  const volumeIcon = card.querySelector(".np-volume-icon") as SVGElement | null;

  if (playBtn) {
    playBtn.innerHTML = state.paused ? PLAY_ICON : PAUSE_ICON;
    playBtn.title = state.paused ? "Play" : "Pause";
  }
  if (volumeInput) {
    const isInteracting = document.activeElement === volumeInput && (Date.now() - lastVolumeInputTime < 1500);
    if (!isInteracting) {
      const displayVolume = state.muted ? 0 : Math.round(state.volume * 100);
      volumeInput.value = String(displayVolume);
      syncRangeFill(volumeInput);
    }
  }
  if (volumeIcon) {
    const vol = state.muted ? 0 : state.volume;
    const paths =
      vol === 0 ? VOLUME_ICON_MUTE : vol < 0.35 ? VOLUME_ICON_LOW : vol < 0.7 ? VOLUME_ICON_MED : VOLUME_ICON_HIGH;
    volumeIcon.innerHTML = paths;
  }
  card.className = `np-card${isActivelyPlaying ? " np-card--playing" : ""}`;
  const kicker = card.querySelector(".np-kicker") as HTMLElement | null;
  if (kicker) kicker.textContent = isActivelyPlaying ? "Playing now" : "Paused";
}

function renderNowPlayingCard(primary: VideoData | null, confirmedPlaying: VideoData[]): void {
  const section = document.getElementById("now-playing");
  const alsoEl = document.getElementById("np-also-playing");
  const card = document.getElementById("np-card");
  if (!section || !card) return;

  if (!primary) {
    section.classList.add("hidden");
    section.removeAttribute("data-tab-id");
    card.dataset.npTabId = "";
    if (alsoEl) {
      alsoEl.classList.add("hidden");
      alsoEl.textContent = "";
    }
    return;
  }

  section.classList.remove("hidden");
  section.dataset.tabId = String(primary.id);

  updateNowPlayingCard(
    card,
    primary,
    {
      paused: primary.paused ?? !isTabActivelyPlaying(primary),
      volume: primary.volume ?? 1,
      muted: primary.muted ?? false,
      currentTime: primary.currentTime,
    },
    isTabActivelyPlaying(primary)
  );

  updateAlsoPlayingLine(confirmedPlaying, primary);
}

function formatNowPlayingChannelName(video: VideoData): string {
  if (!video.channelName || video.channelName === "YouTube" || video.channelName === "YouTube Video") {
    return "";
  }
  return video.channelName;
}

function syncPopulateNowPlaying(): void {
  renderNowPlayingCard(getPrimaryNowPlayingSync(), getConfirmedNowPlayingVideos());
}

async function refineNowPlaying(): Promise<void> {
  const previousIds = nowPlayingIdsFingerprint();
  const previousPrimaryId = getNowPlayingTabId();
  const videos = await refreshNowPlayingDetection();
  lastNowPlayingDetectAt = Date.now();
  const confirmed = getConfirmedNowPlayingVideos();
  const primary = videos[0] ?? null;

  if (!primary || primary.id !== previousPrimaryId) {
    renderNowPlayingCard(primary, confirmed);
  } else {
    updateAlsoPlayingLine(confirmed, primary);
    const card = document.getElementById("np-card");
    if (card) {
      const playback = await getPlaybackState(primary.id);
      if (playback) {
        primary.paused = playback.paused;
        primary.volume = playback.volume;
        primary.muted = playback.muted;
        applyPlaybackTimeToVideo(primary, playback.currentTime);
        updateNowPlayingCard(card, primary, playback, isTabActivelyPlaying(primary));
      }
    }
  }

  syncUpNextIfNowPlayingChanged(previousIds);
}

function updateHeaderStats(
  totalSeconds: number,
  totalRemaining: number,
  videoCount: number,
  totalWatched = 0
) {
  document.getElementById("stat-remaining")!.innerText = formatDurationWords(totalRemaining);
  document.getElementById("stat-total")!.innerText = formatTime(totalSeconds);
  document.getElementById("stat-video-count")!.innerText =
    `${videoCount} video${videoCount === 1 ? "" : "s"} · ${formatDurationWords(totalSeconds)} in total`;

  const watchedEl = document.getElementById("stat-watched");
  if (watchedEl) watchedEl.innerText = formatDurationWords(totalWatched);

  const percent = totalSeconds > 0 ? (totalWatched / totalSeconds) * 100 : 0;
  const watchedPctEl = document.getElementById("stat-watched-pct");
  if (watchedPctEl) {
    const rounded = Math.round(percent);
    watchedPctEl.textContent =
      rounded >= 100 ? "Done" : rounded > 0 ? `${rounded}%` : "0%";
  }

  const overallProgress = document.getElementById("stat-overall-progress");
  if (overallProgress) {
    overallProgress.style.width = `${percent}%`;
  }
  renderPopupLanguageBar();

  const btnTab = document.getElementById("sort-order");
  const btnLen = document.getElementById("sort-duration");
  btnTab?.setAttribute("aria-pressed", String(!sortByDuration));
  btnLen?.setAttribute("aria-pressed", String(sortByDuration));

  void queryReadingList(false).then((items) => {
    const badgeElement = document.getElementById("popup-reading-count");
    if (badgeElement) badgeElement.textContent = String(items.length);
  });
}

const POPUP_LANGUAGE_PALETTE = [
  "var(--section-coral)",
  "var(--section-amber)",
  "var(--section-lime)",
  "var(--section-teal)",
  "var(--section-sky)",
  "var(--section-indigo)",
  "var(--section-violet)",
  "var(--section-rose)",
];

function popupLanguageLabel(video: VideoData): string | null {
  const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
  if (stripped) return stripped;
  if (video.language) return video.language.toUpperCase();
  return null;
}

/** One proportional strip of the time left, split by language, so the popup matches the desk. */
function renderPopupLanguageBar(): void {
  const bar = document.getElementById("popup-lang-bar");
  if (!bar) return;
  const totals = new Map<string, number>();
  for (const video of videoData) {
    if (video.excluded || video.isLive || video.seconds <= 0) continue;
    const label = popupLanguageLabel(video) ?? "Unknown";
    totals.set(label, (totals.get(label) ?? 0) + Math.max(0, video.seconds - video.currentTime));
  }
  const entries = Array.from(totals.entries()).filter(([, seconds]) => seconds > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, seconds]) => sum + seconds, 0);
  if (entries.length < 2 || total <= 0) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = entries
    .map(([label, seconds], index) => {
      const share = (seconds / total) * 100;
      const color = label === "Unknown" ? "var(--color-border-hover)" : POPUP_LANGUAGE_PALETTE[index % POPUP_LANGUAGE_PALETTE.length];
      const text = share >= 18 ? `<span class="popup-lang-label">${label}</span>` : "";
      return `<span class="popup-lang-seg" style="width: ${share.toFixed(1)}%; background: ${color}" title="${label}: ${formatDurationWords(seconds)}">${text}</span>`;
    })
    .join("");
}

function updateVideoListItem(item: HTMLElement, video: VideoData): void {
  const watchedPercent = getWatchedPercent(video);
  const isNowPlaying = isTabActivelyPlaying(video);
  const isActiveTab = video.active && !isNowPlaying;
  const stateClasses = isNowPlaying
    ? "bg-accent/8"
    : isActiveTab
      ? "bg-surface-hover/50 hover:bg-surface-hover/70"
      : "hover:bg-surface-hover/60";
  item.className = `group relative flex h-[3.75rem] shrink-0 items-center gap-2.5 overflow-hidden px-2 rounded-[10px] transition-[background-color,opacity] duration-200 ${stateClasses} ${
    video.excluded ? "opacity-40 grayscale" : "opacity-100"
  }`;

  const thumbEl = item.querySelector(".meta-thumb") as HTMLImageElement;
  const thumbUrl = getThumbnailUrl(video.url);
  if (thumbUrl) {
    thumbEl.src = thumbUrl;
    thumbEl.classList.remove("hidden");
  } else {
    thumbEl.removeAttribute("src");
    thumbEl.classList.add("hidden");
  }

  const channelEl = item.querySelector(".meta-channel") as HTMLElement;
  const channelLabel =
    video.channelName && video.channelName !== "YouTube" && video.channelName !== "YouTube Video"
      ? video.channelName
      : video.suspended
        ? "Suspended tab"
        : "YouTube";
  channelEl.innerText = channelLabel;
  const avatarEl = item.querySelector(".meta-avatar") as HTMLImageElement | null;
  if (avatarEl) {
    const avatar = popupChannelAvatars[video.channelName?.trim() ?? ""];
    if (avatar && avatarEl.getAttribute("src") !== avatar) avatarEl.src = avatar;
    avatarEl.classList.toggle("hidden", !avatar);
  }

  const titleEl = item.querySelector(".meta-title") as HTMLElement;
  titleEl.innerText = video.title;
  titleEl.title = video.title;

  const langEl = item.querySelector(".meta-lang") as HTMLElement | null;
  if (langEl) {
    const label = popupLanguageLabel(video);
    langEl.textContent = label ?? "";
    langEl.classList.toggle("hidden", label == null);
  }

  const progressTrack = item.querySelector(".meta-progress-track") as HTMLElement | null;
  if (progressTrack) progressTrack.classList.toggle("hidden", isNowPlaying);

  const progressEl = item.querySelector(".meta-progress") as HTMLElement;
  progressEl.style.width = `${watchedPercent}%`;

  const badgeEl = item.querySelector(".meta-duration-badge") as HTMLElement;
  const timeEl = item.querySelector(".meta-time") as HTMLElement;
  if (video.isLive) {
    badgeEl.innerHTML = `<span class="px-1 py-px rounded text-[10px] font-bold bg-youtube text-white">LIVE</span>`;
    badgeEl.classList.remove("hidden");
    timeEl.classList.add("hidden");
  } else if (video.seconds > 0) {
    badgeEl.innerText = formatCompact(video.seconds);
    badgeEl.classList.remove("hidden");
    timeEl.classList.remove("hidden");
    timeEl.innerHTML = `
            <span class="${watchedPercent > 0 ? "text-text-secondary" : "text-text-muted"}">${formatCompact(video.currentTime)}</span>
            <span class="opacity-40"> / </span>
            <span>${formatCompact(video.seconds)}</span>
          `;
  } else if (video.suspended) {
    badgeEl.innerText = "—";
    badgeEl.classList.remove("hidden");
    timeEl.innerHTML = `<span class="text-warning">Suspended</span>`;
    timeEl.classList.remove("hidden");
  } else {
    badgeEl.classList.add("hidden");
    timeEl.innerHTML = `<span class="text-text-muted">Loading…</span>`;
    timeEl.classList.remove("hidden");
  }

  const nowPlayingBadge = item.querySelector(".meta-now-badge") as HTMLElement;
  if (nowPlayingBadge) {
    nowPlayingBadge.classList.toggle("hidden", !isNowPlaying);
  }

  const controls = item.querySelector(".meta-controls") as HTMLElement;
  const controlsKey = `${video.suspended ? 1 : 0}|${video.excluded ? 1 : 0}`;
  if (item.dataset.controlsKey !== controlsKey) {
    item.dataset.controlsKey = controlsKey;
    controls.innerHTML = `
          <button class="shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-text-muted border-0 bg-transparent cursor-pointer transition-colors hover:bg-surface-hover hover:text-text-primary active:scale-[0.96] jump-btn" title="Go to tab" aria-label="Go to tab">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          </button>
          ${
            video.suspended
              ? `<button class="shrink-0 text-[11px] px-2 h-7 rounded-md bg-warning/15 text-warning border-0 cursor-pointer transition-colors hover:bg-warning/25 font-semibold active:scale-[0.96] wake-up-btn">Wake</button>`
              : ""
          }
          <button class="shrink-0 text-[11px] px-2 h-7 rounded-md text-text-muted border-0 bg-transparent cursor-pointer transition-colors hover:bg-surface-hover hover:text-text-primary font-medium active:scale-[0.96] toggle-btn">${
            video.excluded ? "Count it" : "Skip"
          }</button>
      `;
  }
}

function updateVideoListCardsFromState(): void {
  document.querySelectorAll("#video-list [data-id]").forEach((card) => {
    const id = parseInt((card as HTMLElement).dataset.id || "0", 10);
    const video = videoData.find((entry) => entry.id === id);
    if (!video) return;
    updateVideoListItem(card as HTMLElement, video);
  });
}

function updateVideoList(videos: VideoData[]) {
  const container = document.getElementById("video-list")!;
  const currentIds = new Set(videos.map((v) => v.id));

  // 1. Remove stale
  Array.from(container.children).forEach((child) => {
    const id = parseInt((child as HTMLElement).dataset.id || "0");
    if (!currentIds.has(id)) child.remove();
  });

  // 2. Create/Update (preserve DOM nodes; reorder to match sort)
  let elapsed = 0;
  videos.forEach((video, index) => {
    let item = document.getElementById(`video-item-${video.id}`);

    if (!item) {
      item = document.createElement("div");
      item.id = `video-item-${video.id}`;
      item.dataset.id = video.id.toString();
      item.style.viewTransitionName = `video-${video.id}`;
      item.className =
        "group relative flex h-[3.75rem] shrink-0 items-center gap-2.5 overflow-hidden px-2 rounded-[10px] transition-[background-color,opacity] duration-200";
      item.innerHTML = `
            <div class="relative shrink-0 w-[4.5rem] aspect-video rounded-md overflow-hidden bg-surface-hover">
              <img class="meta-thumb w-full h-full object-cover hidden" alt="" />
              <div class="meta-duration-badge absolute bottom-[3px] right-[3px] px-1 py-px rounded-[3px] text-[10px] font-medium bg-black/80 text-white tabular-nums leading-none"></div>
              <div class="meta-progress-track absolute bottom-0 left-0 right-0 h-[3px] bg-black/40">
                <div class="meta-progress h-full bg-accent transition-[width] duration-700" style="width: 0%"></div>
              </div>
            </div>
            <div class="flex-1 min-w-0 flex flex-col justify-center gap-[2px]">
              <span class="meta-now-badge hidden self-start text-[9px] font-semibold uppercase tracking-[0.1em] text-accent leading-none">Playing</span>
              <div class="meta-title text-[13px] font-medium text-text-primary truncate leading-snug"></div>
              <div class="flex items-center gap-1.5 min-w-0"><img class="meta-avatar ui-avatar w-3.5 h-3.5 hidden" alt="" referrerpolicy="no-referrer" /><div class="meta-channel text-[11px] text-text-muted truncate"></div></div>
              <div class="flex items-center gap-1.5 min-w-0">
                <span class="meta-lang hidden text-[9px] font-bold uppercase tracking-wide px-1.5 py-px rounded-full bg-accent/10 text-accent shrink-0"></span>
                <div class="meta-time text-[10px] text-text-muted tabular-nums truncate"></div>
              </div>
            </div>
            <span class="meta-offset text-[11px] text-text-muted tabular-nums shrink-0 whitespace-nowrap"></span>
            <div class="meta-controls absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity bg-surface-elevated rounded-lg p-0.5 shadow-lg ring-1 ring-border"></div>
          `;

      container.appendChild(item);
    }

    updateVideoListItem(item, video);

    const offsetEl = item.querySelector(".meta-offset") as HTMLElement | null;
    const countsTowardQueue = !video.excluded && !video.isLive && !isTabActivelyPlaying(video);
    if (offsetEl) offsetEl.textContent = countsTowardQueue ? formatOffset(elapsed) : "";
    if (countsTowardQueue) elapsed += Math.max(0, video.seconds - video.currentTime);

    const referenceNode = container.children[index];
    if (referenceNode !== item) {
      container.insertBefore(item, referenceNode ?? null);
    }
  });
}

function render(): void {
  if (renderTimeout != null) clearTimeout(renderTimeout);

  renderTimeout = setTimeout(() => {
    renderTimeout = null;
    renderNow();
  }, 0);
}

async function getYouTubeTabs(): Promise<void> {
  try {
    const [state, allTabs, currentWindow] = await Promise.all([
      fetchStoreState(),
      browser.tabs.query({}),
      browser.windows.getCurrent(),
    ]);
    storeState = state;
    const { prefs, metadataCache } = storeState;

    popupWindowId = currentWindow.id ?? null;
    sortByDuration = prefs.sortByDuration;

    const tabs = allTabs.filter((tab) => {
      if (!tab.url) return false;
      try {
        const url = new URL(tab.url);
        return (
          (url.hostname.endsWith("youtube.com") || url.hostname === "youtube.com") &&
          (url.pathname.startsWith("/watch") || url.pathname.startsWith("/shorts")) &&
          !tab.url.includes("exclude_blobs")
        );
      } catch {
        return false;
      }
    });

    resetVideoListFingerprint();
    resolvedNowPlayingTabIds = [];
    pinnedNowPlayingTabId = null;
    videoData = tabs.map((tab, index) => {
      const video = buildVideoFromTab(tab, index, prefs.excludedUrls);
      const cached = lookupCachedMetadata(metadataCache, video.url);
      if (cached) applyCachedMetadataToVideo(video, cached);
      return video;
    });

    if (popupWindowId != null) {
      lastPlayingTabId = await loadLastPlayingTabId(popupWindowId);
      const audibleInWindow = videoData.filter(
        (video) =>
          !video.excluded &&
          !video.suspended &&
          video.windowId === popupWindowId &&
          video.audible
      );
      if (audibleInWindow.length > 0) {
        const playing = audibleInWindow[0];
        if (playing) await persistLastPlayingTabId(playing.id);
      } else if (lastPlayingTabId) {
        const last = videoData.find((video) => video.id === lastPlayingTabId);
        if (!isVideoEligibleForNowPlaying(last)) {
          await clearLastPlayingTabId();
        }
      }
    }

    render();

    const activeTabPromises = videoData.map(async (video) => {
      if (video.suspended) return;

      const hasValidMetadata = video.seconds > 0 &&
                               video.title !== "YouTube Video" &&
                               video.title !== "YouTube" &&
                               !/^\(\d+\)\s*/.test(video.title);

      // Inactive tabs: still refresh playback position from cache estimate, or light probe
      if (hasValidMetadata && !video.active && !video.audible) {
        return;
      }

      const expectedVideoId = getVideoIdFromUrl(video.url);

      try {
        const contentMeta = await browser.tabs.sendMessage(video.id, { action: "get-metadata" }).catch(() => null);
        if (
          contentMeta &&
          contentMeta.videoId != null &&
          contentMeta.videoId === expectedVideoId &&
          contentMeta.title &&
          (contentMeta.seconds > 0 || contentMeta.isLive)
        ) {
          applyProbedMetadataToVideo(video, {
            title: contentMeta.title,
            channelName: contentMeta.channelName || "",
            seconds: contentMeta.seconds,
            currentTime: contentMeta.currentTime,
            isLive: contentMeta.isLive,
            paused: contentMeta.paused,
            volume: contentMeta.volume,
            muted: contentMeta.muted,
          });
          requestMetadataUpdate(video.url, buildMetadataForCache(video, expectedVideoId ?? undefined));
          scheduleProbeRender();
          return;
        }
      } catch {
        // No content script (e.g. tab loaded before extension) — fall through to inject
      }



      try {
        const results = await browser.scripting.executeScript({
          target: { tabId: video.id },
          world: "MAIN",
          args: [hasValidMetadata],
          func: (hasMetadata: boolean) => {
            const videoElement = document.querySelector("video");
            const currentTime = videoElement ? videoElement.currentTime : 0;
            const volume = videoElement ? videoElement.volume : 1;
            const muted = videoElement ? videoElement.muted : false;
            const paused = videoElement ? videoElement.paused : true;

            // Current video ID: watch ?v= or Shorts /shorts/VIDEO_ID
            const shortsMatch = window.location.pathname.match(/^\/shorts\/([^/?]+)/);
            const currentVideoId =
              new URLSearchParams(window.location.search).get("v") ||
              (shortsMatch ? shortsMatch[1] : null) ||
              null;

            // @ts-ignore - Get ytInitialPlayerResponse for SPA detection
            const playerResponse = window.ytInitialPlayerResponse;
            const playerVideoId = playerResponse?.videoDetails?.videoId;
            
            // CRITICAL: Detect SPA navigation mismatch - ytInitialPlayerResponse has stale video ID
            const isSpaTransition = playerVideoId && currentVideoId && playerVideoId !== currentVideoId;

            if (hasMetadata && !isSpaTransition) {
              return { currentTime, volume, muted, paused, skipMetadata: true };
            }

            // If SPA transition detected, return a special flag to invalidate any cached data
            if (isSpaTransition) {
              return {
                currentTime,
                volume,
                muted,
                paused,
                spaTransition: true,
                currentVideoId,
                skipMetadata: false
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
                const liveDetails = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
                if (liveDetails && !liveDetails.endTimestamp) isLive = true;

                const lengthSeconds = parseInt(videoDetails.lengthSeconds) || 0;
                if (lengthSeconds > 0) {
                  isLive = false;
                  duration = lengthSeconds;
                }
              }

              // Shorts fallback 1: duration from ytInitialPlayerResponse.streamingData (formats/adaptiveFormats)
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
              // Shorts fallback 2: duration from ytInitialData (reelWatchEndpoint or other path)
              if (duration === 0 && window.location.pathname.startsWith("/shorts/")) {
                try {
                  // @ts-ignore
                  const d = window.ytInitialData;
                  const ms = d && d.contents && d.contents.reelWatchEndpoint && d.contents.reelWatchEndpoint.approxDurationMs;
                  if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
                } catch (_) {}
              }

              if (!isLive) {
                const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
                if (liveBadge && !liveBadge.hasAttribute("disabled") && getComputedStyle(liveBadge).display !== "none") {
                  isLive = true;
                }
              }

              // Consolidate title extraction
              let title = videoDetails?.title || 
                (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
                (document.querySelector("h1.title.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
                (document.querySelector(".ytd-video-primary-info-renderer h1") as HTMLElement)?.innerText ||
                (document.querySelector("ytd-video-primary-info-renderer #container h1") as HTMLElement)?.innerText ||
                document.title;

              // Clean title: remove any notification prefixes like "(1) " or "(1030) "
              title = title.replace(/^\(\d+\)\s*/g, "");
              title = title.replace(" - YouTube", "").trim();

              return {
                duration: isLive ? 0 : duration || videoElement?.duration || 0,
                currentTime,
                channelName: channel || videoDetails?.author || "",
                title: title || "YouTube Video",
                isLive,
                paused,
                volume,
                muted,
                skipMetadata: false
              };
            } catch (error) {
               // Fallback if playerResponse access fails or other error
               return {
                 duration: videoElement?.duration || 0,
                 currentTime,
                 channelName: channel,
                 title: document.title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim() || "YouTube Video",
                 isLive: false,
                 paused,
                 volume,
                 muted,
                 skipMetadata: false
               };
            }
          },
        });

        if (results[0]?.result) {
          const result = results[0].result;
          
          // SPA transition: content script observer will have updated; ask it for metadata (retry once after 500ms)
          if (result.spaTransition) {
            applyPlaybackTimeToVideo(video, result.currentTime || 0);
            const expectedId = getVideoIdFromUrl(video.url);
            const tryContentScript = async (): Promise<boolean> => {
              const meta = await browser.tabs.sendMessage(video.id, { action: "get-metadata" }).catch(() => null);
              if (meta?.videoId === expectedId && meta?.title && (meta.seconds > 0 || meta.isLive)) {
                applyProbedMetadataToVideo(video, {
                  title: meta.title,
                  channelName: meta.channelName ?? "",
                  seconds: meta.seconds,
                  currentTime: meta.currentTime ?? 0,
                  isLive: meta.isLive ?? false,
                  paused: meta.paused,
                  volume: meta.volume,
                  muted: meta.muted,
                });
                if (video.seconds > 0 || video.isLive) {
                  requestMetadataUpdate(video.url, buildMetadataForCache(video, expectedId ?? undefined));
                }
                scheduleProbeRender();
                return true;
              }
              return false;
            };
            if (await tryContentScript()) return;
            await new Promise((r) => setTimeout(r, 500));
            if (await tryContentScript()) return;
            return;
          }
          
          if (result.skipMetadata) {
            applyProbedMetadataToVideo(video, {
              currentTime: result.currentTime || 0,
              volume: result.volume,
              muted: result.muted,
              paused: result.paused,
            });
            if (!video.isLive && video.seconds > 0) {
              persistVideoPlaybackToCache(video);
            }
            scheduleProbeRender();
          } else {
            const duration = result.duration || 0;

            const hasValidTitle = result.title && result.title !== "Loading..." && result.title !== "YouTube Video";
            if (hasValidTitle || duration > 0 || result.isLive) {
              applyProbedMetadataToVideo(video, {
                title: result.title || video.title,
                channelName: result.channelName || video.channelName,
                seconds: duration,
                currentTime: result.currentTime || 0,
                isLive: result.isLive || false,
                volume: result.volume,
                muted: result.muted,
                paused: result.paused,
              });

              if (duration > 0 || result.isLive) {
                requestMetadataUpdate(video.url, buildMetadataForCache(video, expectedVideoId ?? undefined));
              }
              scheduleProbeRender();
            }
          }
        }
      } catch (error: any) {
        const errorMsg = error?.message || "";
        const isExpectedError =
          errorMsg.includes("permissions") ||
          errorMsg.includes("Cannot access") ||
          errorMsg.includes("Extension context invalidated");

        if (!isExpectedError) {
          console.warn(`Failed to probe tab ${video.id}:`, error);
        }
        scheduleProbeRender();
      }
    });
    await Promise.all(activeTabPromises);
    await refreshNowPlayingDetection();
    flushProbeRender();

    // After probing: auto-fetch durations for any tab still missing it (suspended or probe failed). Background skips when cache is fresh.
    const tabsWithoutDuration = videoData.filter((v) => v.seconds === 0 && !v.isLive);
    if (tabsWithoutDuration.length > 0 && Date.now() - lastSyncTime >= SYNC_COOLDOWN_MS) {
      lastSyncTime = Date.now();
      browser.runtime
        .sendMessage({
          action: "sync-all",
          tabs: tabsWithoutDuration.map((v) => ({ id: v.id, url: v.url })),
        })
        .catch(() => {});
    }
  } catch (error: any) {
    console.error("Error scanning tabs:", error);
    const app = document.getElementById("app")!;
    app.innerHTML = `
      <div class="p-8 text-center">
        <div class="text-2xl mb-3 opacity-40">⚠️</div>
        <div class="text-sm text-text-secondary mb-1">Something went wrong</div>
        <div class="text-[10px] text-accent font-mono break-all px-4">${error?.message || "Unknown error"}</div>
        <div class="text-[10px] text-text-muted mt-4">Try refreshing your YouTube tabs</div>
      </div>
    `;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  installTooltips();
  // A stale avatar URL just hides; the channel name is still there.
  document.addEventListener(
    "error",
    (event) => {
      if (event.target instanceof HTMLImageElement && event.target.classList.contains("meta-avatar")) event.target.classList.add("hidden");
    },
    true
  );
  document.addEventListener("click", closeAllCustomSelects);
  void loadChannelAvatars()
    .then((avatars) => (popupChannelAvatars = avatars))
    .catch(() => {})
    .finally(() => void getYouTubeTabs());
});
window.addEventListener("pagehide", stopLiveTick);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopLiveTick();
  } else if (currentView === "dashboard" && document.getElementById("stat-remaining")) {
    startLiveTick();
    void livePlaybackTick();
  }
});
