import {
  loadPrefsAndMetadataCache,
  normalizeYoutubeUrl,
  saveSession,
  type CachedMetadata,
  type SavedSessionTab,
  type UserPrefs,
} from "../utils/storage";
import { applyMetadataBatchToCache, normalizeMetadataBatch } from "../utils/store";
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  type DetectedLanguage,
} from "../utils/captionLanguage";
import { resolveVideoLanguage } from "../utils/channelLanguage";
import { getVideoIdFromUrl, isYoutubeWatchOrShortsUrl } from "../utils/format";
import { queryReadingList, removeReadingListItem } from "../utils/readingList";

const BATCH_FLUSH_MS = 80;
let pendingCacheUpdates = new Map<string, { url: string; metadata: Omit<CachedMetadata, "timestamp"> }>();
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<void> = Promise.resolve();

let storePrefs!: UserPrefs;
let storeMetadataCache: Record<string, CachedMetadata> = {};
const storeReady: Promise<void> = loadPrefsAndMetadataCache().then(({ prefs, metadataCache }) => {
  storePrefs = prefs;
  storeMetadataCache = metadataCache;
});

function broadcastStoreUpdate(patch: {
  prefs?: UserPrefs;
  metadataCache?: Record<string, CachedMetadata>;
}): void {
  void browser.runtime
    .sendMessage({ action: "store-updated", ...patch })
    .catch(() => {});
}

async function persistPrefs(): Promise<void> {
  await browser.storage.local.set({ ...storePrefs });
}

async function persistMetadataCache(): Promise<void> {
  await browser.storage.local.set({ metadataCache: storeMetadataCache });
}

function scheduleFlush() {
  if (flushTimeout != null) return;
  flushTimeout = setTimeout(() => {
    flushTimeout = null;
    const batch = new Map(pendingCacheUpdates);
    pendingCacheUpdates.clear();
    flushPromise = flushPromise.then(() => applyBatchCacheUpdates(batch));
  }, BATCH_FLUSH_MS);
}

async function applyBatchCacheUpdates(
  batch: Map<string, { url: string; metadata: Omit<CachedMetadata, "timestamp"> }>
) {
  if (batch.size === 0) return;
  await storeReady;
  const normalized = normalizeMetadataBatch(batch);
  applyMetadataBatchToCache(storeMetadataCache, normalized);
  await persistMetadataCache();
  broadcastStoreUpdate({ metadataCache: storeMetadataCache });
}

async function patchPrefs(updates: Partial<UserPrefs>): Promise<void> {
  await storeReady;
  storePrefs = { ...storePrefs, ...updates };
  await persistPrefs();
  broadcastStoreUpdate({ prefs: storePrefs });
}

async function clearMetadataCacheInStore(): Promise<void> {
  await storeReady;
  storeMetadataCache = {};
  await persistMetadataCache();
  broadcastStoreUpdate({ metadataCache: storeMetadataCache });
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "ping") {
      sendResponse({ status: "ok" });
      return;
    }

    if (message.action === "get-store-state") {
      void storeReady.then(() => {
        sendResponse({ prefs: storePrefs, metadataCache: storeMetadataCache });
      });
      return true;
    }

    if (message.action === "update-prefs" && message.updates) {
      void patchPrefs(message.updates as Partial<UserPrefs>).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.action === "clear-metadata-cache") {
      void clearMetadataCacheInStore().then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.action === "update-cache" && message.url && message.metadata) {
      const normalizedUrl = normalizeYoutubeUrl(message.url);
      pendingCacheUpdates.set(normalizedUrl, {
        url: message.url,
        metadata: message.metadata as Omit<CachedMetadata, "timestamp">,
      });
      scheduleFlush();
      return;
    }

    if (message.action === "sync-all" && message.tabs) {
      void handleStealthSync(message.tabs as TabToSync[]);
      sendResponse({ started: true });
      return true;
    }

    if (message.action === "get-open-tabs-catalog") {
      void getOpenTabsCatalog()
        .then((catalog) => sendResponse({ success: true, catalog }))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "stage-focused-study-queue") {
      void stageFocusedStudyQueue(message.payload as StageQueuePayload, _sender.tab?.id)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "get-reading-list-catalog") {
      void queryReadingList(false)
        .then((items) => sendResponse({ success: true, items }))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "shelve-and-clear-reading-item" && message.url) {
      void removeReadingListItem(message.url as string)
        .then((success) => sendResponse({ success, removedUrl: message.url }))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }
  });
});

