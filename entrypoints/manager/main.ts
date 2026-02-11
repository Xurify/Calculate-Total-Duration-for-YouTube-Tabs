import "./style.css";
import packageJson from "../../package.json";
import {
  VideoData,
  loadStorage,
  saveStorage as saveStorageUtil,
  normalizeYoutubeUrl,
  CachedMetadata,
  requestMetadataUpdate,
  clearCache,
  getSavedSessions,
  saveSession,
  deleteSession,
  setSessionPinned,
  updateSessionTabs,
  type SavedSessionTab,
  type SavedSession
} from "../../utils/storage";
import { formatTime, formatCompact, parseTimeParam, getVideoIdFromUrl } from "../../utils/format";

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
let metadataCache: Record<string, CachedMetadata> = {};

let searchQuery = "";
let groupingMode: 'none' | 'channel' = 'none';
let layoutMode: 'list' | 'grid' = 'grid';
let thumbnailQuality: 'standard' | 'high' = 'high';
let isSettingsOpen = false;

let sortOption: string = 'duration-desc';
let collapsedGroups = new Set<string>();
let renderTimeout: ReturnType<typeof setTimeout> | null = null;
let searchDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
const SEARCH_DEBOUNCE_MS = 200;

let sidebarContextTarget: { type: "all" | "window" | "session"; windowId?: number; sessionId?: string } | null = null;

/** When set, main view shows this session's tab list instead of live windows. */
let selectedSession: SavedSession | null = null;
/** When viewing a saved session, URLs of tabs selected in the grid/list (for remove-from-session). */
let selectedSessionTabUrls = new Set<string>();

async function fetchTabs() {
  const storage = await loadStorage();
  metadataCache = storage.metadataCache;
  const excludedUrls = storage.excludedUrls;
  thumbnailQuality = storage.thumbnailQuality;
  groupingMode = storage.groupingMode;
  layoutMode = storage.layoutMode;
  sortOption = storage.sortOption;

  const allTabs = await browser.tabs.query({});
  const youtubeTabs = allTabs.filter(tab => {
    if (!tab.url) return false;
    try {
      const url = new URL(tab.url);
      return (
        (url.hostname.endsWith("youtube.com") || url.hostname === "youtube.com") &&
        (url.pathname.startsWith("/watch") || url.pathname.startsWith("/shorts"))
      );
    } catch {
      return false;
    }
  });

  allVideos = youtubeTabs.map((tab, index) => {
    const url = tab.url!;
    const normalizedUrl = normalizeYoutubeUrl(url);
    const cached = metadataCache[normalizedUrl];

    // Clean "(1030) " notification count from tab title if present
    let initialTitle = tab.title || "YouTube Video";
    initialTitle = initialTitle.replace(/^\(\d+\)\s*/g, "");
    initialTitle = initialTitle.replace(" - YouTube", "").trim();

    return {
      id: tab.id || 0,
      title: cached?.title || initialTitle,
      channelName: cached?.channelName || "",
      seconds: cached?.seconds || 0,
      currentTime: cached?.currentTime || parseTimeParam(url),
      excluded: excludedUrls.includes(url),
      index: index,
      url: url,
      suspended: tab.discarded || false,
      active: tab.active,
      isLive: cached?.isLive || false,
      windowId: tab.windowId
    };
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
      const duration = tabs.reduce((acc, video) => acc + video.seconds, 0);
      return {
        id: window.id!,
        tabs,
        duration,
        label: `Window ${windowIndex + 1}`
      };
    })
    .sort((a, b) => b.tabs.length - a.tabs.length);

  render();
  await probeTabs();

  // After probing: auto-fetch durations for any tab still missing it (suspended or probe failed). Background skips when cache is fresh.
  const tabsWithoutDuration = allVideos.filter((v) => v.seconds === 0 && !v.isLive);
  if (tabsWithoutDuration.length > 0 && Date.now() - lastSyncTime >= SYNC_COOLDOWN_MS) {
    lastSyncTime = Date.now();
    browser.runtime
      .sendMessage({
        action: "sync-all",
        tabs: tabsWithoutDuration.map((v) => ({ id: v.id, url: v.url })),
      })
      .catch(() => {});
  }
}

async function probeTabs() {
  const activeTabPromises = allVideos.map(async (video) => {
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
        requestMetadataUpdate(video.url, {
          seconds: video.seconds,
          title: video.title,
          channelName: video.channelName,
          currentTime: video.currentTime,
          isLive: video.isLive,
        });
        render();
        return;
      }
    } catch {
      // No content script — fall through to inject
    }

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
              } catch (_) { }
            }
            // Shorts fallback 2: duration from ytInitialData (reelWatchEndpoint or other path)
            if (duration === 0 && window.location.pathname.startsWith("/shorts/")) {
              try {
                // @ts-ignore
                const d = window.ytInitialData;
                const ms = d && d.contents && d.contents.reelWatchEndpoint && d.contents.reelWatchEndpoint.approxDurationMs;
                if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
              } catch (_) { }
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
          const tryContentScript = async (): Promise<boolean> => {
            const meta = await browser.tabs.sendMessage(video.id, { action: "get-metadata" }).catch(() => null);
            if (meta?.videoId === expectedVideoId && meta?.title && (meta.seconds > 0 || meta.isLive)) {
              video.title = meta.title;
              video.channelName = meta.channelName ?? "";
              video.seconds = meta.seconds;
              video.currentTime = meta.currentTime ?? 0;
              video.isLive = meta.isLive ?? false;
              if (video.seconds > 0 || video.isLive) {
                requestMetadataUpdate(video.url, { seconds: video.seconds, title: video.title, channelName: video.channelName, currentTime: video.currentTime, isLive: video.isLive });
              }
              render();
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
          video.currentTime = result.currentTime || 0;
        } else {
          const duration = result.duration || 0;
          
          // Always update title/channel if we got valid data
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
              });
            }
          }
          
        }
        render();
      }
    } catch (error) {
      // Ignore errors (permissions, closed tabs, etc)
    }
  });

  await Promise.all(activeTabPromises);
}

function formatSessionDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `Today ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined, hour: "2-digit", minute: "2-digit" });
}

async function loadSessionInCurrentWindow(sessionId: string) {
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === sessionId);
  const tabs = session?.tabs;
  if (!session || !Array.isArray(tabs) || tabs.length === 0) return;
  const current = await browser.windows.getCurrent();
  const windowId = current.id;
  if (windowId == null) return;
  for (const tab of tabs) {
    await browser.tabs.create({ windowId, url: tab.url });
  }
}

async function loadSessionInNewWindow(sessionId: string) {
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === sessionId);
  const tabs = session?.tabs;
  if (!session || !Array.isArray(tabs) || tabs.length === 0) return;
  const win = await browser.windows.create({ url: tabs[0].url });
  if (!win?.id) return;
  for (let i = 1; i < tabs.length; i++) {
    await browser.tabs.create({ windowId: win.id, url: tabs[i].url });
  }
}

async function openSessionsModal() {
  const sessions = await getSavedSessions();
  const listEl = document.getElementById("sessions-list");
  const emptyEl = document.getElementById("sessions-empty");
  const modal = document.getElementById("sessions-modal");
  if (!listEl || !emptyEl || !modal) return;

  if (sessions.length === 0) {
    listEl.innerHTML = "";
    listEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    listEl.innerHTML = sessions
      .map(
        (s) => `
        <div class="flex items-center justify-between gap-3 p-3 rounded-lg border border-border bg-surface hover:bg-surface-hover/50 group" data-session-id="${s.id}">
          <div class="min-w-0 flex-1 flex items-center gap-2">
            <button class="session-pin-btn p-1.5 rounded shrink-0 transition-colors border-0 cursor-pointer ${s.pinned ? "text-accent" : "text-text-muted hover:text-text-secondary"}" data-session-id="${s.id}" data-pinned="${s.pinned ? "1" : "0"}" title="${s.pinned ? "Unpin" : "Pin"}">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
            </button>
            <div class="min-w-0">
              <div class="text-sm font-medium text-text-primary truncate">${escapeHtml(s.name)}</div>
              <div class="text-[11px] text-text-muted mt-0.5">${(s.tabs?.length ?? 0)} tabs · ${formatSessionDate(s.savedAt)}</div>
            </div>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button class="session-open-new-window-btn px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:opacity-90 border-0 cursor-pointer transition-opacity flex items-center gap-1.5" data-session-id="${s.id}" title="Open in a new window">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
              Open in New Window
            </button>
            <button class="session-delete-btn p-1.5 rounded hover:bg-red-500/20 text-text-muted hover:text-red-500 transition-colors border-0 cursor-pointer" data-session-id="${s.id}" title="Delete session">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      `
      )
      .join("");
  }

  modal.classList.remove("hidden");
  modal.classList.add("flex");
  requestAnimationFrame(() => {
    modal.focus();
  });
}

function escapeHtml(s: string): string {
  if (s.length === 0) return s;
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function showNameSessionModal(defaultName: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.getElementById("name-session-modal");
    const input = document.getElementById("name-session-input") as HTMLInputElement;
    const cancelBtn = document.getElementById("name-session-cancel");
    const saveBtn = document.getElementById("name-session-save");
    if (!modal || !input || !cancelBtn || !saveBtn) {
      resolve(null);
      return;
    }
    input.value = defaultName;
    input.select();
    const close = (result: string | null) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      saveBtn.removeEventListener("click", onSave);
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onKeydown);
    };
    const onCancel = () => close(null);
    const onSave = () => close((input.value?.trim() || defaultName));
    const onBackdrop = (e: MouseEvent) => {
      if ((e.target as HTMLElement).id === "name-session-modal") close(null);
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(null);
      if (e.key === "Enter") onSave();
    };
    cancelBtn.addEventListener("click", onCancel);
    saveBtn.addEventListener("click", onSave);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onKeydown);
    modal.classList.remove("hidden");
    modal.classList.add("flex");
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
    okBtn.classList.remove("bg-accent", "hover:opacity-90", "bg-red-600", "hover:bg-red-700", "text-white");
    okBtn.classList.add("text-white");
    if (options.confirmDanger) {
      okBtn.classList.add("bg-red-600", "hover:bg-red-700");
    } else {
      okBtn.classList.add("bg-accent", "hover:opacity-90");
    }
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
      if ((e.target as HTMLElement).id === "confirm-modal") close(false);
    };
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
    modal.classList.add("flex");
  });
}

// Helper to save current settings state
async function saveSettings() {
  // We need to pass all arguments to match signature, but we can rely on current global state
  // To do this safely without re-reading storage every time (which we do in loadStorage anyway), 
  // we should ideally keep a local state object.
  // However, saveStorageUtil needs videoData for excludedUrls. 
  // We will just pass empty videoData since saveStorage filters it. 
  // WAIT: saveStorage OVERWRITES excludedUrls if we pass empty list?
  // Let's check storage.ts.  
  // "const excludedUrls = videoData.filter((video) => video.excluded).map((video) => video.url);"
  // "await browser.storage.local.set(data);" - and data includes excludedUrls.
  // This wipes excluded URLs if we pass []. 
  // CRITICAL FIX: We need to read current storage or pass allVideos.

  // Better approach: Update saveStorage in storage.ts to only update provided keys? 
  // Or just pass allVideos here.

  const storage = await loadStorage();
  await saveStorageUtil(
    allVideos,
    storage.sortByDuration,
    thumbnailQuality,
    layoutMode,
    groupingMode,
    sortOption
  );
}

function renderSidebar() {
  const container = document.getElementById("window-list-windows");
  if (!container) return;

  const totalDuration = allVideos.reduce((acc, video) => acc + video.seconds, 0);
  const totalTabs = allVideos.length;

  document.getElementById("global-stats-count")!.innerText =
    `${totalTabs} videos · ${formatTime(totalDuration)}`;

  let html = `
    <button type="button" class="sidebar-item w-full text-left px-3 py-2 rounded-md mb-1 flex items-center justify-between transition-colors ${currentWindowId === 'all' ? 'bg-surface-hover text-text-primary' : 'text-text-muted hover:bg-surface-hover/50 hover:text-text-secondary'}" data-sidebar-type="all">
      <span class="text-xs font-semibold">All Windows</span>
      <span class="text-[10px] bg-surface-elevated border border-border px-1.5 rounded-full">${totalTabs}</span>
    </button>
  `;

  windowGroups.forEach(group => {
    const isActive = currentWindowId === group.id;
    html += `
      <button type="button" class="sidebar-item w-full text-left px-3 py-2 rounded-md mb-1 flex items-center justify-between transition-colors ${isActive ? 'bg-surface-hover text-text-primary' : 'text-text-muted hover:bg-surface-hover/50 hover:text-text-secondary'}" data-sidebar-type="window" data-window-id="${group.id}">
        <div class="truncate pr-2">
            <div class="text-xs font-semibold truncate">${group.label}</div>
            <div class="text-[10px] font-mono opacity-60">${formatTime(group.duration)}</div>
        </div>
        <span class="text-[10px] bg-surface-elevated border border-border px-1.5 rounded-full">${group.tabs.length}</span>
      </button>
    `;
  });

  container.innerHTML = html;
  // Saved list is NOT updated here — only on explicit actions (save/delete/pin) and initial load
}

async function refreshSavedSessionsSidebar() {
  const sessions = await getSavedSessions();
  const container = document.getElementById("saved-sessions-sidebar");
  if (!container) return;
  if (sessions.length === 0) {
    container.innerHTML = `<div class="px-3 py-2 text-[11px] text-text-muted">No saved sessions</div>`;
    return;
  }
  const isSelected = (sid: string) => selectedSession?.id === sid;
  container.innerHTML = sessions
    .map(
      (s) => {
        const active = isSelected(s.id);
        return `
    <button type="button" class="sidebar-item sidebar-item-session w-full text-left px-3 py-2 rounded-md mb-1 flex items-center gap-2 transition-colors ${active ? "bg-surface-hover text-text-primary" : "text-text-muted hover:bg-surface-hover/50 hover:text-text-secondary"}" data-sidebar-type="session" data-session-id="${s.id}" data-pinned="${s.pinned ? "1" : "0"}">
      ${s.pinned ? `<svg class="shrink-0 w-3 h-3 text-accent" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>` : ""}
      <div class="truncate min-w-0 flex-1">
        <div class="text-xs font-semibold truncate">${escapeHtml(s.name)}</div>
        <div class="text-[10px] font-mono opacity-60">${(s.tabs?.length ?? 0)} tabs</div>
      </div>
    </button>
  `;
      }
    )
    .join("");
}

function sortVideos(videos: VideoData[]): VideoData[] {
  return [...videos].sort((a, b) => {
    switch (sortOption) {
      case 'index-asc': return a.index - b.index;
      case 'duration-desc': return b.seconds - a.seconds;
      case 'duration-asc': return a.seconds - b.seconds;
      case 'title-asc': return a.title.localeCompare(b.title);
      case 'channel-asc': return a.channelName.localeCompare(b.channelName);
      default: return 0;
    }
  });
}

const SYNC_COOLDOWN_MS = 30_000;
let lastSyncTime = 0;

/** Debounce tab-event-driven fetch so opening many tabs (e.g. "Open in New Window") doesn't re-render the sidebar repeatedly. */
let fetchTabsFromEventsTimeout: ReturnType<typeof setTimeout> | null = null;
const FETCH_TABS_DEBOUNCE_MS = 400;

function scheduleFetchTabsFromEvents() {
  if (fetchTabsFromEventsTimeout != null) clearTimeout(fetchTabsFromEventsTimeout);
  fetchTabsFromEventsTimeout = setTimeout(() => {
    fetchTabsFromEventsTimeout = null;
    fetchTabs();
  }, FETCH_TABS_DEBOUNCE_MS);
}

function renderMain() {
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
      settingsModal.classList.add("flex", "animate-in", "fade-in");
      const devVersion = document.getElementById("dev-version");
      if (devVersion) devVersion.textContent = `v${packageJson.version}`;
    } else {
      settingsModal.classList.add("hidden");
      settingsModal.classList.remove("flex", "animate-in", "fade-in");
    }

    const btnQualityStd = document.getElementById("quality-standard");
    const btnQualityHigh = document.getElementById("quality-high");

    if (btnQualityStd && btnQualityHigh) {
      if (thumbnailQuality === 'standard') {
        btnQualityStd.classList.add('text-accent', 'bg-surface-hover');
        btnQualityStd.classList.remove('text-text-muted');
        btnQualityHigh.classList.remove('text-accent', 'bg-surface-hover');
        btnQualityHigh.classList.add('text-text-muted');
      } else {
        btnQualityHigh.classList.add('text-accent', 'bg-surface-hover');
        btnQualityHigh.classList.remove('text-text-muted');
        btnQualityStd.classList.remove('text-accent', 'bg-surface-hover');
        btnQualityStd.classList.add('text-text-muted');
      }
    }
  }
  const btnGroupNone = document.getElementById('view-list'); // "None" button
  const btnGroupChannel = document.getElementById('view-channel');

  if (btnGroupNone && btnGroupChannel) {
    if (groupingMode === 'none') {
      btnGroupNone.classList.add('text-accent', 'bg-surface-hover');
      btnGroupNone.classList.remove('text-text-muted');
      btnGroupChannel.classList.remove('text-accent', 'bg-surface-hover');
      btnGroupChannel.classList.add('text-text-muted');
    } else {
      btnGroupChannel.classList.add('text-accent', 'bg-surface-hover');
      btnGroupChannel.classList.remove('text-text-muted');
      btnGroupNone.classList.remove('text-accent', 'bg-surface-hover');
      btnGroupNone.classList.add('text-text-muted');
    }
  }

  // Layout Toggles
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

  if (selectedSession) {
    if (viewToolbar) viewToolbar.classList.remove("hidden");
    const session = selectedSession;
    let tabsToShow: SavedSessionTab[] = session.tabs ?? [];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      tabsToShow = tabsToShow.filter(
        (t) =>
          (t.title ?? "").toLowerCase().includes(q) ||
          (t.channelName ?? "").toLowerCase().includes(q)
      );
    }
    const totalSec = tabsToShow.reduce((acc, t) => acc + (t.seconds ?? 0), 0);
    headerTitle.innerText = session.name;
    headerStats.innerText = `${tabsToShow.length} videos · ${formatTime(totalSec)} total duration`;

    if (tabsToShow.length === 0) {
      container.innerHTML = `
      <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="session-open-current-window" class="px-4 py-2 text-sm font-medium rounded-md bg-accent text-white hover:opacity-90 border-0 cursor-pointer transition-opacity">
            Open in current window
          </button>
          <button type="button" id="session-open-new-window" class="px-4 py-2 text-sm font-medium rounded-md border border-border bg-surface-hover text-text-primary hover:bg-surface transition-colors cursor-pointer">
            Open in New Window
          </button>
        </div>
        <div class="flex flex-col items-center justify-center py-16 opacity-40">
          <div class="text-4xl mb-4">📺</div>
          <div>No videos found</div>
        </div>
      </div>
    `;
    } else {
      let contentHtml: string;
      if (groupingMode === "channel") {
        const channels = new Map<string, SavedSessionTab[]>();
        tabsToShow.forEach((t) => {
          const name = t.channelName ?? "Unknown Channel";
          if (!channels.has(name)) channels.set(name, []);
          channels.get(name)!.push(t);
        });
        let sortedGroups = Array.from(channels.entries());
        if (sortOption === "channel-asc") {
          sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
        } else if (sortOption === "duration-desc") {
          sortedGroups.sort((a, b) => {
            const dA = a[1].reduce((acc, t) => acc + (t.seconds ?? 0), 0);
            const dB = b[1].reduce((acc, t) => acc + (t.seconds ?? 0), 0);
            return dB - dA;
          });
        } else if (sortOption === "duration-asc") {
          sortedGroups.sort((a, b) => {
            const dA = a[1].reduce((acc, t) => acc + (t.seconds ?? 0), 0);
            const dB = b[1].reduce((acc, t) => acc + (t.seconds ?? 0), 0);
            return dA - dB;
          });
        }
        contentHtml = sortedGroups
          .map(([channel, tabList]) => {
            const isCollapsed = collapsedGroups.has(channel);
            const groupDuration = tabList.reduce((acc, t) => acc + (t.seconds ?? 0), 0);
            const sortedTabs = sortSessionTabs(tabList);
            const gridOrList =
              layoutMode === "grid"
                ? renderSessionGrid(sortedTabs)
                : renderSessionList(sortedTabs);
            return `
            <div class="mb-4">
              <div class="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-hover/30 group/header select-none">
                <button class="p-1 rounded hover:bg-surface-hover text-text-muted transition-transform duration-200 group-toggle ${isCollapsed ? "-rotate-90" : ""}" data-group="${escapeHtml(channel)}">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
                <div class="flex-1 font-medium text-sm text-text-primary truncate cursor-pointer group-toggle" data-group="${escapeHtml(channel)}">${escapeHtml(channel)}</div>
                <div class="text-[10px] text-text-muted font-mono flex items-center gap-2">
                  <span>${tabList.length} videos</span>
                  <span class="w-px h-3 bg-border"></span>
                  <span>${formatTime(groupDuration)}</span>
                </div>
              </div>
              <div class="space-y-1 ml-12 border-l border-border pl-2 mt-1 ${isCollapsed ? "hidden" : ""}">
                ${gridOrList}
              </div>
            </div>
          `;
          })
          .join("");
        setTimeout(() => {
          container.querySelectorAll(".group-toggle").forEach((el) => {
            el.addEventListener("click", () => {
              const groupName = (el as HTMLElement).dataset.group;
              if (groupName) {
                if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
                else collapsedGroups.add(groupName);
                render();
              }
            });
          });
        }, 0);
      } else {
        const sorted = sortSessionTabs(tabsToShow);
        contentHtml =
          layoutMode === "grid"
            ? renderSessionGrid(sorted)
            : renderSessionList(sorted);
      }
      container.innerHTML = `
      <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="session-open-current-window" class="px-4 py-2 text-sm font-medium rounded-md bg-accent text-white hover:opacity-90 border-0 cursor-pointer transition-opacity">
            Open in current window
          </button>
          <button type="button" id="session-open-new-window" class="px-4 py-2 text-sm font-medium rounded-md border border-border bg-surface-hover text-text-primary hover:bg-surface transition-colors cursor-pointer">
            Open in New Window
          </button>
        </div>
        ${contentHtml}
      </div>
    `;
    }
    const openCurrentBtn = document.getElementById("session-open-current-window");
    const openNewBtn = document.getElementById("session-open-new-window");
    const tabCount = session.tabs?.length ?? 0;
    openCurrentBtn?.addEventListener("click", async () => {
      const confirmed = await showConfirm({
        title: "Open in current window",
        message: `Open ${tabCount} tabs in the current window?`,
        confirmLabel: "Open",
      });
      if (confirmed) await loadSessionInCurrentWindow(session.id);
    });
    openNewBtn?.addEventListener("click", () => loadSessionInNewWindow(session.id));
    return;
  }

  if (viewToolbar) viewToolbar.classList.remove("hidden");

  let videosToShow: VideoData[] = [];

  if (currentWindowId === 'all') {
    headerTitle.innerText = "All Windows";
    videosToShow = allVideos;
  } else {
    const group = windowGroups.find(windowGroup => windowGroup.id === currentWindowId);
    if (group) {
      headerTitle.innerText = group.label;
      videosToShow = group.tabs;
    }
  }

  if (searchQuery) {
    const searchQueryLower = searchQuery.toLowerCase();
    videosToShow = videosToShow.filter(video =>
      video.title.toLowerCase().includes(searchQueryLower) ||
      video.channelName.toLowerCase().includes(searchQueryLower)
    );
  }

  const duration = videosToShow.reduce((acc, video) => acc + video.seconds, 0);
  headerStats.innerText = `${videosToShow.length} videos · ${formatTime(duration)} total duration`;

  if (videosToShow.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full opacity-40">
        <div class="text-4xl mb-4">📺</div>
        <div>No videos found</div>
      </div>
    `;
    return;
  }

  if (groupingMode === 'none') {
    const sortedVideos = sortVideos(videosToShow);
    if (layoutMode === 'grid') {
      container.innerHTML = renderVideoGrid(sortedVideos);
    } else {
      container.innerHTML = renderVideoList(sortedVideos);
    }
  } else {
    const channels = new Map<string, VideoData[]>();
    videosToShow.forEach(video => {
      const name = video.channelName || "Unknown Channel";
      if (!channels.has(name)) channels.set(name, []);
      channels.get(name)!.push(video);
    });

    let sortedGroups = Array.from(channels.entries());

    if (sortOption === 'channel-asc') {
      sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
    } else if (sortOption === 'duration-desc') {
      sortedGroups.sort((a, b) => {
        const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
        const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
        return durationB - durationA;
      });
    } else if (sortOption === 'duration-asc') {
      sortedGroups.sort((a, b) => {
        const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
        const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
        return durationA - durationB;
      });
    }

    container.innerHTML = sortedGroups.map(([channel, videos]) => {
      const isCollapsed = collapsedGroups.has(channel);
      const groupDuration = videos.reduce((acc, video) => acc + video.seconds, 0);
      const sortedGroupVideos = sortVideos(videos);

      const allSelected = videos.every(video => selectedTabIds.has(video.id));
      const someSelected = !allSelected && videos.some(video => selectedTabIds.has(video.id));

      return `
            <div class="mb-4">
                <div class="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-hover/30 group/header select-none">
                    <button class="p-1 rounded hover:bg-surface-hover text-text-muted transition-transform duration-200 group-toggle ${isCollapsed ? '-rotate-90' : ''}" data-group="${channel}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    
                     <!-- Group Checkbox -->
                    <div class="relative flex items-center justify-center w-4 h-4 cursor-pointer group-selection-toggle" data-group="${channel}">
                      <input type="checkbox" class="peer appearance-none w-3.5 h-3.5 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${allSelected ? 'checked' : ''} ${someSelected ? 'indeterminate' : ''}>
                       <svg class="absolute w-2 h-2 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                       <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 ${someSelected && !allSelected ? 'opacity-100' : ''}">
                          <div class="w-2 h-0.5 bg-accent"></div>
                       </div>
                    </div>

                    <div class="flex-1 font-medium text-sm text-text-primary truncate cursor-pointer group-toggle" data-group="${channel}">${channel}</div>
                    <div class="text-[10px] text-text-muted font-mono flex items-center gap-2">
                        <span>${videos.length} videos</span>
                        <span class="w-px h-3 bg-border"></span>
                        <span>${formatTime(groupDuration)}</span>
                    </div>
                </div>
                
                <div class="space-y-1 ml-12 border-l border-border pl-2 mt-1 ${isCollapsed ? 'hidden' : ''}">
                    ${layoutMode === 'grid' ? renderVideoGrid(sortedGroupVideos) : renderVideoList(sortedGroupVideos)}
                </div>
            </div>
          `;
    }).join('');

    // Fix indeterminate states visually since HTML attribute doesn't set property
    setTimeout(() => {
      document.querySelectorAll('input[type="checkbox"]').forEach((element: any) => {
        if (element.hasAttribute('indeterminate')) element.indeterminate = true;
      });
    }, 0);
  }
}

