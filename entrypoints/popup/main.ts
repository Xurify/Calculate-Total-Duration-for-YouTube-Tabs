import "./style.css";
import packageJson from "../../package.json";
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
import { formatTime, formatCompact, parseTimeParam, getVideoIdFromUrl } from "../../utils/format";

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
    if (cached) applyCachedMetadataToVideo(video, cached);
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
  void saveStorageUtil(videoData, sortByDuration).catch((err) => {
    console.warn("Failed to save prefs:", err);
  });
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
  video.paused = cached.paused;
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
      video.seconds = message.metadata.seconds;
      video.title = message.metadata.title;
      video.channelName = message.metadata.channelName;
      video.isLive = message.metadata.isLive || false;
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
  video.currentTime = playback.currentTime;
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
  video.currentTime = state.currentTime;
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
  const includedVideos = videoData.filter((video) => !video.excluded);
  const totalSeconds = includedVideos.reduce((sum, video) => sum + video.seconds, 0);
  const totalWatched = includedVideos.reduce((sum, video) => sum + video.currentTime, 0);
  return {
    totalSeconds,
    totalWatched,
    totalRemaining: Math.max(0, totalSeconds - totalWatched),
    videoCount: includedVideos.length,
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
        primary.currentTime = playback.currentTime;
        updateNowPlayingCard(card, primary, playback, isTabActivelyPlaying(primary));
      }
    }

    refreshQueueStatsFromState();

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
          nextPrimary.currentTime = playback.currentTime;
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

async function openManager(): Promise<void> {
  const managerUrl = browser.runtime.getURL("/manager.html");
  const tabs = await browser.tabs.query({ url: managerUrl });
  if (tabs.length > 0 && tabs[0].id != null) {
    await browser.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) {
      await browser.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await browser.tabs.create({ url: managerUrl });
  }
}