interface StageQueuePayload {
  orderedTabIds: number[];
  stashDistractionTabs?: boolean;
  sessionName?: string;
  playbackSpeed?: number;
}

async function getOpenTabsCatalog() {
  await storeReady;
  const tabs = await browser.tabs.query({});
  const videoTabs = tabs.filter(
    (tab) => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url))
  );

  return videoTabs.map((tab) => {
    const rawUrl = tab.url || "";
    const normalizedUrl = normalizeYoutubeUrl(rawUrl);
    const cached = storeMetadataCache[normalizedUrl];
    const durationSeconds = cached?.seconds || 0;
    const currentTimeSeconds = cached?.currentTime || 0;
    const remainingSeconds = Math.max(0, durationSeconds - currentTimeSeconds);

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      videoId: cached?.videoId ?? getVideoIdFromUrl(rawUrl),
      title: cached?.title || tab.title || "YouTube Video",
      channelName: cached?.channelName || "",
      durationSeconds,
      currentTimeSeconds,
      remainingSeconds,
      url: rawUrl,
      isLive: cached?.isLive || false,
      language: cached?.language ?? null,
      languageName: cached?.languageName ?? null,
      active: tab.active ?? false,
    };
  });
}

async function stageFocusedStudyQueue(payload: StageQueuePayload, senderTabId?: number) {
  await storeReady;

  if (!payload || !Array.isArray(payload.orderedTabIds) || payload.orderedTabIds.length === 0) {
    throw new Error("orderedTabIds must be a non-empty array of valid YouTube tab IDs.");
  }

  const hasInvalidType = payload.orderedTabIds.some(
    (tabId) => typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0
  );
  if (hasInvalidType) {
    throw new Error("All entries in orderedTabIds must be positive numeric tab IDs.");
  }

  const allTabs = await browser.tabs.query({});
  const videoTabs = allTabs.filter(
    (tab) => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url))
  );

  const videoTabIdSet = new Set(
    videoTabs.map((tab) => tab.id).filter((tabId): tabId is number => typeof tabId === "number")
  );

  const missingIds = payload.orderedTabIds.filter((tabId) => !videoTabIdSet.has(tabId));
  if (missingIds.length > 0) {
    throw new Error(
      `Invalid tab ID(s): ${missingIds.join(", ")}. Every ID in orderedTabIds must correspond to an open YouTube watch or shorts tab.`
    );
  }

  const orderedTabIds = payload.orderedTabIds;
  const orderedSet = new Set(orderedTabIds);

  let stashedCount = 0;
  if (payload.stashDistractionTabs) {
    const unselectedTabs = videoTabs.filter(
      (tab) => tab.id !== undefined && !orderedSet.has(tab.id)
    );

    if (unselectedTabs.length > 0) {
      const tabsToStash: SavedSessionTab[] = unselectedTabs.map((tab) => {
        const rawUrl = tab.url || "";
        const normalizedUrl = normalizeYoutubeUrl(rawUrl);
        const cached = storeMetadataCache[normalizedUrl];
        return {
          url: normalizedUrl,
          title: cached?.title || tab.title || "YouTube Video",
          channelName: cached?.channelName || "",
          seconds: cached?.seconds || 0,
          language: cached?.language ?? undefined,
          languageName: cached?.languageName ?? undefined,
        };
      });

      const sessionName = payload.sessionName?.trim() || "Stashed Backlog";
      await saveSession(sessionName, tabsToStash);
      stashedCount = tabsToStash.length;

      const tabIdsToRemove = unselectedTabs
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => typeof tabId === "number");

      if (tabIdsToRemove.length > 0) {
        const callerIsTargeted = senderTabId !== undefined && tabIdsToRemove.includes(senderTabId);
        if (callerIsTargeted) {
          setTimeout(() => {
            void browser.tabs.remove(tabIdsToRemove).catch(() => {});
          }, 150);
        } else {
          await browser.tabs.remove(tabIdsToRemove);
        }
      }
    }
  }

  const firstTabId = orderedTabIds[0];
  if (firstTabId !== undefined) {
    await browser.tabs.update(firstTabId, { active: true });

    if (typeof payload.playbackSpeed === "number" && payload.playbackSpeed > 0) {
      try {
        await browser.scripting.executeScript({
          target: { tabId: firstTabId },
          func: (speed: number) => {
            const video = document.querySelector("video");
            if (video) video.playbackRate = speed;
            const moviePlayer = document.getElementById("movie_player") as unknown as {
              setPlaybackRate?: (rate: number) => void;
            };
            if (typeof moviePlayer?.setPlaybackRate === "function") {
              moviePlayer.setPlaybackRate(speed);
            }
          },
          args: [payload.playbackSpeed],
        });
      } catch {
        // Tab scripting may not be permitted if tab is discarded or restricted
      }
    }
  }

  return {
    success: true,
    stashedCount,
    focusedTabId: firstTabId ?? null,
  };
}