function renderVideoList(videos: VideoData[]): string {
  return videos.map(video => {
    const isSelected = selectedTabIds.has(video.id);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;

    return `
      <div class="group relative flex items-center gap-4 p-3 rounded-lg border border-transparent hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? 'bg-surface-hover border-border' : ''}" data-id="${video.id}">
        <div class="relative flex items-center justify-center w-5 h-5 cursor-pointer selection-toggle">
          <input type="checkbox" class="peer appearance-none w-4 h-4 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${isSelected ? 'checked' : ''}>
          <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>

        <div class="flex-1 min-w-0 cursor-pointer video-click-target pr-16">
           <div class="flex items-baseline gap-2 mb-1">
             <h3 class="text-sm font-medium text-text-primary truncate" title="${video.title}">${video.title}</h3>
             <span class="text-[10px] text-text-muted truncate uppercase tracking-tight">${video.channelName}</span>
           </div>
           
           <div class="flex items-center gap-3 w-full max-w-md bg-surface-elevated/50 py-1 px-2 rounded-md">
             <div class="text-xs font-mono text-text-secondary whitespace-nowrap">
                <span class="${watchedPercent > 0 ? "text-text-primary" : "text-text-muted"}">${formatCompact(video.currentTime)}</span>
                <span class="mx-0.5 opacity-30">/</span>
                <span>${formatCompact(video.seconds)}</span>
             </div>
             <div class="flex-1 h-1 bg-surface rounded-full overflow-hidden">
                <div class="h-full bg-accent opacity-80" style="width: ${watchedPercent}%"></div>
             </div>
           </div>
        </div>

        <div class="absolute right-4 opacity-0 group-hover:opacity-100 flex items-center gap-2 transition-opacity bg-surface-elevated/90 backdrop-blur-sm rounded-md p-1 shadow-sm border border-border/50">
           <button class="p-1.5 hover:bg-surface text-text-muted hover:text-white rounded transition-colors jump-btn" title="Go to Tab">
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
           </button>
           <button class="p-1.5 hover:bg-red-500/10 text-text-muted hover:text-red-500 rounded transition-colors close-btn" title="Close Tab">
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
           </button>
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

function renderSessionGrid(tabs: SavedSessionTab[]): string {
  if (tabs.length === 0) return "";
  const thumbQuality = thumbnailQuality === "high" ? "hqdefault.jpg" : "mqdefault.jpg";
  const cardsHtml = tabs.map((t) => {
    const videoId = getVideoIdFromUrl(t.url);
    const thumbnailUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/${thumbQuality}` : "";
    const title = t.title ?? "Untitled";
    const channel = t.channelName ?? "";
    const sec = t.seconds ?? 0;
    const isSelected = selectedSessionTabUrls.has(t.url);
    const urlAttr = escapeHtml(t.url);
    return `
      <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? "bg-surface-hover border-border ring-1 ring-accent/50" : ""}" data-session-tab-url="${urlAttr}">
        <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden session-video-click-target cursor-pointer">
          ${thumbnailUrl
        ? `<img src="${thumbnailUrl}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" alt="" />`
        : `<div class="w-full h-full flex items-center justify-center text-text-muted/20"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>`
      }
          <div class="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-mono font-medium text-white backdrop-blur-sm">
            ${formatCompact(sec)}
          </div>
          <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? "opacity-100" : ""} session-selection-toggle flex items-center justify-center w-5 h-5">
            <input type="checkbox" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" ${isSelected ? "checked" : ""}>
            <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div class="absolute top-1 right-1 flex gap-1 transform translate-x-2 opacity-0 group-hover:translate-x-0 group-hover:opacity-100 transition-all duration-200">
            <button type="button" class="p-1.5 hover:bg-red-500/80 bg-black/40 text-white rounded-md backdrop-blur-sm transition-colors session-remove-btn" title="Remove from session">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
            </button>
          </div>
        </div>
        <div class="p-2 session-video-click-target cursor-pointer">
          <h3 class="text-xs font-medium text-text-primary line-clamp-2 leading-snug mb-1 min-h-[2.5em]" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
          <div class="text-[10px] text-text-muted truncate">${escapeHtml(channel)}</div>
        </div>
      </div>
    `;
  }).join("");
  return `<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 p-1">${cardsHtml}</div>`;
}