function renderNow(): void {
  if (currentView === "settings") {
    stopLiveTick();
    resetVideoListFingerprint();
    app.innerHTML = `
          <div data-v-header class="pt-4 px-4 pb-3 border-b border-border bg-gradient-to-b from-surface to-surface-elevated relative">
            <div class="flex items-center gap-3 mb-3">
              <button id="back-to-dashboard" class="w-9 h-9 flex items-center justify-center -ml-2 rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors border-0 bg-transparent cursor-pointer active:scale-[0.96]">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <h2 class="text-sm font-bold uppercase tracking-widest text-text-primary m-0 text-balance">Settings</h2>
            </div>
            <div class="space-y-3">
              <div class="pt-3 border-t border-border">
                <button id="btn-clear-cache" class="w-full text-left p-3 rounded-lg border border-border bg-surface-hover/20 hover:bg-red-500/10 hover:border-red-500 group/clear transition-[background-color,border-color,color] cursor-pointer active:scale-[0.96]">
                  <div class="flex items-center justify-between">
                    <div>
                      <div class="text-[12px] font-semibold group-hover/clear:text-red-500 transition-colors">Clear Metadata Cache</div>
                      <div class="text-[10px] text-text-muted">Reset all stored titles and durations</div>
                    </div>
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-text-muted group-hover/clear:text-red-500 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </div>
                </button>
              </div>
            </div>
            <div class="mt-3 pt-3 pb-0 border-t border-border/50 text-center">
              <div class="text-[10px] text-text-muted font-medium opacity-40 uppercase tracking-tighter">Calculate Total Duration for YouTube Tabs v${VERSION_NUMBER}</div>
            </div>
          </div>
          <div id="popup-confirm-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" aria-modal="true" role="dialog">
            <div class="bg-surface-elevated border border-border rounded-lg shadow-xl w-full max-w-[calc(100%-2rem)] mx-4 p-4">
              <h3 id="popup-confirm-title" class="text-sm font-bold text-text-primary mb-2"></h3>
              <p id="popup-confirm-message" class="text-xs text-text-secondary mb-4"></p>
              <div class="flex justify-end gap-2">
                <button type="button" id="popup-confirm-cancel" class="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-surface-hover text-text-primary hover:bg-surface cursor-pointer">Cancel</button>
                <button type="button" id="popup-confirm-ok" class="px-3 py-1.5 text-xs font-medium rounded-md border-0 bg-red-600 text-white hover:bg-red-700 cursor-pointer transition-colors">Clear cache</button>
              </div>
            </div>
          </div>
        `;
    document.getElementById("back-to-dashboard")!.addEventListener("click", () => {
      currentView = "dashboard";
      render();
    });

    document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
      const confirmed = await showConfirm({
        title: "Clear metadata cache",
        message: "Clear all cached titles and durations? Tabs will be re-probed when needed.",
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

    document.getElementById("now-playing")?.classList.add("hidden");
    document.getElementById("up-next-divider")?.classList.add("hidden");

    updateHeaderStats(0, 0, 0, 0);

    const listEl = document.getElementById("video-list");
    if (listEl) {
      listEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full min-h-[320px] px-8 text-center">
          <div class="w-14 h-10 rounded-lg bg-accent flex items-center justify-center mb-5 shadow-[0_4px_20px_rgba(255,0,0,0.35)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <p class="text-sm font-medium text-text-primary mb-1">No tabs open</p>
          <p class="text-xs text-text-muted leading-relaxed max-w-[240px]">Open YouTube videos in this window to build your watch queue.</p>
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

function setupApp() {
  // Check if the dashboard shell is actually present, not just "not empty"
  // logic: if 'stat-total' exists, we are in the dashboard view.
  if (document.getElementById("stat-total")) return;

  app.innerHTML = `
    <div class="flex flex-col h-popup max-h-popup w-full bg-surface overflow-hidden">
      <header data-v-header class="shrink-0 border-b border-white/10 bg-surface pb-2.5">
        <div class="flex items-center gap-2.5 px-3 pt-2.5 pb-2">
          <div class="w-8 h-6 rounded-md bg-accent flex items-center justify-center shrink-0 shadow-[0_1px_8px_rgba(255,0,0,0.35)]">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-bold text-text-primary leading-none tracking-tight">Watch Queue</div>
            <div class="text-[11px] text-text-muted leading-tight mt-0.5">YouTube tabs in this window</div>
          </div>
          <div class="flex items-center gap-0.5 p-0.5 rounded-full bg-surface-elevated ring-1 ring-inset ring-white/10 shrink-0">
            <button id="refresh-tabs" class="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors border-0 cursor-pointer group/refresh active:scale-95" title="Refresh tabs">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="group-active/refresh:rotate-180 transition-transform duration-500"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>
            </button>
            <button id="open-manager" class="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors border-0 cursor-pointer active:scale-95" title="Open full manager">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
            </button>
            <button id="go-to-settings" class="w-7 h-7 flex items-center justify-center rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors border-0 cursor-pointer group/settings active:scale-95" title="Settings">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover/settings:rotate-45 transition-transform duration-500"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
        </div>
        <div class="mx-3 rounded-xl p-3 bg-surface-elevated/90 ring-1 ring-inset ring-white/10">
          <div class="flex items-end justify-between gap-3">
            <div class="min-w-0">
              <p class="text-[10px] font-medium uppercase tracking-wider text-text-muted leading-none">Time left</p>
              <p id="stat-remaining" class="text-[15px] font-bold tabular-nums text-text-primary leading-tight mt-1 truncate min-w-[5.5rem]">--:--</p>
            </div>
            <div class="text-right shrink-0">
              <p class="text-[10px] font-medium uppercase tracking-wider text-text-muted leading-none">Watched</p>
              <p id="stat-watched" class="text-[15px] font-bold tabular-nums text-accent leading-tight mt-1 min-w-[5.5rem]">--:--</p>
            </div>
          </div>
          <div class="mt-3">
            <div class="flex items-center justify-between gap-2 text-[10px] text-text-muted mb-1.5">
              <span id="stat-video-count" class="tabular-nums">0 videos</span>
              <span id="stat-watched-pct" class="tabular-nums font-medium text-text-secondary">0%</span>
            </div>
            <div class="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div id="stat-overall-progress" class="h-full rounded-full bg-gradient-to-r from-accent to-red-400 transition-[width] duration-700" style="width: 0%"></div>
            </div>
            <p class="mt-1.5 text-[10px] text-text-muted tabular-nums">
              <span>Total queue</span>
              <span id="stat-total" class="ml-1 text-text-secondary font-medium tabular-nums min-w-[5.5rem] inline-block">--:--</span>
            </p>
          </div>
        </div>
      </header>

      <section id="now-playing" class="hidden shrink-0 border-b border-white/10">
        <div id="np-card" class="px-3 py-2 transition-[background-color,box-shadow] duration-300 bg-accent/5 shadow-[inset_2px_0_0_0_#ff0000]" data-np-tab-id="">
          <div class="flex gap-2.5 items-center">
            <button type="button" class="np-thumb-btn relative shrink-0 w-[5.5rem] aspect-video rounded-sm overflow-hidden bg-surface-hover border border-white/10 group/thumb p-0 cursor-pointer" title="Open tab">
              <img class="np-thumb w-full h-full object-cover hidden" alt="" width="88" height="50" />
              <div class="absolute bottom-0 left-0 right-0 h-[3px] bg-black/50">
                <div class="np-progress h-full bg-accent transition-[width] duration-500" style="width: 0%"></div>
              </div>
            </button>
            <div class="flex-1 min-w-0 flex flex-col gap-1">
              <button type="button" class="np-title text-left text-[13px] font-medium text-text-primary line-clamp-1 leading-tight cursor-pointer hover:underline decoration-white/30 underline-offset-2 border-0 bg-transparent p-0 w-full truncate" title="Open tab"></button>
              <p class="np-channel text-[11px] text-text-secondary truncate"></p>
              <div class="flex items-center gap-1.5">
                <button type="button" class="np-play-pause w-7 h-7 shrink-0 flex items-center justify-center rounded-full bg-accent text-white border-0 cursor-pointer hover:bg-[#e60000] active:scale-95 transition-all" title="Play / Pause"></button>
                <span class="np-time text-[11px] text-text-muted tabular-nums shrink-0 min-w-[4.5rem]"></span>
                <svg class="np-volume-icon shrink-0 text-text-muted" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                <div class="flex-1 min-w-0 flex items-center h-3">
                  <input type="range" class="np-volume w-full h-1 m-0 p-0 cursor-pointer appearance-none rounded-full bg-white/15 accent-accent" min="0" max="100" value="0" aria-label="Volume" />
                </div>
                <button type="button" class="np-go-to-tab shrink-0 px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary hover:bg-surface-hover border-0 bg-transparent cursor-pointer transition-colors" title="Go to tab">Open tab</button>
              </div>
            </div>
          </div>
        </div>
        <p id="np-also-playing" class="hidden px-3 pb-2 -mt-0.5 text-[10px] text-text-muted truncate"></p>
      </section>

      <div id="up-next-divider" class="flex items-center justify-between px-3 py-1.5 shrink-0 border-b border-white/5">
        <span class="text-[13px] font-medium text-text-primary">Up next</span>
        <div class="flex gap-0.5 p-0.5 rounded-full bg-surface-elevated ring-1 ring-inset ring-white/10">
          <button id="sort-order" class="px-2.5 py-1 text-[11px] font-medium rounded-full cursor-pointer transition-all border-0 active:scale-95">Tab order</button>
          <button id="sort-duration" class="px-2.5 py-1 text-[11px] font-medium rounded-full cursor-pointer transition-all border-0 active:scale-95">Length</button>
        </div>
      </div>

      <div id="video-list" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent"></div>
    </div>
  `;

  document.getElementById("go-to-settings")?.addEventListener("click", goToSettings);
  document.getElementById("open-manager")?.addEventListener("click", () => {
    void openManager();
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
}

function updateNowPlayingCardTime(card: HTMLElement, video: VideoData): void {
  const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
  const progressEl = card.querySelector(".np-progress") as HTMLElement | null;
  if (progressEl) progressEl.style.width = `${watchedPercent}%`;

  const timeEl = card.querySelector(".np-time") as HTMLElement | null;
  if (!timeEl) return;

  if (video.isLive) {
    timeEl.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-red-500/20 text-red-500 text-[9px] font-bold">🔴 LIVE</span>`;
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
    }
  }
  if (volumeIcon) {
    const vol = state.muted ? 0 : state.volume;
    const paths =
      vol === 0 ? VOLUME_ICON_MUTE : vol < 0.35 ? VOLUME_ICON_LOW : vol < 0.7 ? VOLUME_ICON_MED : VOLUME_ICON_HIGH;
    volumeIcon.innerHTML = paths;
  }
  card.className = `px-3 py-2 transition-[background-color,box-shadow] duration-300 ${
    isActivelyPlaying ? "bg-accent/5 shadow-[inset_2px_0_0_0_#ff0000]" : "shadow-[inset_2px_0_0_0_rgba(255,255,255,0.08)]"
  }`;
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
      volume: 0,
      muted: false,
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
        primary.currentTime = playback.currentTime;
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
  document.getElementById("stat-remaining")!.innerText = formatTime(totalRemaining);
  document.getElementById("stat-total")!.innerText = formatTime(totalSeconds);
  document.getElementById("stat-video-count")!.innerText = `${videoCount} video${videoCount === 1 ? "" : "s"}`;

  const watchedEl = document.getElementById("stat-watched");
  if (watchedEl) watchedEl.innerText = formatTime(totalWatched);

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

  const btnTab = document.getElementById("sort-order");
  const btnLen = document.getElementById("sort-duration");
  const sortActive =
    "px-2.5 py-1 text-[11px] font-medium rounded-full cursor-pointer transition-all border-0 active:scale-95 bg-accent text-white shadow-sm";
  const sortIdle =
    "px-2.5 py-1 text-[11px] font-medium rounded-full cursor-pointer transition-all border-0 active:scale-95 text-text-muted hover:text-text-secondary hover:bg-white/5";
  if (btnTab && btnLen) {
    btnTab.className = !sortByDuration ? sortActive : sortIdle;
    btnLen.className = sortByDuration ? sortActive : sortIdle;
  }
}

function updateVideoListItem(item: HTMLElement, video: VideoData): void {
  const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
  const isNowPlaying = isTabActivelyPlaying(video);
  const isActiveTab = video.active && !isNowPlaying;
  const stateClasses = isNowPlaying
    ? "bg-accent/5 shadow-[inset_2px_0_0_0_#ff0000]"
    : isActiveTab
      ? "shadow-[inset_2px_0_0_0_rgba(255,255,255,0.12)]"
      : "hover:bg-white/5";
  item.className = `group relative flex h-[4.625rem] shrink-0 items-center gap-2 overflow-hidden p-1 transition-all duration-200 ${stateClasses} ${
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

  const titleEl = item.querySelector(".meta-title") as HTMLElement;
  titleEl.innerText = video.title;
  titleEl.title = video.title;

  const progressTrack = item.querySelector(".meta-progress-track") as HTMLElement | null;
  if (progressTrack) progressTrack.classList.toggle("hidden", isNowPlaying);

  const progressEl = item.querySelector(".meta-progress") as HTMLElement;
  progressEl.style.width = `${watchedPercent}%`;

  const badgeEl = item.querySelector(".meta-duration-badge") as HTMLElement;
  const timeEl = item.querySelector(".meta-time") as HTMLElement;
  if (video.isLive) {
    badgeEl.innerHTML = `<span class="px-1 py-px rounded text-[10px] font-bold bg-accent text-white">LIVE</span>`;
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
    timeEl.innerHTML = `<span class="text-amber-500/90">Suspended</span>`;
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
          <button class="shrink-0 w-7 h-7 flex items-center justify-center rounded bg-surface-hover text-text-muted border-0 cursor-pointer transition-[background-color,color] hover:bg-accent hover:text-white active:scale-[0.96] jump-btn" title="Jump to tab">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          </button>
          ${
            video.suspended
              ? `<button class="shrink-0 text-[10px] px-2 py-1 rounded bg-amber-500 text-white border-0 cursor-pointer transition-[background-color] hover:bg-amber-600 font-bold active:scale-[0.96] wake-up-btn">Wake up</button>`
              : ""
          }
          <button class="shrink-0 text-[10px] px-2 py-1 rounded bg-surface-hover text-text-muted border-0 cursor-pointer transition-[background-color,color] hover:bg-accent hover:text-white active:scale-[0.96] toggle-btn">${
            video.excluded ? "Show" : "Hide"
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
  videos.forEach((video, index) => {
    let item = document.getElementById(`video-item-${video.id}`);

    if (!item) {
      item = document.createElement("div");
      item.id = `video-item-${video.id}`;
      item.dataset.id = video.id.toString();
      item.style.viewTransitionName = `video-${video.id}`;
      item.className =
        "group relative flex h-[4.625rem] shrink-0 items-center gap-2 overflow-hidden p-1 transition-all duration-200";
      item.innerHTML = `
            <div class="relative shrink-0 w-[5.5rem] aspect-video rounded-sm overflow-hidden bg-surface-hover border border-white/10">
              <img class="meta-thumb w-full h-full object-cover hidden" alt="" />
              <div class="meta-duration-badge absolute bottom-1 right-1 px-1 py-px rounded-sm text-[10px] font-medium bg-black/80 text-white tabular-nums leading-none"></div>
              <div class="meta-progress-track absolute bottom-0 left-0 right-0 h-[3px] bg-black/40">
                <div class="meta-progress h-full bg-accent transition-[width] duration-700" style="width: 0%"></div>
              </div>
            </div>
            <div class="flex-1 min-w-0 flex flex-col justify-center gap-0.5 pr-1">
              <span class="meta-now-badge hidden self-start px-1.5 py-px rounded-full text-[9px] font-bold uppercase tracking-wide bg-accent/20 text-accent leading-none">Playing</span>
              <div class="meta-title text-[13px] font-medium text-text-primary line-clamp-2 leading-snug"></div>
              <div class="meta-channel text-[11px] text-text-secondary truncate"></div>
              <div class="meta-time text-[10px] text-text-muted tabular-nums"></div>
            </div>
            <div class="meta-controls absolute top-1.5 right-1.5 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity bg-surface-elevated/95 backdrop-blur-md rounded-md p-1 shadow-lg ring-1 ring-white/10"></div>
          `;

      container.appendChild(item);
    }

    updateVideoListItem(item, video);

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

      // Skip probing if the tab is inactive and inaudible, and we already have valid cached metadata
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
          video.title = contentMeta.title;
          video.channelName = contentMeta.channelName || "";
          video.seconds = contentMeta.seconds;
          video.currentTime = contentMeta.currentTime;
          video.isLive = contentMeta.isLive;
          
          requestMetadataUpdate(video.url, {
            seconds: video.seconds,
            title: video.title,
            channelName: video.channelName,
            currentTime: video.currentTime,
            isLive: video.isLive,
            videoId: expectedVideoId ?? undefined,
          });
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
              return { currentTime, skipMetadata: true };
            }

            // If SPA transition detected, return a special flag to invalidate any cached data
            if (isSpaTransition) {
              return {
                currentTime,
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
                 skipMetadata: false
               };
            }
          },
        });

        if (results[0]?.result) {
          const result = results[0].result;
          
          // SPA transition: content script observer will have updated; ask it for metadata (retry once after 500ms)
          if (result.spaTransition) {
            video.currentTime = result.currentTime || 0;
            const expectedId = getVideoIdFromUrl(video.url);
            const tryContentScript = async (): Promise<boolean> => {
              const meta = await browser.tabs.sendMessage(video.id, { action: "get-metadata" }).catch(() => null);
              if (meta?.videoId === expectedId && meta?.title && (meta.seconds > 0 || meta.isLive)) {
                video.title = meta.title;
                video.channelName = meta.channelName ?? "";
                video.seconds = meta.seconds;
                video.currentTime = meta.currentTime ?? 0;
                video.isLive = meta.isLive ?? false;
                if (video.seconds > 0 || video.isLive) {
                  requestMetadataUpdate(video.url, { seconds: video.seconds, title: video.title, channelName: video.channelName, currentTime: video.currentTime, isLive: video.isLive, videoId: expectedId ?? undefined });
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
            // Only update currentTime
            video.currentTime = result.currentTime || 0;
            scheduleProbeRender();
          } else {
            const duration = result.duration || 0;
            
            // Always update title/channel if we got valid data (not just "Loading...")
            const hasValidTitle = result.title && result.title !== "Loading..." && result.title !== "YouTube Video";
            if (hasValidTitle || duration > 0 || result.isLive) {
              video.title = result.title || video.title;
              video.channelName = result.channelName || video.channelName;
              video.seconds = duration;
              video.currentTime = result.currentTime || 0;
              video.isLive = result.isLive || false;

              // Only cache if we have meaningful data (duration or live status)
              if (duration > 0 || result.isLive) {
                requestMetadataUpdate(video.url, {
                  seconds: video.seconds,
                  title: video.title,
                  channelName: video.channelName,
                  currentTime: video.currentTime,
                  isLive: video.isLive,
                  videoId: expectedVideoId ?? undefined,
                });
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

document.addEventListener("DOMContentLoaded", getYouTubeTabs);
window.addEventListener("pagehide", stopLiveTick);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    stopLiveTick();
  } else if (currentView === "dashboard" && document.getElementById("stat-remaining")) {
    startLiveTick();
    void livePlaybackTick();
  }
});