interface TabToSync {
  id: number;
  url: string;
}

const CACHE_FRESH_MAX_AGE_MS = 10 * 60 * 1000;
const LANGUAGE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const SYNC_CONCURRENCY = 3;
const SYNC_DELAY_BETWEEN_REQUESTS_MS = 500;
const SYNC_IN_PROGRESS = new Set<string>();

interface ParsedPlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    isLive?: boolean;
    lengthSeconds?: string;
    defaultAudioLanguageCode?: string;
    defaultLanguage?: string;
    shortDescription?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      liveBroadcastDetails?: { endTimestamp?: string };
      defaultLanguage?: string;
      defaultAudioLanguage?: string;
    };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{ kind?: string; languageCode?: string; name?: { simpleText?: string } }>;
    };
  };
}

function parseMetadataFromHtml(html: string): {
  duration: number;
  title: string;
  channel: string;
  isLive: boolean;
  syncedVideoId: string | null;
  detectedLanguage: DetectedLanguage;
  languageText: string;
  uiLanguage: string | null;
} {
  let duration = 0;
  let title = "";
  let channel = "";
  let isLive = false;
  let syncedVideoId: string | null = null;
  let detectedLanguage: DetectedLanguage = { language: null, languageName: null };
  let languageText = "";

  const playerResponseMatch =
    html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
    html.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
  if (playerResponseMatch) {
    try {
      const playerResponse = JSON.parse(playerResponseMatch[1]) as ParsedPlayerResponse;
      const videoDetails = playerResponse.videoDetails;
      if (videoDetails) {
        syncedVideoId = videoDetails.videoId ?? null;
        title = videoDetails.title || "";
        channel = videoDetails.author || "";
        isLive = videoDetails.isLive === true;
        const liveDetails = playerResponse.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
        if (liveDetails && !liveDetails.endTimestamp) isLive = true;
        const lengthSeconds = parseInt(videoDetails.lengthSeconds ?? "", 10) || 0;
        if (lengthSeconds > 0) {
          isLive = false;
          duration = lengthSeconds;
        }
      }

      detectedLanguage = detectLanguageFromPlayerResponse(playerResponse);
      languageText = languageTextFromPlayerResponse(playerResponse);
    } catch (_) {}
  }
  if (duration === 0) {
    const durationMatch = html.match(/"approxDurationMs"\s*:\s*"?(\d+)"?/);
    duration = durationMatch ? parseInt(durationMatch[1], 10) / 1000 : 0;
  }
  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : "";
  }
  if (!channel) {
    const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/) || html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    channel = authorMatch ? authorMatch[1] : "";
  }

  return {
    duration,
    title,
    channel,
    isLive,
    syncedVideoId,
    detectedLanguage,
    languageText,
    uiLanguage: html.match(/<html[^>]*\slang="([^"]+)"/)?.[1] ?? null,
  };
}