function renderSessionList(tabs: SavedSessionTab[]): string {
  return tabs.map((t) => {
    const title = t.title ?? "Untitled";
    const channel = t.channelName ?? "";
    const sec = t.seconds ?? 0;
    const isSelected = selectedSessionTabUrls.has(t.url);
    const urlAttr = escapeHtml(t.url);
    return `
      <div class="group relative flex items-center gap-4 p-3 rounded-lg border border-transparent hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? "bg-surface-hover border-border" : ""}" data-session-tab-url="${urlAttr}">
        <div class="relative flex items-center justify-center w-5 h-5 shrink-0 cursor-pointer session-selection-toggle">
          <input type="checkbox" class="peer appearance-none w-4 h-4 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${isSelected ? "checked" : ""}>
          <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="flex-1 min-w-0 pr-12 session-video-click-target cursor-pointer">
          <div class="flex items-baseline gap-2 mb-1">
            <h3 class="text-sm font-medium text-text-primary truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
            <span class="text-[10px] text-text-muted truncate uppercase tracking-tight">${escapeHtml(channel)}</span>
          </div>
          <div class="text-xs font-mono text-text-muted">${formatCompact(sec)}</div>
        </div>
        <button type="button" class="absolute right-4 p-1.5 rounded hover:bg-red-500/20 text-text-muted hover:text-red-500 transition-colors session-remove-btn" title="Remove from session">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
        </button>
      </div>
    `;
  }).join("");
}

