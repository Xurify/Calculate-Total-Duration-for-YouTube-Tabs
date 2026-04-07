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
  renameSession,
  setSessionPinned,
  updateSessionTabs,
  updateSessionSections,
  getLiveTabSections,
  setLiveTabSections,
  isCacheEntryUsable,
  type SavedSessionTab,
  type SavedSession,
  type SessionSection,
  type LiveTabSectionsState,
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

const STORAGE_READ_SKIP_MS = 2000;
let lastStorageLoadTime = 0;
let lastStorageData: Awaited<ReturnType<typeof loadStorage>> | null = null;

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
    const onLoad = () => {
      img.removeAttribute("data-thumbnail-key");
      img.removeEventListener("load", onLoad);
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
          img.src = blobUrl;
        })
        .catch(() => {});
    };
    img.addEventListener("load", onLoad);
  });
}

async function fetchTabs(skipInitialRender = false) {
  const now = Date.now();
  const storage =
    lastStorageData && now - lastStorageLoadTime < STORAGE_READ_SKIP_MS
      ? lastStorageData
      : await (async () => {
          const storage = await loadStorage();
          lastStorageData = storage;
          lastStorageLoadTime = Date.now();
          return storage;
        })();
  metadataCache = storage.metadataCache;
  const excludedUrls = storage.excludedUrls;
  thumbnailQuality = storage.thumbnailQuality;
  groupingMode = storage.groupingMode;
  layoutMode = storage.layoutMode;
  sortOption = storage.sortOption;

  liveTabSectionsState = await getLiveTabSections();

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

  if (!skipInitialRender) render();
  await probeTabs();

  const tabsWithoutDuration = allVideos.filter((video) => video.seconds === 0 && !video.isLive);
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
        const isPlaceholder = (title: string) => !title || title === "YouTube Video" || title === "YouTube";
        video.title = isPlaceholder(contentMeta.title) ? (video.title || contentMeta.title) : contentMeta.title;
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
                const initialData = window.ytInitialData;
                const ms = initialData && initialData.contents && initialData.contents.reelWatchEndpoint && initialData.contents.reelWatchEndpoint.approxDurationMs;
                if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
              } catch (_) { }
            }

            if (!isLive) {
              const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
              if (liveBadge && !liveBadge.hasAttribute("disabled") && getComputedStyle(liveBadge).display !== "none") {
                isLive = true;
              }
            }

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
                requestMetadataUpdate(video.url, { seconds: video.seconds, title: video.title, channelName: video.channelName, currentTime: video.currentTime, isLive: video.isLive, videoId: expectedVideoId ?? undefined });
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
        } else {
          const duration = result.duration || 0;
          
          // Always update title/channel if we got valid data
          const hasValidTitle = result.title && result.title !== "Loading..." && result.title !== "YouTube Video" && result.title !== "YouTube";
          if (hasValidTitle || duration > 0 || result.isLive) {
            // Preserve any existing good title rather than overwriting with a placeholder
            video.title = hasValidTitle ? result.title : (video.title || result.title);
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
          }
          
        }
      }
    } catch (error) {
      // Ignore errors (permissions, closed tabs, etc)
    }
  });

  await Promise.all(activeTabPromises);
  render();
}

