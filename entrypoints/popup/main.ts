import "./style.css";
import packageJson from "../../package.json";
import {
  VideoData,
  loadStorage,
  saveStorage as saveStorageUtil,
  requestMetadataUpdate,
  normalizeYoutubeUrl,
  clearCache,
  isCacheEntryUsable
} from "../../utils/storage";
import { formatTime, formatCompact, parseTimeParam, getVideoIdFromUrl } from "../../utils/format";

const VERSION_NUMBER = packageJson.version;

let videoData: VideoData[] = [];
let sortByDuration = false;
let currentView: "dashboard" | "settings" = "dashboard";
let popupWindowId: number | null = null;
let lastPlayingTabId: number | null = null;

const LAST_PLAYING_SESSION_KEY = "lastPlayingByWindow";

const POPUP_STORAGE_READ_SKIP_MS = 2000;
let lastStorageLoadTime = 0;
let lastStorageData: Awaited<ReturnType<typeof loadStorage>> | null = null;

async function saveStorage(): Promise<void> {
  await saveStorageUtil(videoData, sortByDuration);
  lastStorageLoadTime = 0;
}

// Global listener for background cache updates (content script + auto sync for suspended tabs)
browser.runtime.onMessage.addListener((message) => {
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

function getNowPlayingVideo(): VideoData | null {
  const inWindow = getVideosInPopupWindow();

  const audible = inWindow.filter((video) => video.audible);
  if (audible.length > 0) {
    const playing = audible.find((video) => video.active) ?? audible[0] ?? null;
    if (playing) void persistLastPlayingTabId(playing.id);
    return playing;
  }

  if (lastPlayingTabId) {
    const last = findVideoByTabId(lastPlayingTabId);
    if (isVideoEligibleForNowPlaying(last)) return last;
    void clearLastPlayingTabId();
  }

  return inWindow.find((video) => video.active) ?? null;
}

function getNowPlayingTabId(): number | null {
  const section = document.getElementById("now-playing");
  const tabId = section?.dataset.tabId ? parseInt(section.dataset.tabId, 10) : 0;
  if (tabId) {
    const pinned = videoData.find((video) => video.id === tabId);
    if (pinned && !pinned.excluded && !pinned.suspended) return tabId;
  }
  return getNowPlayingVideo()?.id ?? null;
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

const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>`;

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

const app = document.getElementById("app")!;

function resetVideoListFingerprint(): void {
  lastVideoListFingerprint = "";
}

function videoListStructureFingerprint(videos: VideoData[]): string {
  const nowPlayingId = getNowPlayingTabIdForList();
  const sig = videos
    .map(
      (video) =>
        `${video.id}|${video.url}|${video.title}|${video.channelName}|${video.seconds}|${video.isLive ? 1 : 0}|${video.excluded ? 1 : 0}|${video.suspended ? 1 : 0}|${video.active ? 1 : 0}|${video.audible ? 1 : 0}`
    )
    .join(";");
  return `${sortByDuration ? 1 : 0}|np:${nowPlayingId ?? 0}|${sig}`;
}

function renderNow(): void {
  if (videoData.length === 0) {
    resetVideoListFingerprint();
    app.innerHTML = `
          <div class="flex flex-col items-center justify-center min-h-[37.5rem] px-8 text-center">
            <div class="w-14 h-10 rounded-lg bg-accent flex items-center justify-center mb-5 shadow-[0_4px_20px_rgba(255,0,0,0.35)]">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
            </div>
            <p class="text-sm font-medium text-text-primary mb-1">No tabs open</p>
            <p class="text-xs text-text-muted leading-relaxed">Open YouTube videos in this window to build your watch queue.</p>
          </div>
        `;
    return;
  }

  if (currentView === "settings") {
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
        await getYouTubeTabs();
        currentView = "dashboard";
        render();
      }
    });
    return;
  }

  setupApp();

  const includedVideos = videoData.filter((video) => !video.excluded);
  const totalSeconds = includedVideos.reduce((sum, video) => sum + video.seconds, 0);
  const totalWatched = includedVideos.reduce((sum, video) => sum + video.currentTime, 0);
  const totalRemaining = Math.max(0, totalSeconds - totalWatched);

  updateHeaderStats(totalSeconds, totalRemaining, includedVideos.length, totalWatched);
  void updateNowPlaying();

  const sorted = getSortedVideos();
  const fp = videoListStructureFingerprint(sorted);
  const listEl = document.getElementById("video-list");

  if (fp === lastVideoListFingerprint && listEl) {
    updateVideoListCardsFromState();
    return;
  }

  lastVideoListFingerprint = fp;
  updateVideoList(sorted);
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
    <div class="flex flex-col h-[37.5rem] min-h-[37.5rem] w-full bg-surface">
      <header data-v-header class="shrink-0 border-b border-white/10 bg-surface">
        <div class="flex items-center gap-2 px-3 py-2">
          <div class="w-8 h-6 rounded-md bg-accent flex items-center justify-center shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-bold text-text-primary leading-none">Watch Queue</div>
            <div id="stat-video-count" class="text-[11px] text-text-muted tabular-nums leading-tight mt-0.5">0 videos</div>
          </div>
          <button id="refresh-tabs" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors border-0 cursor-pointer group/refresh active:scale-95" title="Refresh tabs">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="group-active/refresh:rotate-180 transition-transform duration-500"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>
          </button>
          <button id="open-manager" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors border-0 cursor-pointer active:scale-95" title="Open full manager">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
          </button>
          <button id="go-to-settings" class="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors border-0 cursor-pointer group/settings active:scale-95" title="Settings">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="group-hover/settings:rotate-90 transition-transform duration-500"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
          </button>
        </div>
        <div class="flex items-center gap-2 px-3 py-1.5 bg-surface-elevated/60 text-[11px] tabular-nums border-t border-white/5">
          <span class="text-text-muted shrink-0">Left</span>
          <span id="stat-remaining" class="text-accent font-semibold truncate min-w-0">--:--</span>
          <span class="text-white/15 shrink-0">·</span>
          <span class="text-text-muted shrink-0">Total</span>
          <span id="stat-total" class="font-semibold text-text-primary truncate min-w-0">--:--</span>
          <div class="flex-1 min-w-6 h-1 rounded-full bg-white/10 overflow-hidden ml-1">
            <div id="stat-overall-progress" class="h-full bg-accent transition-[width] duration-700" style="width: 0%"></div>
          </div>
        </div>
      </header>

      <section id="now-playing" class="hidden shrink-0 border-b border-white/10 bg-surface-elevated/40">
        <div id="np-card" class="px-3 py-2 transition-all duration-300">
          <div class="flex items-center gap-2">
            <button id="np-thumb-btn" type="button" class="relative shrink-0 w-[5.5rem] aspect-video rounded-md overflow-hidden bg-surface-hover ring-1 ring-white/10 group/thumb border-0 p-0 cursor-pointer" title="Open tab">
              <img id="np-thumb" alt="" class="w-full h-full object-cover" />
              <div class="absolute bottom-0 inset-x-0 h-0.5 bg-black/50">
                <div id="np-progress" class="h-full bg-accent transition-[width] duration-500" style="width: 0%"></div>
              </div>
            </button>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1 mb-0.5">
                <span class="np-indicator w-1.5 h-1.5 rounded-full bg-text-muted shrink-0"></span>
                <span id="np-status" class="text-[10px] font-bold uppercase tracking-wider text-text-muted">Paused</span>
              </div>
              <h2 id="np-title" class="text-[13px] font-medium text-text-primary line-clamp-1 leading-tight cursor-pointer hover:underline decoration-white/30 underline-offset-2" title="Open tab"></h2>
              <p id="np-channel" class="hidden text-[11px] text-text-secondary truncate"></p>
            </div>
            <button id="np-play-pause" class="w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-accent text-white border-0 cursor-pointer hover:bg-[#e60000] active:scale-95 transition-all" title="Play / Pause"></button>
            <span id="np-time" class="text-[11px] text-text-muted tabular-nums shrink-0 text-right"></span>
          </div>
          <div class="flex items-center gap-2 mt-1.5 pl-[6rem]">
            <svg id="np-volume-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-text-muted"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
            <input id="np-volume" type="range" min="0" max="100" value="100" class="flex-1 h-1 min-w-0 cursor-pointer appearance-none rounded-full bg-white/15 accent-accent" aria-label="Volume" />
            <button id="np-go-to-tab" class="shrink-0 px-2 py-0.5 rounded text-[11px] text-text-muted hover:text-text-primary hover:bg-surface-hover border-0 bg-transparent cursor-pointer transition-colors" title="Go to tab">Open tab</button>
          </div>
        </div>
      </section>

      <div class="flex items-center justify-between px-3 py-1.5 shrink-0 border-b border-white/5">
        <span class="text-[13px] font-medium text-text-primary">Up next</span>
        <div class="flex gap-0.5 p-0.5 rounded-full bg-surface-elevated ring-1 ring-inset ring-white/10">
          <button id="sort-order" class="px-2.5 py-1 text-[11px] font-medium rounded-full cursor-pointer transition-all border-0 active:scale-95">Tab order</button>
          <button id="sort-duration" class="px-2.5 py-1 text-[11px] font-medium rounded-full cursor-pointer transition-all border-0 active:scale-95">Length</button>
        </div>
      </div>

      <div id="video-list" class="flex-1 min-h-0 overflow-y-auto px-2 pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/20 [&::-webkit-scrollbar-track]:bg-transparent"></div>
    </div>
  `;

  document.getElementById("go-to-settings")?.addEventListener("click", () => {
    currentView = "settings";
    render();
  });
  document.getElementById("open-manager")?.addEventListener("click", async () => {
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

  document.getElementById("np-play-pause")?.addEventListener("click", async () => {
    const tabId = getNowPlayingTabId();
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;
    const state = await togglePlayback(tabId);
    if (state) {
      video.paused = state.paused;
      video.currentTime = state.currentTime;
      video.audible = !state.paused && !state.muted && state.volume > 0;
      await persistLastPlayingTabId(tabId);
      updateNowPlayingControls(state);
      render();
    }
  });

  const goToNowPlayingTab = async () => {
    const tabId = getNowPlayingTabId();
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;
    await browser.tabs.update(tabId, { active: true });
    if (video.windowId != null) {
      await browser.windows.update(video.windowId, { focused: true });
    }
  };

  document.getElementById("np-go-to-tab")?.addEventListener("click", goToNowPlayingTab);
  document.getElementById("np-title")?.addEventListener("click", goToNowPlayingTab);
  document.getElementById("np-thumb-btn")?.addEventListener("click", goToNowPlayingTab);

  document.getElementById("np-volume")?.addEventListener("input", async (event) => {
    const tabId = getNowPlayingTabId();
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    const state = await setPlaybackVolume(tabId, value / 100);
    if (state) {
      video.audible = !state.paused && !state.muted && state.volume > 0;
      await persistLastPlayingTabId(tabId);
      updateNowPlayingControls(state);
    }
  });

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
      await saveStorage();
      render();
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

function updateNowPlayingControls(state: PlaybackState): void {
  const playBtn = document.getElementById("np-play-pause");
  const volumeInput = document.getElementById("np-volume") as HTMLInputElement | null;
  const volumeIcon = document.getElementById("np-volume-icon");
  const statusEl = document.getElementById("np-status");
  const card = document.getElementById("np-card");
  const indicator = document.querySelector(".np-indicator");

  const isPlaying = !state.paused && !state.muted && state.volume > 0;

  if (playBtn) {
    playBtn.innerHTML = state.paused ? PLAY_ICON : PAUSE_ICON;
    playBtn.title = state.paused ? "Play" : "Pause";
  }
  if (volumeInput) {
    const displayVolume = state.muted ? 0 : Math.round(state.volume * 100);
    volumeInput.value = String(displayVolume);
  }
  if (volumeIcon) {
    const vol = state.muted ? 0 : state.volume;
    const paths =
      vol === 0 ? VOLUME_ICON_MUTE : vol < 0.35 ? VOLUME_ICON_LOW : vol < 0.7 ? VOLUME_ICON_MED : VOLUME_ICON_HIGH;
    volumeIcon.innerHTML = paths;
  }
  if (statusEl) {
    statusEl.textContent = isPlaying ? "Now playing" : "Paused";
    statusEl.className = `text-[10px] font-bold uppercase tracking-wider ${
      isPlaying ? "text-accent" : "text-text-muted"
    }`;
  }
  if (card) {
    card.className = `px-3 py-2 transition-all duration-300 ${
      isPlaying
        ? "bg-accent/5 ring-1 ring-inset ring-accent/30"
        : ""
    }`;
  }
  if (indicator) {
    indicator.classList.toggle("animate-pulse", isPlaying);
    indicator.classList.toggle("shadow-[0_0_8px_rgba(255,0,0,0.8)]", isPlaying);
    (indicator as HTMLElement).classList.toggle("bg-accent", isPlaying);
    (indicator as HTMLElement).classList.toggle("bg-text-muted", !isPlaying);
  }
}

async function updateNowPlaying(): Promise<void> {
  const section = document.getElementById("now-playing");
  const video = getNowPlayingVideo();
  if (!section || !video) {
    if (section) {
      section.classList.add("hidden");
      delete section.dataset.tabId;
    }
    return;
  }

  section.classList.remove("hidden");
  section.dataset.tabId = String(video.id);

  const channelEl = document.getElementById("np-channel") as HTMLElement;
  const channelName =
    video.channelName && video.channelName !== "YouTube" && video.channelName !== "YouTube Video"
      ? video.channelName
      : "";
  channelEl.innerText = channelName;
  channelEl.classList.toggle("hidden", !channelName);

  const titleEl = document.getElementById("np-title") as HTMLElement;
  titleEl.innerText = video.title;
  titleEl.title = video.title;

  const thumbEl = document.getElementById("np-thumb") as HTMLImageElement | null;
  const thumbUrl = getThumbnailUrl(video.url);
  if (thumbEl) {
    if (thumbUrl) {
      thumbEl.src = thumbUrl;
      thumbEl.classList.remove("hidden");
    } else {
      thumbEl.removeAttribute("src");
      thumbEl.classList.add("hidden");
    }
  }

  const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
  (document.getElementById("np-progress") as HTMLElement).style.width = `${watchedPercent}%`;

  const timeEl = document.getElementById("np-time") as HTMLElement;
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

  const playback = await getPlaybackState(video.id);
  if (playback) {
    video.paused = playback.paused;
    video.currentTime = playback.currentTime;
    updateNowPlayingControls(playback);
  } else {
    updateNowPlayingControls({
      paused: video.paused ?? !video.audible,
      volume: 1,
      muted: false,
      currentTime: video.currentTime,
    });
  }
}

function getNowPlayingTabIdForList(): number | null {
  return getNowPlayingVideo()?.id ?? null;
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

  const overallProgress = document.getElementById("stat-overall-progress");
  if (overallProgress) {
    const percent = totalSeconds > 0 ? (totalWatched / totalSeconds) * 100 : 0;
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
  const nowPlayingId = getNowPlayingTabIdForList();
  const isNowPlaying = nowPlayingId === video.id;
  const isActiveTab = video.active && !isNowPlaying;
  const stateClasses = isNowPlaying
    ? "bg-gradient-to-r from-accent/15 via-accent/5 to-transparent ring-1 ring-inset ring-accent/25"
    : isActiveTab
      ? "ring-1 ring-inset ring-white/10"
      : "hover:bg-white/5";
  item.className = `group relative flex gap-2 p-1.5 rounded-lg transition-all duration-200 ${stateClasses} ${
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

  (item.querySelector(".meta-progress") as HTMLElement).style.width = `${watchedPercent}%`;

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
      item.className = "group relative flex gap-2 p-1.5 rounded-lg transition-all duration-200";
      item.innerHTML = `
            <div class="relative shrink-0 w-[5.5rem] aspect-video rounded-md overflow-hidden bg-surface-hover ring-1 ring-white/10">
              <img class="meta-thumb w-full h-full object-cover hidden" alt="" />
              <div class="meta-duration-badge absolute bottom-1 right-1 px-1 py-px rounded text-[10px] font-medium bg-black/80 text-white tabular-nums leading-none"></div>
              <div class="absolute bottom-0 inset-x-0 h-0.5 bg-black/40">
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

function showLoading(): void {
  resetVideoListFingerprint();
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="min-h-[22rem] flex flex-col items-center justify-center gap-4 px-8">
      <div class="w-10 h-10 rounded-full border-2 border-white/10 border-t-accent animate-spin"></div>
      <p class="text-sm text-text-muted">Scanning your tabs…</p>
    </div>
  `;
}

async function getYouTubeTabs(): Promise<void> {
  if (videoData.length === 0) showLoading();

  try {
    const currentWindow = await browser.windows.getCurrent();
    popupWindowId = currentWindow.id ?? null;

    const now = Date.now();
    const storage =
      lastStorageData && now - lastStorageLoadTime < POPUP_STORAGE_READ_SKIP_MS
        ? lastStorageData
        : await (async () => {
            const s = await loadStorage();
            lastStorageData = s;
            lastStorageLoadTime = Date.now();
            return s;
          })();
    const { sortByDuration: savedSort, excludedUrls, metadataCache } = storage;
    sortByDuration = savedSort;

    const allTabs = await browser.tabs.query({});
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
    videoData = tabs.map((tab, index) => {
      const url = tab.url!;
      const normalizedUrl = normalizeYoutubeUrl(url);
      const rawCached = metadataCache[normalizedUrl];
      const expectedVideoId = getVideoIdFromUrl(url);
      const cached =
        rawCached &&
        rawCached.videoId !== undefined &&
        rawCached.videoId === expectedVideoId &&
        isCacheEntryUsable(rawCached)
          ? rawCached
          : undefined;

        return {
          id: tab.id || 0,
          title: cached?.title || "YouTube Video",
          channelName: cached?.channelName || "",
          seconds: cached?.seconds || 0,
          currentTime: cached?.currentTime || parseTimeParam(url),
          excluded: excludedUrls.includes(normalizedUrl),
          index: index,
          url: url,
          suspended: tab.discarded || false,
          active: tab.active,
          audible: tab.audible || false,
          paused: cached?.paused,
          isLive: cached?.isLive || false,
          windowId: tab.windowId,
        };
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
        const playing = audibleInWindow.find((video) => video.active) ?? audibleInWindow[0];
        if (playing) await persistLastPlayingTabId(playing.id);
      } else if (lastPlayingTabId) {
        const last = videoData.find((video) => video.id === lastPlayingTabId);
        if (!isVideoEligibleForNowPlaying(last)) {
          await clearLastPlayingTabId();
        }
      }
    }

    // Render immediately so user sees the list with whatever we have (cached or tab title / 0:00 defaults)
    render();

    const activeTabPromises = videoData.map(async (video) => {
      if (video.suspended) return;

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
          const verifyResults = await browser.scripting.executeScript({
            target: { tabId: video.id },
            world: "MAIN",
            func: () => (window as unknown as { ytInitialPlayerResponse?: { videoDetails?: { videoId?: string } } }).ytInitialPlayerResponse?.videoDetails?.videoId ?? null,
          }).catch(() => null);
          const pageVideoId = verifyResults?.[0]?.result ?? null;
          if (pageVideoId === expectedVideoId) {
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
          return;
        }
      } catch {
        // No content script (e.g. tab loaded before extension) — fall through to inject
      }

      // STALE-WHILE-REVALIDATE LOGIC
      // If we have a valid duration and title, we only NEED to probe for currentTime
      const hasValidMetadata = video.seconds > 0 &&
                               video.title !== "YouTube Video" &&
                               video.title !== "YouTube" &&
                               !/^\(\d+\)\s*/.test(video.title);

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