function renderVideoGrid(videos: VideoData[]): string {
  if (videos.length === 0) return '';

  const cardsHtml = videos.map(video => {
    const isSelected = selectedTabIds.has(video.id);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
    const videoId = getVideoIdFromUrl(video.url);
    const thumbQuality = thumbnailQuality === 'high' ? 'hqdefault.jpg' : 'mqdefault.jpg';
    const thumbnailUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/${thumbQuality}` : '';

    return `
            <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? 'bg-surface-hover border-border ring-1 ring-accent/50' : ''}" data-id="${video.id}">
                
                <!-- Thumbnail Area -->
                <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden video-click-target cursor-pointer">
                    ${thumbnailUrl
        ? `<img src="${thumbnailUrl}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" alt="" />`
        : `<div class="w-full h-full flex items-center justify-center text-text-muted/20"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>`
      }
                    
                    <!-- Duration Badge -->
                    <div class="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-mono font-medium text-white backdrop-blur-sm">
                        ${video.isLive ? 'LIVE' : formatCompact(video.seconds)}
                    </div>

                    <!-- Progress Bar (Overlay at bottom of thumb) -->
                    ${watchedPercent > 0 ? `
                    <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-surface/30">
                        <div class="h-full bg-accent" style="width: ${watchedPercent}%"></div>
                    </div>` : ''}

                    <!-- Selection Checkbox (Top Left) -->
                    <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'opacity-100' : ''} selection-toggle flex items-center justify-center w-5 h-5">
                        <input type="checkbox" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" ${isSelected ? 'checked' : ''}>
                        <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>

                    <!-- Hover Actions (Top Right) -->
                    <div class="absolute top-1 right-1 flex gap-1 transform translate-x-2 opacity-0 group-hover:translate-x-0 group-hover:opacity-100 transition-all duration-200">
                         <button class="p-1.5 hover:bg-black/60 bg-black/40 text-white rounded-md backdrop-blur-sm transition-colors jump-btn" title="Go to Tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                         </button>
                         <button class="p-1.5 hover:bg-red-500/80 bg-black/40 text-white rounded-md backdrop-blur-sm transition-colors close-btn" title="Close Tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                         </button>
                    </div>
                </div>

                <!-- Info Area -->
                <div class="p-2 video-click-target cursor-pointer">
                    <h3 class="text-xs font-medium text-text-primary line-clamp-2 leading-snug mb-1 min-h-[2.5em]" title="${video.title}">${video.title}</h3>
                    <div class="flex items-center justify-between text-[10px] text-text-muted">
                        <span class="truncate hover:text-text-secondary transition-colors">${video.channelName}</span>
                    </div>
                </div>
            </div>
        `;
  }).join('');

  return `<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 p-1">${cardsHtml}</div>`;
}