async function loadSessionInNewWindow(sessionId: string) {
  const sessions = await getSavedSessions();
  const session = sessions.find((saved) => saved.id === sessionId);
  const tabs = session?.tabs;
  if (!session || !Array.isArray(tabs) || tabs.length === 0) return;
  const win = await browser.windows.create({ url: tabs[0].url });
  if (!win?.id) return;
  for (let i = 1; i < tabs.length; i++) {
    await browser.tabs.create({ windowId: win.id, url: tabs[i].url });
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
  if (colorIndex === "unsorted") return "rgba(255,255,255,0.14)";
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
  const glow =
    options.colorIndex === "unsorted"
      ? "rgba(255,255,255,0.06)"
      : `color-mix(in srgb, ${rail} 35%, transparent)`;
  const surface =
    options.colorIndex === "unsorted"
      ? "var(--color-surface-elevated)"
      : `color-mix(in srgb, var(--color-surface-elevated) 92%, ${rail})`;
  const dataSectionAttr = options.sectionId ? ` data-section-id="${escapeHtml(options.sectionId)}"` : "";
  return `
    <div class="session-section-shell session-section-animate mb-3" style="--section-rail: ${rail}; --section-glow: ${glow}; --section-surface: ${surface}">
      <div class="flex items-stretch gap-0">
        <div class="session-section-rail mx-3 my-3" style="--section-rail: ${rail}" aria-hidden="true"></div>
        <div class="flex-1 min-w-0 py-3 pr-3">
          <div class="flex items-center gap-3 px-1">
            <button type="button" class="section-collapse-toggle p-1.5 rounded-lg hover:bg-white/5 text-text-muted transition-transform duration-200 ${isCollapsed ? "-rotate-90" : ""}" data-section-collapse="${escapeHtml(options.collapseKey)}" aria-expanded="${isCollapsed ? "false" : "true"}">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <div class="flex-1 min-w-0 flex items-baseline gap-2">
              ${options.emoji ? `<span class="text-lg leading-none shrink-0" aria-hidden="true">${escapeHtml(options.emoji)}</span>` : ""}
              <h3 class="session-section-title text-base font-semibold text-text-primary truncate cursor-default section-title-target"${dataSectionAttr}>${escapeHtml(options.title)}</h3>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <span class="session-stat-pill">${escapeHtml(options.countLabel)}</span>
              <span class="session-stat-pill font-mono">${escapeHtml(options.durationLabel)}</span>
            </div>
          </div>
          ${options.subtitle ? `<p class="text-[11px] text-text-muted/90 pl-11 pr-1 mt-1 leading-snug">${escapeHtml(options.subtitle)}</p>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderSectionEmptyPlaceholder(colorIndex: number): string {
  const rail = sectionRailVar(colorIndex);
  return `
    <div class="section-empty-hint mx-1 mb-4 py-8 px-4 text-center text-[12px] text-text-muted/80" style="--section-rail: ${rail}">
      No videos here yet — right-click a video and choose <span class="text-text-secondary font-medium">Move to section</span>
    </div>
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
  if (groupingMode !== "channel") {
    const sorted = sortSessionTabs(tabs);
    return layoutMode === "grid" ? renderSessionGrid(sorted, sectionColor) : renderSessionList(sorted, sectionColor);
  }
  const channels = new Map<string, SavedSessionTab[]>();
  tabs.forEach((tab) => {
    const name = tab.channelName ?? "Unknown Channel";
    if (!channels.has(name)) channels.set(name, []);
    channels.get(name)!.push(tab);
  });
  let sortedGroups = Array.from(channels.entries());
  if (sortOption === "channel-asc") {
    sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
  } else if (sortOption === "duration-desc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationB - durationA;
    });
  } else if (sortOption === "duration-asc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationA - durationB;
    });
  }
  return sortedGroups
    .map(([channel, tabList]) => {
      const ck = nestedChannelCollapseKey(collapseScopeId, channel);
      const isCollapsed = collapsedGroups.has(ck);
      const groupDuration = tabList.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const sortedTabs = sortSessionTabs(tabList);
      const gridOrList =
        layoutMode === "grid" ? renderSessionGrid(sortedTabs, sectionColor) : renderSessionList(sortedTabs, sectionColor);
      return `
            <div class="mb-3">
              <div class="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-surface-hover/30 group/header select-none">
                <button type="button" class="p-1 rounded hover:bg-surface-hover text-text-muted transition-transform duration-200 nested-group-toggle ${isCollapsed ? "-rotate-90" : ""}" data-nested-group="${escapeHtml(ck)}">
                  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
                <div class="flex-1 font-medium text-xs text-text-secondary truncate nested-group-toggle cursor-pointer" data-nested-group="${escapeHtml(ck)}">${escapeHtml(channel)}</div>
                <div class="text-[10px] text-text-muted font-mono flex items-center gap-2">
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
  if (groupingMode !== "channel") {
    const sortedVideos = sortVideos(videos);
    return layoutMode === "grid" ? renderVideoGrid(sortedVideos, sectionColor) : renderVideoList(sortedVideos, sectionColor);
  }
  const channels = new Map<string, VideoData[]>();
  videos.forEach((video) => {
    const name = video.channelName || "Unknown Channel";
    if (!channels.has(name)) channels.set(name, []);
    channels.get(name)!.push(video);
  });
  let sortedGroups = Array.from(channels.entries());
  if (sortOption === "channel-asc") {
    sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
  } else if (sortOption === "duration-desc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
      const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
      return durationB - durationA;
    });
  } else if (sortOption === "duration-asc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
      const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
      return durationA - durationB;
    });
  }
  return sortedGroups
    .map(([channel, groupVideos]) => {
      const ck = nestedChannelCollapseKey(collapseScopeId, channel);
      const isCollapsed = collapsedGroups.has(ck);
      const groupDuration = groupVideos.reduce((acc, video) => acc + video.seconds, 0);
      const sortedGroupVideos = sortVideos(groupVideos);
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
                    <div class="relative flex items-center justify-center w-4 h-4 cursor-pointer nested-group-selection-toggle" data-nested-group-scope="${escapeHtml(collapseScopeId)}" data-nested-channel="${escapeHtml(channel)}">
                      <input type="checkbox" class="peer appearance-none w-3.5 h-3.5 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${allSelected ? "checked" : ""} ${someSelected ? "indeterminate" : ""}>
                       <svg class="absolute w-2 h-2 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                       <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 ${someSelected && !allSelected ? "opacity-100" : ""}">
                          <div class="w-2 h-0.5 bg-accent"></div>
                       </div>
                    </div>
                    <div class="flex-1 font-medium text-xs text-text-secondary truncate nested-group-toggle cursor-pointer" data-nested-group="${escapeHtml(ck)}">${escapeHtml(channel)}</div>
                    <div class="text-[10px] text-text-muted font-mono flex items-center gap-2">
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
      <div class="mb-8" data-section-wrapper="${escapeHtml(section.id)}">
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
      subtitle: "Videos not assigned to a section yet",
      collapseKey: ck,
      countLabel: `${unsorted.length} videos`,
      durationLabel: formatTime(dur),
      colorIndex: "unsorted",
    });
    const collapsed = collapsedGroups.has(ck);
    const body =
      unsorted.length === 0 ? "" : renderSessionTabsInnerHtml(unsorted, "unsorted", "__unsorted");
    parts.push(`
      <div class="mb-8" data-section-wrapper="__unsorted">
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
    (el) => el.getAttribute("data-flat-group-body") === channel
  ) as HTMLElement | null;
  if (body) body.classList.toggle("hidden", collapsed);
  tabList.querySelectorAll(".group-toggle").forEach((el) => {
    const h = el as HTMLElement;
    if (h.dataset.group === channel) {
      h.classList.toggle("-rotate-90", collapsed);
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
      <div class="mb-8" data-section-wrapper="${escapeHtml(section.id)}">
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
      subtitle: "Videos not assigned to a section yet",
      collapseKey: ck,
      countLabel: `${unsorted.length} videos`,
      durationLabel: formatTime(dur),
      colorIndex: "unsorted",
    });
    const collapsed = collapsedGroups.has(ck);
    const body = unsorted.length === 0 ? "" : renderLiveVideosInnerHtml(unsorted, "unsorted", "__unsorted");
    parts.push(`
      <div class="mb-8" data-section-wrapper="__unsorted">
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
    okBtn.classList.remove("bg-accent", "hover:opacity-90", "bg-red-600", "hover:bg-red-700", "text-white");
    okBtn.classList.add("text-white");
    if (options.confirmDanger) {
      okBtn.classList.add("bg-red-600", "hover:bg-red-700");
    } else {
      okBtn.classList.add("bg-accent", "hover:opacity-90");
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

async function saveSettings() {
  const storage = await loadStorage();
  await saveStorageUtil(
    allVideos,
    storage.sortByDuration,
    thumbnailQuality,
    layoutMode,
    groupingMode,
    sortOption
  );
  lastStorageLoadTime = 0;
}

function renderSidebar() {
  const container = document.getElementById("window-list-windows");
  if (!container) return;

  const totalDuration = allVideos.reduce((acc, video) => acc + video.seconds, 0);
  const totalTabs = allVideos.length;

  const fp = [
    String(currentWindowId),
    String(totalTabs),
    String(totalDuration),
    windowGroups.map((g) => `${g.id}:${g.label}:${g.duration}:${g.tabs.length}`).join("|"),
  ].join("\x1f");

  if (fp === lastSidebarFingerprint) return;
  lastSidebarFingerprint = fp;

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
      (savedSession) => {
        const active = isSelected(savedSession.id);
        return `
    <button type="button" class="sidebar-item sidebar-item-session w-full text-left px-3 py-2 rounded-md mb-1 flex items-center gap-2 transition-colors ${active ? "bg-surface-hover text-text-primary" : "text-text-muted hover:bg-surface-hover/50 hover:text-text-secondary"}" data-sidebar-type="session" data-session-id="${savedSession.id}" data-pinned="${savedSession.pinned ? "1" : "0"}">
      ${savedSession.pinned ? `<svg class="shrink-0 w-3 h-3 text-accent" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>` : ""}
      <div class="truncate min-w-0 flex-1">
        <div class="text-xs font-semibold truncate">${escapeHtml(savedSession.name)}</div>
        <div class="text-[10px] font-mono opacity-60">${(savedSession.tabs?.length ?? 0)} tabs</div>
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

let fetchTabsFromEventsTimeout: ReturnType<typeof setTimeout> | null = null;
const FETCH_TABS_DEBOUNCE_MS = 400;

function scheduleFetchTabsFromEvents() {
  if (fetchTabsFromEventsTimeout != null) clearTimeout(fetchTabsFromEventsTimeout);
  fetchTabsFromEventsTimeout = setTimeout(() => {
    fetchTabsFromEventsTimeout = null;
    if (Date.now() - lastVisibilityFetch < VISIBILITY_REFETCH_MS) return;
    fetchTabs();
  }, FETCH_TABS_DEBOUNCE_MS);
}

function fingerprintSessionTabsInner(tabs: SavedSessionTab[], collapseScopeId: string): string {
  if (tabs.length === 0) return "";
  if (groupingMode !== "channel") {
    return sortSessionTabs(tabs)
      .map((tab) => `${tab.url}|${tab.title}|${tab.channelName}|${tab.seconds}|${tab.sectionId ?? ""}`)
      .join(";");
  }
  const channels = new Map<string, SavedSessionTab[]>();
  tabs.forEach((tab) => {
    const name = tab.channelName ?? "Unknown Channel";
    if (!channels.has(name)) channels.set(name, []);
    channels.get(name)!.push(tab);
  });
  let sortedGroups = Array.from(channels.entries());
  if (sortOption === "channel-asc") {
    sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
  } else if (sortOption === "duration-desc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationB - durationA;
    });
  } else if (sortOption === "duration-asc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
      return durationA - durationB;
    });
  }
  return sortedGroups
    .map(([channel, tabList]) => {
      const ck = nestedChannelCollapseKey(collapseScopeId, channel);
      const collapsed = collapsedGroups.has(ck);
      const sortedTabs = sortSessionTabs(tabList);
      const sig = sortedTabs
        .map((tab) => `${tab.url}|${tab.title}|${tab.channelName}|${tab.seconds}|${tab.sectionId ?? ""}`)
        .join(";");
      return `${ck}:${collapsed}:${sig}`;
    })
    .join("||");
}

function fingerprintLiveVideosInner(videos: VideoData[], collapseScopeId: string): string {
  if (videos.length === 0) return "";
  if (groupingMode !== "channel") {
    return sortVideos(videos)
      .map(
        (video) =>
          `${video.id}|${video.url}|${video.title}|${video.channelName}|${video.seconds}|${video.isLive ? 1 : 0}`
      )
      .join(";");
  }
  const channels = new Map<string, VideoData[]>();
  videos.forEach((video) => {
    const name = video.channelName || "Unknown Channel";
    if (!channels.has(name)) channels.set(name, []);
    channels.get(name)!.push(video);
  });
  let sortedGroups = Array.from(channels.entries());
  if (sortOption === "channel-asc") {
    sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
  } else if (sortOption === "duration-desc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
      const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
      return durationB - durationA;
    });
  } else if (sortOption === "duration-asc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
      const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
      return durationA - durationB;
    });
  }
  return sortedGroups
    .map(([channel, groupVideos]) => {
      const ck = nestedChannelCollapseKey(collapseScopeId, channel);
      const collapsed = collapsedGroups.has(ck);
      const sortedGroupVideos = sortVideos(groupVideos);
      const allSelected = groupVideos.every((video) => selectedTabIds.has(video.id));
      const someSelected = !allSelected && groupVideos.some((video) => selectedTabIds.has(video.id));
      const vidSig = sortedGroupVideos
        .map(
          (video) =>
            `${video.id}|${video.url}|${video.title}|${video.channelName}|${video.seconds}|${video.isLive ? 1 : 0}`
        )
        .join(";");
      return `${ck}:${collapsed}:${allSelected}:${someSelected}:${vidSig}`;
    })
    .join("||");
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

function tabListFingerprint(): string {
  if (selectedSession) {
    const session = selectedSession;
    let tabsToShow: SavedSessionTab[] = session.tabs ?? [];
    if (searchQuery) {
      const searchLower = searchQuery.toLowerCase();
      tabsToShow = tabsToShow.filter(
        (tab) =>
          (tab.title ?? "").toLowerCase().includes(searchLower) ||
          (tab.channelName ?? "").toLowerCase().includes(searchLower)
      );
    }
    const state = [
      "session",
      session.id,
      session.name,
      String(tabsToShow.length),
      searchQuery,
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
    if (groupingMode === "channel") {
      const channels = new Map<string, SavedSessionTab[]>();
      tabsToShow.forEach((tab) => {
        const name = tab.channelName ?? "Unknown Channel";
        if (!channels.has(name)) channels.set(name, []);
        channels.get(name)!.push(tab);
      });
      let sortedGroups = Array.from(channels.entries());
      if (sortOption === "channel-asc") {
        sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
      } else if (sortOption === "duration-desc") {
        sortedGroups.sort((a, b) => {
          const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
          const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
          return durationB - durationA;
        });
      } else if (sortOption === "duration-asc") {
        sortedGroups.sort((a, b) => {
          const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
          const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
          return durationA - durationB;
        });
      }
      const groupSig = sortedGroups
        .map(([channel, tabList]) => {
          const collapsed = collapsedGroups.has(channel);
          const sortedTabs = sortSessionTabs(tabList);
          const sig = sortedTabs
            .map((tab) => `${tab.url}|${tab.title}|${tab.channelName}|${tab.seconds}`)
            .join(";");
          return `${channel}:${collapsed}:${sig}`;
        })
        .join("||");
      return `${state}\x1fcg:${groupSig}`;
    }
    const sorted = sortSessionTabs(tabsToShow);
    const vidSig = sorted.map((tab) => `${tab.url}|${tab.title}|${tab.channelName}|${tab.seconds}`).join(";");
    return `${state}\x1fflat:${vidSig}`;
  }

  let videosToShow: VideoData[] = [];
  if (currentWindowId === "all") {
    videosToShow = allVideos;
  } else {
    const group = windowGroups.find((windowGroup) => windowGroup.id === currentWindowId);
    if (group) videosToShow = group.tabs;
    else videosToShow = [];
  }
  if (searchQuery) {
    const searchQueryLower = searchQuery.toLowerCase();
    videosToShow = videosToShow.filter(
      (video) =>
        video.title.toLowerCase().includes(searchQueryLower) ||
        video.channelName.toLowerCase().includes(searchQueryLower)
    );
  }
  const state = [
    "live",
    String(currentWindowId),
    searchQuery,
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
    const sortedVideos = sortVideos(videosToShow);
    const vidSig = sortedVideos
      .map(
        (video) =>
          `${video.id}|${video.url}|${video.title}|${video.channelName}|${video.seconds}|${video.isLive ? 1 : 0}`
      )
      .join(";");
    return `${state}\x1fnone:${layoutMode}:${vidSig}`;
  }
  const channels = new Map<string, VideoData[]>();
  videosToShow.forEach((video) => {
    const name = video.channelName || "Unknown Channel";
    if (!channels.has(name)) channels.set(name, []);
    channels.get(name)!.push(video);
  });
  let sortedGroups = Array.from(channels.entries());
  if (sortOption === "channel-asc") {
    sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
  } else if (sortOption === "duration-desc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
      const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
      return durationB - durationA;
    });
  } else if (sortOption === "duration-asc") {
    sortedGroups.sort((a, b) => {
      const durationA = a[1].reduce((acc, video) => acc + video.seconds, 0);
      const durationB = b[1].reduce((acc, video) => acc + video.seconds, 0);
      return durationA - durationB;
    });
  }
  const groupSig = sortedGroups
    .map(([channel, videos]) => {
      const collapsed = collapsedGroups.has(channel);
      const sortedGroupVideos = sortVideos(videos);
      const allSelected = videos.every((video) => selectedTabIds.has(video.id));
      const someSelected = !allSelected && videos.some((video) => selectedTabIds.has(video.id));
      const vidSig = sortedGroupVideos
        .map(
          (video) =>
            `${video.id}|${video.url}|${video.title}|${video.channelName}|${video.seconds}|${video.isLive ? 1 : 0}`
        )
        .join(";");
      return `${channel}:${collapsed}:${allSelected}:${someSelected}:${vidSig}`;
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
    if (channelEl) channelEl.textContent = video.channelName;

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
      const devVersion = document.getElementById("dev-version");
      if (devVersion) devVersion.textContent = `v${packageJson.version}`;
    } else {
      settingsModal.classList.add("hidden");
      settingsModal.classList.remove("flex", "items-center", "justify-center", "animate-in", "fade-in");
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
      const searchLower = searchQuery.toLowerCase();
      tabsToShow = tabsToShow.filter(
        (tab) =>
          (tab.title ?? "").toLowerCase().includes(searchLower) ||
          (tab.channelName ?? "").toLowerCase().includes(searchLower)
      );
    }
    const totalSec = tabsToShow.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
    headerTitle.innerText = session.name;
    headerStats.innerText = `${tabsToShow.length} videos · ${formatTime(totalSec)} total duration`;

    const fpSession = tabListFingerprint();
    if (fpSession === lastTabListFingerprint) return;

    if (tabsToShow.length === 0 && !usesSectionLayoutForSession(session)) {
      tabListContainerInnerHtmlUpdated = true;
      container.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 opacity-40">
        <div class="text-4xl mb-4">📺</div>
        <div>No videos found</div>
      </div>
    `;
      lastTabListFingerprint = fpSession;
    } else if (usesSectionLayoutForSession(session)) {
      const secs = orderedSections(session.sections);
      const contentHtml = buildSessionSectionedHtml(tabsToShow, secs);
      tabListContainerInnerHtmlUpdated = true;
      container.innerHTML = `<div class="space-y-2 pb-8">${contentHtml}</div>`;
      wireSectionLayoutInteractivity(container);
      thumbnailCacheBackfill(container);
      lastTabListFingerprint = fpSession;
    } else {
      let contentHtml: string;
      if (groupingMode === "channel") {
        const channels = new Map<string, SavedSessionTab[]>();
        tabsToShow.forEach((tab) => {
          const name = tab.channelName ?? "Unknown Channel";
          if (!channels.has(name)) channels.set(name, []);
          channels.get(name)!.push(tab);
        });
        let sortedGroups = Array.from(channels.entries());
        if (sortOption === "channel-asc") {
          sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
        } else if (sortOption === "duration-desc") {
          sortedGroups.sort((a, b) => {
            const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
            const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
            return durationB - durationA;
          });
        } else if (sortOption === "duration-asc") {
          sortedGroups.sort((a, b) => {
            const durationA = a[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
            const durationB = b[1].reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
            return durationA - durationB;
          });
        }
        contentHtml = sortedGroups
          .map(([channel, tabList]) => {
            const isCollapsed = collapsedGroups.has(channel);
            const groupDuration = tabList.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
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
              <div class="space-y-1 ml-12 border-l border-border pl-2 mt-1 ${isCollapsed ? "hidden" : ""}" data-flat-group-body="${escapeHtml(channel)}">
                ${gridOrList}
              </div>
            </div>
          `;
          })
          .join("");
      } else {
        const sorted = sortSessionTabs(tabsToShow);
        contentHtml =
          layoutMode === "grid"
            ? renderSessionGrid(sorted)
            : renderSessionList(sorted);
      }
      tabListContainerInnerHtmlUpdated = true;
      container.innerHTML = `<div class="space-y-4">${contentHtml}</div>`;
      thumbnailCacheBackfill(container);
      lastTabListFingerprint = fpSession;
    }
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

  const fpLive = tabListFingerprint();
  if (fpLive === lastTabListFingerprint) {
    skippedTabListDom = true;
    return;
  }

  if (videosToShow.length === 0 && !usesSectionLayoutForLive()) {
    tabListContainerInnerHtmlUpdated = true;
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full opacity-40">
        <div class="text-4xl mb-4">📺</div>
        <div>No videos found</div>
      </div>
    `;
    lastTabListFingerprint = fpLive;
    return;
  }

  if (usesSectionLayoutForLive()) {
    const secs = orderedSections(liveTabSectionsState.sections);
    const contentHtml = buildLiveSectionedHtml(videosToShow, secs, liveTabSectionsState.assignments);
    tabListContainerInnerHtmlUpdated = true;
    container.innerHTML = `<div class="space-y-2 pb-8">${contentHtml}</div>`;
    wireSectionLayoutInteractivity(container);
    thumbnailCacheBackfill(container);
    lastTabListFingerprint = fpLive;
    return;
  }

  if (groupingMode === 'none') {
    const sortedVideos = sortVideos(videosToShow);
    if (layoutMode === 'grid') {
      tabListContainerInnerHtmlUpdated = true;
      container.innerHTML = renderVideoGrid(sortedVideos);
      thumbnailCacheBackfill(container);
    } else {
      tabListContainerInnerHtmlUpdated = true;
      container.innerHTML = renderVideoList(sortedVideos);
    }
    lastTabListFingerprint = fpLive;
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

    tabListContainerInnerHtmlUpdated = true;
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
                
                <div class="space-y-1 ml-12 border-l border-border pl-2 mt-1 ${isCollapsed ? 'hidden' : ''}" data-flat-group-body="${escapeHtml(channel)}">
                    ${layoutMode === 'grid' ? renderVideoGrid(sortedGroupVideos) : renderVideoList(sortedGroupVideos)}
                </div>
            </div>
          `;
    }).join('');

    thumbnailCacheBackfill(container);
    lastTabListFingerprint = fpLive;
  }
}

function renderVideoList(videos: VideoData[], sectionColorIndex?: number | "unsorted"): string {
  const dnd = tabCardDnDHtml(sectionColorIndex);
  return videos.map(video => {
    const isSelected = selectedTabIds.has(video.id);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;

    return `
      <div class="group relative flex items-center gap-4 p-3 rounded-lg border border-transparent hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? 'bg-surface-hover border-border' : ''}${dnd.extraClass}" data-id="${video.id}"${dnd.draggableAttr}>
        <div class="relative flex items-center justify-center w-5 h-5 cursor-pointer selection-toggle">
          <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${isSelected ? 'checked' : ''}>
          <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>

        <div class="flex-1 min-w-0 cursor-pointer video-click-target pr-16">
           <div class="flex items-baseline gap-2 mb-1">
             <h3 class="manager-card-title text-sm font-medium text-text-primary truncate" title="${video.title}">${video.title}</h3>
             <span class="manager-card-channel text-[10px] text-text-muted truncate uppercase tracking-tight">${video.channelName}</span>
           </div>
           
           <div class="flex items-center gap-3 w-full max-w-md bg-surface-elevated/50 py-1 px-2 rounded-md">
             <div class="text-xs font-mono text-text-secondary whitespace-nowrap">
                <span class="manager-card-time-current ${watchedPercent > 0 ? "text-text-primary" : "text-text-muted"}">${formatCompact(video.currentTime)}</span>
                <span class="mx-0.5 opacity-30">/</span>
                <span class="manager-card-time-total">${formatCompact(video.seconds)}</span>
             </div>
             <div class="flex-1 h-1 bg-surface rounded-full overflow-hidden">
                <div class="manager-card-list-progress h-full bg-accent opacity-80" style="width: ${watchedPercent}%"></div>
             </div>
           </div>
        </div>

        <div class="absolute right-4 opacity-0 group-hover:opacity-100 flex items-center gap-2 transition-opacity bg-surface-elevated/90 backdrop-blur-sm rounded-md p-1 shadow-sm border border-border/50">
           <button type="button" draggable="false" class="p-1.5 text-text-muted hover:bg-accent hover:text-white rounded transition-colors duration-200 jump-btn" title="Go to Tab">
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
           </button>
           <button type="button" draggable="false" class="p-1.5 text-text-muted hover:bg-accent hover:text-white rounded transition-colors duration-200 close-btn" title="Close Tab">
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
      <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? "bg-surface-hover border-border ring-1 ring-accent/50" : ""}${dnd.extraClass}" data-session-tab-url="${urlAttr}"${dnd.draggableAttr}>
        <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden session-video-click-target cursor-pointer">
          ${thumbnailUrl
        ? `<img ${imgAttr} class="manager-card-thumb w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="eager" decoding="async" alt=""${imgDragOff} />`
        : `<div class="w-full h-full flex items-center justify-center text-text-muted/20"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>`
      }
          <div class="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-mono font-medium text-white backdrop-blur-sm">
            ${formatCompact(sec)}
          </div>
          <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
            <div class="w-11 h-11 rounded-full bg-black/45 flex items-center justify-center backdrop-blur-[2px] ring-1 ring-white/20 shadow-md">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" class="shrink-0 -translate-x-px" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
          <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? "opacity-100" : ""} session-selection-toggle flex items-center justify-center w-5 h-5">
            <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" ${isSelected ? "checked" : ""}>
            <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <div class="absolute top-1 right-1 flex gap-1 transform translate-x-2 opacity-0 group-hover:translate-x-0 group-hover:opacity-100 transition-all duration-200">
            <button type="button" draggable="false" class="p-1.5 hover:bg-black/60 bg-black/40 text-white rounded-md backdrop-blur-sm transition-colors session-open-new-tab" title="Open in new tab">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
            </button>
            <button type="button" draggable="false" class="p-1.5 hover:bg-red-500/80 bg-black/40 text-white rounded-md backdrop-blur-sm transition-colors session-remove-btn" title="Remove from session">
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

function renderSessionList(tabs: SavedSessionTab[], sectionColorIndex?: number | "unsorted"): string {
  const dnd = tabCardDnDHtml(sectionColorIndex);
  return tabs.map((tab) => {
    const title = tab.title ?? "Untitled";
    const channel = tab.channelName ?? "";
    const sec = tab.seconds ?? 0;
    const isSelected = selectedSessionTabUrls.has(tab.url);
    const urlAttr = escapeHtml(tab.url);
    return `
      <div class="group relative flex items-center gap-4 p-3 rounded-lg border border-transparent hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? "bg-surface-hover border-border" : ""}${dnd.extraClass}" data-session-tab-url="${urlAttr}"${dnd.draggableAttr}>
        <div class="relative flex items-center justify-center w-5 h-5 shrink-0 cursor-pointer session-selection-toggle">
          <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${isSelected ? "checked" : ""}>
          <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="flex-1 min-w-0 pr-12 session-video-click-target cursor-pointer">
          <div class="flex items-baseline gap-2 mb-1">
            <h3 class="text-sm font-medium text-text-primary truncate" title="${escapeHtml(title)}">${escapeHtml(title)}</h3>
            <span class="text-[10px] text-text-muted truncate uppercase tracking-tight">${escapeHtml(channel)}</span>
          </div>
          <div class="text-xs font-mono text-text-muted">${formatCompact(sec)}</div>
        </div>
        <div class="absolute right-4 flex items-center gap-1">
          <button type="button" draggable="false" class="p-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors session-open-new-tab" title="Open in new tab">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
          </button>
          <button type="button" draggable="false" class="p-1.5 rounded hover:bg-red-500/20 text-text-muted hover:text-red-500 transition-colors session-remove-btn" title="Remove from session">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
          </button>
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
            <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? 'bg-surface-hover border-border ring-1 ring-accent/50' : ''}${dnd.extraClass}" data-id="${video.id}"${dnd.draggableAttr}>
                <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden video-click-target cursor-pointer">
                    ${thumbnailUrl
        ? `<img ${imgAttr} class="manager-card-thumb w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="eager" decoding="async" alt=""${imgDragOff} />`
        : `<div class="w-full h-full flex items-center justify-center text-text-muted/20"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>`
      }
                    
                    <div class="manager-card-duration absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-mono font-medium text-white backdrop-blur-sm">
                        ${video.isLive ? 'LIVE' : formatCompact(video.seconds)}
                    </div>

                    <div class="manager-card-progress-wrap absolute bottom-0 left-0 right-0 h-0.5 bg-surface/30 transition-opacity" style="opacity: ${!video.isLive && video.seconds > 0 && watchedPercent > 0 ? 1 : 0}">
                        <div class="manager-card-progress h-full bg-accent" style="width: ${watchedPercent}%"></div>
                    </div>

                    <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
                        <div class="w-11 h-11 rounded-full bg-black/45 flex items-center justify-center backdrop-blur-[2px] ring-1 ring-white/20 shadow-md">
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="white" class="shrink-0 -translate-x-px" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
                        </div>
                    </div>

                    <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'opacity-100' : ''} selection-toggle flex items-center justify-center w-5 h-5">
                        <input type="checkbox" draggable="false" class="peer appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" ${isSelected ? 'checked' : ''}>
                        <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>

                    <div class="absolute top-1 right-1 flex gap-1 transform translate-x-2 opacity-0 group-hover:translate-x-0 group-hover:opacity-100 transition-all duration-200">
                         <button type="button" draggable="false" class="p-1.5 bg-black/40 hover:bg-accent text-white rounded-md backdrop-blur-sm border border-white/10 hover:border-accent transition-all duration-200 jump-btn" title="Go to Tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
                         </button>
                         <button type="button" draggable="false" class="p-1.5 bg-black/40 hover:bg-accent text-white rounded-md backdrop-blur-sm border border-white/10 hover:border-accent transition-all duration-200 close-btn" title="Close Tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                         </button>
                    </div>
                </div>

                <div class="p-2 video-click-target cursor-pointer">
                    <h3 class="manager-card-title text-xs font-medium text-text-primary line-clamp-2 leading-snug mb-1 min-h-[2.5em]" title="${video.title}">${video.title}</h3>
                    <div class="flex items-center justify-between text-[10px] text-text-muted">
                        <span class="manager-card-channel truncate hover:text-text-secondary transition-colors">${video.channelName}</span>
                    </div>
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

function currentSectionsForMove(): SessionSection[] {
  if (selectedSession) return orderedSections(selectedSession.sections);
  return orderedSections(liveTabSectionsState.sections);
}

function moveToSectionPopoverSig(): string {
  const ctx = selectedSession ? `s:${selectedSession.id}` : "live";
  const sections = currentSectionsForMove();
  if (sections.length === 0) return `${ctx}\x1f0`;
  return `${ctx}\x1f${orderedSections(sections).map((s) => `${s.id}:${s.name}:${s.emoji ?? ""}:${s.colorIndex ?? 0}`).join("|")}`;
}

function updateMoveToSectionPopover(): void {
  const pop = document.getElementById("move-to-section-popover");
  if (!pop) return;
  const sig = moveToSectionPopoverSig();
  if (sig === lastMoveToSectionPopoverSig) return;
  lastMoveToSectionPopoverSig = sig;

  const sections = currentSectionsForMove();
  if (sections.length === 0) {
    pop.innerHTML = `<div class="px-3 py-2 text-[11px] text-text-muted">Create a section first</div>`;
    return;
  }
  const items: string[] = [];
  for (const sec of sections) {
    const rail = sectionRailVar(sec.colorIndex ?? 0);
    items.push(`
      <button type="button" class="move-to-section-item flex items-center gap-2" data-move-section-id="${escapeHtml(sec.id)}" style="--card-rail: ${rail}">
        <span class="w-1.5 h-4 rounded-full shrink-0" style="background: ${rail}"></span>
        <span class="truncate">${sec.emoji ? `${escapeHtml(sec.emoji)} ` : ""}${escapeHtml(sec.name)}</span>
      </button>
    `);
  }
  items.push(`
    <button type="button" class="move-to-section-item text-text-muted mt-1 border-t border-border pt-2 rounded-none" data-move-section-id="">
      ✦ Unsorted
    </button>
  `);
  pop.innerHTML = items.join("");
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

  const inSessionView = selectedSession != null;
  const selectionSize = inSessionView ? selectedSessionTabUrls.size : selectedTabIds.size;
  const hasSections = currentSectionsForMove().length > 0;

  if (selectionSize > 0) {
    bar?.classList.remove("hidden");
    bar?.classList.add("flex");
    if (count) count.innerText = `${selectionSize} selected`;
    if (closeBtn) closeBtn.textContent = inSessionView ? "Remove from session" : "Close Selected";
    if (moveWrap) {
      if (hasSections) {
        moveWrap.classList.remove("hidden");
        updateMoveToSectionPopover();
      } else moveWrap.classList.add("hidden");
    }
  } else {
    bar?.classList.add("hidden");
    bar?.classList.remove("flex");
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
  }
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
      const newTabs = (selectedSession.tabs ?? []).filter((sessionTab) => !urls.includes(sessionTab.url ?? ""));
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

  document.getElementById("window-list")?.addEventListener("click", async (event) => {
    const item = (event.target as HTMLElement).closest(".sidebar-item");
    if (!item) return;
    const type = item.getAttribute("data-sidebar-type");
    if (type === "all") {
      selectedSession = null;
      selectedSessionTabUrls.clear();
      currentWindowId = "all";
      refreshSavedSessionsSidebar();
      render();
    } else if (type === "window") {
      selectedSession = null;
      selectedSessionTabUrls.clear();
      const id = item.getAttribute("data-window-id");
      if (id) {
        currentWindowId = parseInt(id, 10);
        refreshSavedSessionsSidebar();
        render();
      }
    } else if (type === "session") {
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
    menu.querySelectorAll(".sidebar-ctx-item").forEach((item) => {
      (item as HTMLElement).classList.add("hidden");
    });
    if (type === "all" || type === "window") {
      sidebarContextTarget = type === "all" ? { type: "all" } : { type: "window", windowId: parseInt(item.getAttribute("data-window-id") || "0", 10) };
      const saveBtn = document.getElementById("ctx-save");
      if (saveBtn) { saveBtn.classList.remove("hidden"); saveBtn.classList.add("flex"); }
    } else if (type === "session") {
      sidebarContextTarget = { type: "session", sessionId: item.getAttribute("data-session-id") || undefined };
      const openBtn = document.getElementById("ctx-open-tabs");
      const renameBtn = document.getElementById("ctx-rename-session");
      const pinBtn = document.getElementById("ctx-pin");
      const pinLabel = document.getElementById("ctx-pin-label");
      const delBtn = document.getElementById("ctx-delete");
      if (openBtn) { openBtn.classList.remove("hidden"); openBtn.classList.add("flex"); }
      if (renameBtn) { renameBtn.classList.remove("hidden"); renameBtn.classList.add("flex"); }
      if (pinBtn) {
        pinBtn.classList.remove("hidden");
        pinBtn.classList.add("flex");
        const pinned = item.getAttribute("data-pinned") === "1";
        if (pinLabel) pinLabel.textContent = pinned ? "Unpin" : "Pin";
      }
      if (delBtn) { delBtn.classList.remove("hidden"); delBtn.classList.add("flex"); }
    }
    menu.classList.remove("hidden");
    const menuLeftPx = Math.min(event.clientX, window.innerWidth - 180);
    const menuTopPx = Math.min(event.clientY, window.innerHeight - 160);
    menu.style.left = `${menuLeftPx}px`;
    menu.style.top = `${menuTopPx}px`;
  });

  document.getElementById("tab-list")?.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;

    if (target.closest(".section-collapse-toggle")) {
      const btn = target.closest(".section-collapse-toggle") as HTMLElement;
      const key = btn.dataset.sectionCollapse;
      if (key) {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        applySectionCollapseDom(key, collapsedGroups.has(key));
        lastTabListFingerprint = tabListFingerprint();
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
        lastTabListFingerprint = tabListFingerprint();
      }
      return;
    }

    const sessionRow = target.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && selectedSession) {
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (url != null) {
        if (target.closest(".session-remove-btn")) {
          event.stopPropagation();
          const tab = (selectedSession.tabs ?? []).find((sessionTab) => (sessionTab.url ?? "") === url);
          const title = tab?.title ?? "this video";
          const confirmed = await showConfirm({
            title: "Remove from session",
            message: `Remove "${title}" from "${selectedSession.name}"?`,
            confirmLabel: "Remove",
            confirmDanger: true,
          });
          if (!confirmed) return;
          const newTabs = (selectedSession.tabs ?? []).filter((sessionTab) => (sessionTab.url ?? "") !== url);
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
        if (target.closest(".session-open-new-tab")) {
          event.stopPropagation();
          openSessionVideoInNewTab(url);
          return;
        }
        if (target.closest(".session-video-click-target")) {
          event.stopPropagation();
          void openOrFocusSessionVideo(url);
          return;
        }
      }
      return;
    }

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
      setTimeout(fetchTabs, 100);
      return;
    }
    if (target.closest(".video-click-target")) {
      const video = allVideos.find((candidate) => candidate.id === id);
      if (video) await focusLiveVideoTab(video);
      return;
    }
    if (target.closest(".nested-group-selection-toggle")) {
      event.stopPropagation();
      const el = target.closest(".nested-group-selection-toggle") as HTMLElement;
      const scopeId = el.dataset.nestedGroupScope;
      const channel = el.dataset.nestedChannel;
      if (!scopeId || !channel) return;
      if (selectedSession) {
        const secs = orderedSections(selectedSession.sections);
        const inSection = (tab: SavedSessionTab) => {
          if (scopeId === "__unsorted") return !sessionTabSectionId(tab, secs);
          return sessionTabSectionId(tab, secs) === scopeId;
        };
        const groupTabs = (selectedSession.tabs ?? []).filter(
          (t) => inSection(t) && (t.channelName ?? "Unknown Channel") === channel
        );
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
          return inSec && (v.channelName || "Unknown Channel") === channel;
        });
        const allSelected =
          groupVideos.length > 0 && groupVideos.every((v) => selectedTabIds.has(v.id));
        groupVideos.forEach((v) => {
          if (allSelected) selectedTabIds.delete(v.id);
          else selectedTabIds.add(v.id);
        });
      }
      updateSelectionUI();
      render();
      return;
    }
    const groupToggle = target.closest(".group-toggle");
    if (groupToggle) {
      const groupName = (groupToggle as HTMLElement).dataset.group;
      if (groupName) {
        if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
        else collapsedGroups.add(groupName);
        applyFlatChannelGroupCollapseDom(groupName, collapsedGroups.has(groupName));
        lastTabListFingerprint = tabListFingerprint();
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
        const videosInGroup = scopeVideos.filter(
          (video) => (video.channelName || "Unknown Channel") === groupName
        );
        const allSelected = videosInGroup.every((video) => selectedTabIds.has(video.id));
        videosInGroup.forEach((video) => {
          if (allSelected) selectedTabIds.delete(video.id);
          else selectedTabIds.add(video.id);
        });
        updateSelectionUI();
        render();
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
  });

  document.getElementById("tab-list")?.addEventListener("dragend", () => {
    document.querySelectorAll(".tab-card-dragging").forEach((el) => el.classList.remove("tab-card-dragging"));
    clearSectionDropHighlight();
  });

  document.getElementById("tab-list")?.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MANAGER_DRAG_MIME)) return;
    const zone = (e.target as HTMLElement).closest("[data-section-wrapper]");
    setSectionDropHighlight(zone as HTMLElement | null);
    if (zone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  });

  document.getElementById("tab-list")?.addEventListener("drop", async (e) => {
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
    const liveSecs = orderedSections(liveTabSectionsState.sections);
    const valid = validSectionIds(liveSecs);
    const tabs: SavedSessionTab[] = allVideos.map((video) => {
      const key = normalizeYoutubeUrl(video.url);
      const sid = liveTabSectionsState.assignments[key];
      return {
        url: video.url,
        title: video.title,
        channelName: video.channelName,
        seconds: video.seconds,
        sectionId: sid && valid.has(sid) ? sid : undefined,
      };
    });
    const referenced = new Set(
      tabs.map((t) => t.sectionId).filter((x): x is string => typeof x === "string" && x.length > 0)
    );
    const secsToSave = liveSecs.filter((s) => referenced.has(s.id));
    try {
      await saveSession(name, tabs, secsToSave.length > 0 ? secsToSave : undefined);
      await refreshSavedSessionsSidebar();
      showToast(`Saved "${name}" (${tabs.length} tabs)`);
    } catch (err) {
      console.error("Save session failed:", err);
      showToast("Could not save session.");
    }
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
    if (videosToSave.length === 0) {
      showToast("No YouTube tabs to save.");
      return;
    }
    const defaultName = `Session ${new Date().toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
    const name = await showNameSessionModal(defaultName);
    if (name === null) return;
    const liveSecs = orderedSections(liveTabSectionsState.sections);
    const valid = validSectionIds(liveSecs);
    const tabs: SavedSessionTab[] = videosToSave.map((video) => {
      const key = normalizeYoutubeUrl(video.url);
      const sid = liveTabSectionsState.assignments[key];
      return {
        url: video.url,
        title: video.title,
        channelName: video.channelName,
        seconds: video.seconds,
        sectionId: sid && valid.has(sid) ? sid : undefined,
      };
    });
    const referenced = new Set(
      tabs.map((t) => t.sectionId).filter((x): x is string => typeof x === "string" && x.length > 0)
    );
    const secsToSave = liveSecs.filter((s) => referenced.has(s.id));
    try {
      await saveSession(name, tabs, secsToSave.length > 0 ? secsToSave : undefined);
      await refreshSavedSessionsSidebar();
      showToast(`Saved "${name}" (${tabs.length} tabs)`);
    } catch (err) {
      console.error("Save session failed:", err);
      showToast("Could not save session.");
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
    } catch (err) {
      console.error("Rename session failed:", err);
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
      await deleteSession(context.sessionId);
      refreshSavedSessionsSidebar();
    }
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
      items.innerHTML = `<div class="px-3 py-2 text-[11px] text-text-muted leading-relaxed">Add a section with <span class="text-text-secondary font-medium">New section</span> first.</div>`;
    } else {
      const rows = sections.map((sec) => {
        const rail = sectionRailVar(sec.colorIndex ?? 0);
        return `
          <button type="button" class="tab-ctx-section-item" data-ctx-section-id="${escapeHtml(sec.id)}">
            <span class="w-1.5 h-4 rounded-full shrink-0" style="background:${rail}"></span>
            <span class="truncate">${sec.emoji ? `${escapeHtml(sec.emoji)} ` : ""}${escapeHtml(sec.name)}</span>
          </button>`;
      });
      rows.push(
        `<button type="button" class="tab-ctx-section-item text-text-muted border-t border-border/60 mt-1 pt-2 rounded-none" data-ctx-section-id="">✦ Unsorted</button>`
      );
      items.innerHTML = rows.join("");
    }
    menu.classList.remove("hidden");
    menu.style.left = `${Math.min(clientX, window.innerWidth - 240)}px`;
    menu.style.top = `${Math.min(clientY, window.innerHeight - 220)}px`;
  }

  document.getElementById("btn-add-section")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openAddSectionModal();
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

  document.getElementById("move-to-section-popover")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest("[data-move-section-id]") as HTMLElement | null;
    if (!btn) return;
    const raw = btn.getAttribute("data-move-section-id");
    void moveSelectionToSection(raw === "" || raw === null ? null : raw);
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  });

  document.getElementById("move-to-section-wrap")?.addEventListener("click", (e) => e.stopPropagation());

  document.getElementById("tab-section-context-items")?.addEventListener("click", async (e) => {
    const btn = (e.target as HTMLElement).closest("[data-ctx-section-id]") as HTMLElement | null;
    if (!btn || !tabSectionContextTarget) return;
    const raw = btn.getAttribute("data-ctx-section-id");
    const sectionId = raw === "" || raw === null ? null : raw;
    const t = tabSectionContextTarget;
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    tabSectionContextTarget = null;
    if (t.mode === "session") {
      await moveSessionTabsToSection([t.url], sectionId);
    } else {
      await moveLiveVideosToSection([t.tabId], sectionId);
    }
  });

  document.getElementById("section-ctx-rename")?.addEventListener("click", async () => {
    const ctx = sectionHeaderContextTarget;
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    if (!ctx) return;
    const sections = currentSectionsForMove();
    const sec = sections.find((s) => s.id === ctx.sectionId);
    if (!sec) return;
    const name = await showNameSessionModal(sec.name, "Rename section");
    if (name === null) return;
    await renameSectionById(ctx.sectionId, name);
    sectionHeaderContextTarget = null;
  });

  document.getElementById("section-ctx-delete")?.addEventListener("click", async () => {
    const ctx = sectionHeaderContextTarget;
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    if (!ctx) return;
    sectionHeaderContextTarget = null;
    const sections = currentSectionsForMove();
    const sec = sections.find((s) => s.id === ctx.sectionId);
    const confirmed = await showConfirm({
      title: "Delete section",
      message: `Delete “${sec?.name ?? "section"}”? Videos move to Unsorted.`,
      confirmLabel: "Delete",
      confirmDanger: true,
    });
    if (confirmed) await deleteSectionById(ctx.sectionId);
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
      if (menu) {
        menu.classList.remove("hidden");
        menu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
        menu.style.top = `${Math.min(event.clientY, window.innerHeight - 120)}px`;
      }
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
      container.innerHTML = rows.map((row) => `<div class="truncate" title="${row}">${row}</div>`).join("");
    }
  });
}

function render() {
  if (renderTimeout != null) return;
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
  setupListeners();
  refreshSavedSessionsSidebar();
  fetchTabs();

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
    if (message.action === "tab-synced") {
      const video = allVideos.find((candidate) => candidate.id === message.tabId);
      if (video) {
        video.seconds = message.metadata.seconds;
        video.title = message.metadata.title;
        video.channelName = message.metadata.channelName;
        video.isLive = message.metadata.isLive || false;
      }
    }
    if (message.action === "sync-complete") render();
  });
});