async function fetchOneTab(tab: TabToSync): Promise<boolean> {
  const normalizedUrl = normalizeYoutubeUrl(tab.url);
  if (SYNC_IN_PROGRESS.has(normalizedUrl)) return false;
  SYNC_IN_PROGRESS.add(normalizedUrl);
  try {
    const response = await fetch(tab.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (response.url.includes("google.com/sorry") || response.url.includes("youtube.com/sorry")) {
      browser.runtime.sendMessage({ action: "sync-error", message: "Rate limited by YouTube" }).catch(() => {});
      return true;
    }
    const html = await response.text();
    if (html.includes("consent.youtube.com")) return false;
    const {
      duration,
      title,
      channel,
      isLive,
      syncedVideoId,
      detectedLanguage,
      languageText,
      uiLanguage,
    } = parseMetadataFromHtml(html);
    const { language, languageName } = await resolveVideoLanguage(
      detectedLanguage,
      languageText,
      { channelName: channel, videoId: syncedVideoId },
      uiLanguage
    );
    if (duration > 0 || title || isLive) {
      const metadata: Omit<CachedMetadata, "timestamp"> = {
        seconds: duration,
        title: title || "YouTube Video",
        channelName: channel || "",
        currentTime: 0,
        isLive,
        videoId: syncedVideoId ?? undefined,
        language,
        languageName,
      };
      pendingCacheUpdates.set(normalizedUrl, { url: tab.url, metadata });
      scheduleFlush();
      browser.runtime.sendMessage({ action: "tab-synced", tabId: tab.id, metadata }).catch(() => {});
    }
  } catch (error) {
    console.error(`[Background] Error fetching ${tab.url}:`, error);
  } finally {
    SYNC_IN_PROGRESS.delete(normalizedUrl);
  }
  return false;
}

async function handleStealthSync(tabs: TabToSync[]) {
  await storeReady;
  const cache = storeMetadataCache;
  const toFetch: TabToSync[] = [];

  for (const tab of tabs) {
    const normalizedUrl = normalizeYoutubeUrl(tab.url);
    const cached = cache[normalizedUrl];
    const hasValidCoreCache =
      cached && (cached.seconds > 0 || cached.isLive) && cached.title;
    const cacheFresh =
      cached?.timestamp != null && Date.now() - cached.timestamp < CACHE_FRESH_MAX_AGE_MS;
    const languageFresh =
      cached?.language !== undefined &&
      cached.timestamp != null &&
      Date.now() - cached.timestamp < LANGUAGE_CACHE_MAX_AGE_MS;
    if (hasValidCoreCache && cacheFresh && languageFresh) {
      browser.runtime
        .sendMessage({
          action: "tab-synced",
          tabId: tab.id,
          metadata: {
            seconds: cached.seconds ?? 0,
            title: cached.title ?? "",
            channelName: cached.channelName ?? "",
            isLive: cached.isLive ?? false,
            language: cached.language,
            languageName: cached.languageName,
          },
        })
        .catch(() => {});
      continue;
    }
    toFetch.push(tab);
  }

  let rateLimited = false;
  for (let i = 0; i < toFetch.length && !rateLimited; i += SYNC_CONCURRENCY) {
    const chunk = toFetch.slice(i, i + SYNC_CONCURRENCY);
    const results = await Promise.all(chunk.map((tab) => fetchOneTab(tab)));
    if (results.some((result) => result)) rateLimited = true;
    if (i + SYNC_CONCURRENCY < toFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_BETWEEN_REQUESTS_MS));
    }
  }

  browser.runtime.sendMessage({ action: "sync-complete" }).catch(() => {});
}