function updateSelectionUI() {
  const bar = document.getElementById("selection-actions");
  const count = document.getElementById("selection-count");
  const closeBtn = document.getElementById("btn-close-selected");

  const inSessionView = selectedSession != null;
  const selectionSize = inSessionView ? selectedSessionTabUrls.size : selectedTabIds.size;

  if (selectionSize > 0) {
    bar?.classList.remove("hidden");
    bar?.classList.add("flex");
    if (count) count.innerText = `${selectionSize} selected`;
    if (closeBtn) closeBtn.textContent = inSessionView ? "Remove from session" : "Close Selected";
  } else {
    bar?.classList.add("hidden");
    bar?.classList.remove("flex");
  }

  if (inSessionView) {
    document.querySelectorAll("#tab-list [data-session-tab-url]").forEach((element) => {
      const url = (element as HTMLElement).getAttribute("data-session-tab-url");
      const isSelected = url != null && selectedSessionTabUrls.has(url);
      const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement;
      if (checkbox) checkbox.checked = isSelected;
      if (isSelected) {
        element.classList.add("bg-surface-hover", "border-border", "ring-1", "ring-accent/50");
        element.querySelector(".session-selection-toggle")?.classList.add("opacity-100");
      } else {
        element.classList.remove("bg-surface-hover", "border-border", "ring-1", "ring-accent/50");
        element.querySelector(".session-selection-toggle")?.classList.remove("opacity-100");
      }
    });
    return;
  }

  document.querySelectorAll('#tab-list [data-id]').forEach(element => {
    const id = parseInt((element as HTMLElement).dataset.id || "0");
    const checkbox = element.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const isSelected = selectedTabIds.has(id);
    if (checkbox) checkbox.checked = isSelected;

    if (layoutMode === 'list') {
      if (isSelected) element.classList.add('bg-surface-hover', 'border-border');
      else element.classList.remove('bg-surface-hover', 'border-border');
    } else {
      // Grid mode selection styling
      if (isSelected) element.classList.add('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');
      else element.classList.remove('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');

      const selectionToggle = element.querySelector('.selection-toggle');
      if (selectionToggle) {
        if (isSelected) selectionToggle.classList.add('opacity-100');
        else selectionToggle.classList.remove('opacity-100');
      }
    }
  });
}


function setupListeners() {
  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    fetchTabs();
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
      const newTabs = (selectedSession.tabs ?? []).filter((t) => !urls.includes(t.url ?? ""));
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

  // Sidebar: use event delegation so saved sessions (loaded async) work
  document.getElementById("window-list")?.addEventListener("click", async (event) => {
    const item = (event.target as HTMLElement).closest(".sidebar-item");
    if (!item) return;
    const type = item.getAttribute("data-sidebar-type");
    if (type === "all") {
      selectedSession = null;
      selectedSessionTabUrls.clear();
      currentWindowId = "all";
      render();
    } else if (type === "window") {
      selectedSession = null;
      selectedSessionTabUrls.clear();
      const id = item.getAttribute("data-window-id");
      if (id) {
        currentWindowId = parseInt(id, 10);
        render();
      }
    } else if (type === "session") {
      const id = item.getAttribute("data-session-id");
      if (!id) return;
      const sessions = await getSavedSessions();
      const session = sessions.find((s) => s.id === id);
      if (session) {
        selectedSession = session;
        selectedSessionTabUrls.clear();
        refreshSavedSessionsSidebar();
        render();
      }
    }
  });

  document.getElementById("window-list")?.addEventListener("contextmenu", (event) => {
    const item = (event.target as HTMLElement).closest(".sidebar-item");
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    const type = item.getAttribute("data-sidebar-type") as "all" | "window" | "session" | null;
    if (!type) return;
    const menu = document.getElementById("sidebar-context-menu");
    if (!menu) return;
    sidebarContextTarget = null;
    menu.querySelectorAll(".sidebar-ctx-item").forEach((el) => {
      (el as HTMLElement).classList.add("hidden");
    });
    if (type === "all" || type === "window") {
      sidebarContextTarget = type === "all" ? { type: "all" } : { type: "window", windowId: parseInt(item.getAttribute("data-window-id") || "0", 10) };
      const saveBtn = document.getElementById("ctx-save");
      if (saveBtn) { saveBtn.classList.remove("hidden"); }
    } else if (type === "session") {
      sidebarContextTarget = { type: "session", sessionId: item.getAttribute("data-session-id") || undefined };
      const openBtn = document.getElementById("ctx-open-tabs");
      const pinBtn = document.getElementById("ctx-pin");
      const pinLabel = document.getElementById("ctx-pin-label");
      const delBtn = document.getElementById("ctx-delete");
      if (openBtn) openBtn.classList.remove("hidden");
      if (pinBtn) {
        pinBtn.classList.remove("hidden");
        const pinned = item.getAttribute("data-pinned") === "1";
        if (pinLabel) pinLabel.textContent = pinned ? "Unpin" : "Pin";
      }
      if (delBtn) delBtn.classList.remove("hidden");
    }
    menu.classList.remove("hidden");
    const x = Math.min(event.clientX, window.innerWidth - 180);
    const y = Math.min(event.clientY, window.innerHeight - 120);
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
  });

  // Tab list: one delegated click handler instead of hundreds of per-element listeners
  // Session view: handle remove/selection on session cards first
  document.getElementById("tab-list")?.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const sessionRow = target.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && selectedSession) {
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (url != null) {
        if (target.closest(".session-remove-btn")) {
          event.stopPropagation();
          const tab = (selectedSession.tabs ?? []).find((t) => (t.url ?? "") === url);
          const title = tab?.title ?? "this video";
          const confirmed = await showConfirm({
            title: "Remove from session",
            message: `Remove "${title}" from "${selectedSession.name}"?`,
            confirmLabel: "Remove",
            confirmDanger: true,
          });
          if (!confirmed) return;
          const newTabs = (selectedSession.tabs ?? []).filter((t) => (t.url ?? "") !== url);
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
          render();
          return;
        }
        if (target.closest(".session-video-click-target")) {
          if (selectedSessionTabUrls.has(url)) selectedSessionTabUrls.delete(url);
          else selectedSessionTabUrls.add(url);
          updateSelectionUI();
          render();
          return;
        }
      }
      return;
    }

    // Window view: [data-id] cards
    const row = target.closest("[data-id]") as HTMLElement | null;
    const id = row ? parseInt(row.dataset.id || "0", 10) : 0;

    if (target.closest(".selection-toggle")) {
      event.stopPropagation();
      if (selectedTabIds.has(id)) selectedTabIds.delete(id);
      else selectedTabIds.add(id);
      updateSelectionUI();
      return;
    }
    if (target.closest(".jump-btn")) {
      event.stopPropagation();
      const video = allVideos.find((v) => v.id === id);
      if (video) {
        await browser.tabs.update(video.id, { active: true });
        await browser.windows.update(video.windowId as number, { focused: true });
      }
      return;
    }
    if (target.closest(".close-btn")) {
      event.stopPropagation();
      await browser.tabs.remove(id);
      row?.remove();
      setTimeout(fetchTabs, 100);
      return;
    }
    if (target.closest(".video-click-target")) {
      if (selectedTabIds.has(id)) selectedTabIds.delete(id);
      else selectedTabIds.add(id);
      updateSelectionUI();
      return;
    }
    const groupToggle = target.closest(".group-toggle");
    if (groupToggle) {
      const groupName = (groupToggle as HTMLElement).dataset.group;
      if (groupName) {
        if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
        else collapsedGroups.add(groupName);
        render();
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
          scopeVideos = allVideos.filter((v) => v.windowId === currentWindowId);
        }
        const videosInGroup = scopeVideos.filter(
          (v) => (v.channelName || "Unknown Channel") === groupName
        );
        const allSelected = videosInGroup.every((v) => selectedTabIds.has(v.id));
        videosInGroup.forEach((v) => {
          if (allSelected) selectedTabIds.delete(v.id);
          else selectedTabIds.add(v.id);
        });
        updateSelectionUI();
        render();
      }
    }
  });

  document.getElementById("search-input")?.addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value;
    if (searchDebounceTimeout != null) clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
      searchDebounceTimeout = null;
      searchQuery = value;
      render();
    }, SEARCH_DEBOUNCE_MS);
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

  document.getElementById("btn-save-session")?.addEventListener("click", async () => {
    if (allVideos.length === 0) {
      showToast("No YouTube tabs to save.");
      return;
    }
    const defaultName = `Session ${new Date().toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
    const name = await showNameSessionModal(defaultName);
    if (name === null) return;
    const tabs: SavedSessionTab[] = allVideos.map((v) => ({
      url: v.url,
      title: v.title,
      channelName: v.channelName,
      seconds: v.seconds,
    }));
    try {
      await saveSession(name, tabs);
      await refreshSavedSessionsSidebar();
      showToast(`Saved "${name}" (${tabs.length} tabs)`);
      openSessionsModal();
    } catch (err) {
      console.error("Save session failed:", err);
      showToast("Could not save session.");
    }
  });

  document.getElementById("btn-load-session")?.addEventListener("click", () => {
    openSessionsModal();
  });

  document.getElementById("close-sessions")?.addEventListener("click", () => {
    document.getElementById("sessions-modal")?.classList.add("hidden");
    document.getElementById("sessions-modal")?.classList.remove("flex");
  });

  document.getElementById("sessions-modal")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "sessions-modal") {
      (e.target as HTMLElement).classList.add("hidden");
      (e.target as HTMLElement).classList.remove("flex");
    }
  });

  // Sessions list: one delegated click instead of 3*N listeners
  document.getElementById("sessions-list")?.addEventListener("click", async (e) => {
    const target = e.target as HTMLElement;
    const modal = document.getElementById("sessions-modal");
    const pinBtn = target.closest(".session-pin-btn") as HTMLElement | null;
    const openBtn = target.closest(".session-open-new-window-btn") as HTMLElement | null;
    const delBtn = target.closest(".session-delete-btn") as HTMLElement | null;
    const id = pinBtn?.dataset.sessionId ?? openBtn?.dataset.sessionId ?? delBtn?.dataset.sessionId;
    if (!id) return;
    if (pinBtn) {
      e.stopPropagation();
      const currentlyPinned = pinBtn.dataset.pinned === "1";
      await setSessionPinned(id, !currentlyPinned);
      openSessionsModal();
    } else if (openBtn) {
      await loadSessionInNewWindow(id);
      modal?.classList.add("hidden");
    } else if (delBtn) {
      e.stopPropagation();
      const confirmed = await showConfirm({
        title: "Delete session",
        message: "Delete this saved session?",
        confirmLabel: "Delete",
        confirmDanger: true,
      });
      if (!confirmed) return;
      await deleteSession(id);
      refreshSavedSessionsSidebar();
      openSessionsModal();
    }
  });

  // Context menu actions (right-click sidebar)
  document.getElementById("ctx-save")?.addEventListener("click", async () => {
    const t = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (!t || (t.type !== "all" && t.type !== "window")) return;
    const videosToSave = t.type === "all" ? allVideos : allVideos.filter((v) => v.windowId === t.windowId);
    if (videosToSave.length === 0) {
      showToast("No YouTube tabs to save.");
      return;
    }
    const defaultName = `Session ${new Date().toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
    const name = await showNameSessionModal(defaultName);
    if (name === null) return;
    const tabs: SavedSessionTab[] = videosToSave.map((v) => ({ url: v.url, title: v.title, channelName: v.channelName, seconds: v.seconds }));
    try {
      await saveSession(name, tabs);
      await refreshSavedSessionsSidebar();
      showToast(`Saved "${name}" (${tabs.length} tabs)`);
    } catch (err) {
      console.error("Save session failed:", err);
      showToast("Could not save session.");
    }
  });

  document.getElementById("ctx-open-tabs")?.addEventListener("click", async () => {
    const t = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (t?.type === "session" && t.sessionId) {
      await loadSessionInNewWindow(t.sessionId);
    }
  });

  document.getElementById("ctx-pin")?.addEventListener("click", async () => {
    const t = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (t?.type !== "session" || !t.sessionId) return;
    const sessions = await getSavedSessions();
    const session = sessions.find((s) => s.id === t.sessionId);
    if (!session) return;
    await setSessionPinned(t.sessionId, !session.pinned);
    refreshSavedSessionsSidebar();
  });

  document.getElementById("ctx-delete")?.addEventListener("click", async () => {
    const t = sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (t?.type !== "session" || !t.sessionId) return;
    const confirmed = await showConfirm({
      title: "Delete session",
      message: "Delete this saved session?",
      confirmLabel: "Delete",
      confirmDanger: true,
    });
    if (confirmed) {
      await deleteSession(t.sessionId);
      refreshSavedSessionsSidebar();
      openSessionsModal();
    }
  });

  document.addEventListener("click", () => {
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
  });
  document.getElementById("sidebar-context-menu")?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("contextmenu", () => {
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
  });

  document.getElementById("btn-settings")?.addEventListener("click", () => {
    isSettingsOpen = true;
    render();
  });
  document.getElementById("close-settings")?.addEventListener("click", () => {
    isSettingsOpen = false;
    render();
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

  document.getElementById("sort-select")?.addEventListener("change", (event) => {
    sortOption = (event.target as HTMLSelectElement).value;
    saveSettings();
    render();
  });

  document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
    const confirmed = await showConfirm({
      title: "Clear metadata cache",
      message: "Clear all cached titles and durations? The extension will re-probe tabs when needed.",
      confirmLabel: "Clear cache",
      confirmDanger: true,
    });
    if (confirmed) {
      await clearCache();
      metadataCache = {};
      await fetchTabs();
      isSettingsOpen = false;
      document.getElementById("settings-modal")?.classList.add("hidden");
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
      container.innerHTML = rows.map((r) => `<div class="truncate" title="${r}">${r}</div>`).join("");
    }
  });
}

function render() {
  if (renderTimeout != null) return;
  renderTimeout = setTimeout(() => {
    renderTimeout = null;
    renderSidebar();
    renderMain();
    updateSelectionUI();
    attachDynamicListeners();
  }, 0);
}

function attachDynamicListeners() {
  // Tab list uses delegated click on #tab-list; only fix indeterminate checkbox property (HTML attribute doesn't set it)
  setTimeout(() => {
    document.querySelectorAll("#tab-list input[type='checkbox']").forEach((el: Element) => {
      const input = el as HTMLInputElement;
      if (input.getAttribute("indeterminate") != null) input.indeterminate = true;
    });
  }, 0);
}

document.addEventListener("DOMContentLoaded", () => {
  setupListeners();
  fetchTabs().then(() => refreshSavedSessionsSidebar());

  browser.tabs.onRemoved.addListener(scheduleFetchTabsFromEvents);
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) scheduleFetchTabsFromEvents();
  });

  const VISIBILITY_REFETCH_MS = 2000;
  let lastVisibilityFetch = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastVisibilityFetch < VISIBILITY_REFETCH_MS) return;
    lastVisibilityFetch = Date.now();
    fetchTabs();
  });

  // tab-synced: update in-memory only; sync-complete does one render to avoid N renders for N tabs
  browser.runtime.onMessage.addListener((message) => {
    if (message.action === "tab-synced") {
      const video = allVideos.find((v) => v.id === message.tabId);
      if (video) {
        video.seconds = message.metadata.seconds;
        video.title = message.metadata.title;
        video.channelName = message.metadata.channelName;
        video.isLive = message.metadata.isLive || false;
      }
    }
    if (message.action === "sync-complete") {
      render();
    }
  });
});
