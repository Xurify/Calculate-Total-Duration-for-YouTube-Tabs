import { normalizeYoutubeUrl } from "../utils/storage";
import { getVideoIdFromUrl } from "../utils/format";

const BATCH_FLUSH_MS = 80;
let pendingCacheUpdates = new Map<string, { url: string; metadata: any }>();
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<void> = Promise.resolve();

function scheduleFlush() {
  if (flushTimeout != null) return;
  flushTimeout = setTimeout(() => {
    flushTimeout = null;
    const batch = new Map(pendingCacheUpdates);
    pendingCacheUpdates.clear();
    flushPromise = flushPromise.then(() => applyBatchCacheUpdates(batch));
  }, BATCH_FLUSH_MS);
}

async function applyBatchCacheUpdates(batch: Map<string, { url: string; metadata: any }>) {
  if (batch.size === 0) return;
  const data = await browser.storage.local.get("metadataCache");
  const cache = (data.metadataCache as Record<string, any>) || {};
  for (const [normalizedUrl, { url, metadata }] of batch) {
    const existing = cache[normalizedUrl];
    const shouldUpdateDuration = metadata.seconds > 0 || !existing || metadata.isLive;
    const isPlaceholderTitle = !metadata.title || metadata.title === "YouTube Video" || metadata.title === "YouTube";
    const shouldUpdateTitle = !isPlaceholderTitle || !existing?.title || existing.title === "YouTube Video" || existing.title === "YouTube";
    const videoId = metadata.videoId ?? getVideoIdFromUrl(url) ?? undefined;
    cache[normalizedUrl] = {
      ...(existing || {}),
      ...metadata,
      videoId: videoId ?? existing?.videoId,
      seconds: shouldUpdateDuration ? metadata.seconds : existing?.seconds,
      title: shouldUpdateTitle ? metadata.title : existing?.title,
      timestamp: Date.now(),
    };
  }
  const keys = Object.keys(cache);
  if (keys.length > 300) {
    const sortedKeys = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
    const toRemove = sortedKeys.slice(0, keys.length - 300);
    toRemove.forEach((k) => delete cache[k]);
  }
  await browser.storage.local.set({ metadataCache: cache });
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ping") {
      sendResponse({ status: "ok" });
      return;
    }

    if (message.action === "update-cache" && message.url && message.metadata) {
      const normalizedUrl = normalizeYoutubeUrl(message.url);
      pendingCacheUpdates.set(normalizedUrl, { url: message.url, metadata: message.metadata });
      scheduleFlush();
      return;
    }

    if (message.action === "sync-all" && message.tabs) {
      handleStealthSync(message.tabs);
      sendResponse({ started: true });
      return true;
    }
  });
});

interface TabToSync {
  id: number;
  url: string;
}

const CACHE_FRESH_MAX_AGE_MS = 10 * 60 * 1000; // 10 min — skip fetch if cache is this fresh
const SYNC_CONCURRENCY = 3;
const SYNC_DELAY_BETWEEN_REQUESTS_MS = 500;
const SYNC_IN_PROGRESS = new Set<string>();

function parseMetadataFromHtml(html: string): { duration: number; title: string; channel: string; isLive: boolean; syncedVideoId: string | null } {
  let duration = 0;
  let title = "";
  let channel = "";
  let isLive = false;
  let syncedVideoId: string | null = null;
  const playerResponseMatch =
    html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
    html.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
  if (playerResponseMatch) {
    try {
      const playerResponse = JSON.parse(playerResponseMatch[1]);
      const videoDetails = playerResponse.videoDetails;
      if (videoDetails) {
        syncedVideoId = videoDetails.videoId ?? null;
        title = videoDetails.title || "";
        channel = videoDetails.author || "";
        isLive = videoDetails.isLive === true;
        const liveDetails = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
        if (liveDetails && !liveDetails.endTimestamp) isLive = true;
        const lengthSeconds = parseInt(videoDetails.lengthSeconds) || 0;
        if (lengthSeconds > 0) {
          isLive = false;
          duration = lengthSeconds;
        }
      }
    } catch (_) {}
  }
  if (duration === 0) {
    const durationMatch = html.match(/"approxDurationMs"\s*:\s*"?(\d+)"?/);
    duration = durationMatch ? parseInt(durationMatch[1]) / 1000 : 0;
  }
  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : "";
  }
  if (!channel) {
    const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/) || html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    channel = authorMatch ? authorMatch[1] : "";
  }
  return { duration, title, channel, isLive, syncedVideoId };
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
    const { duration, title, channel, isLive, syncedVideoId } = parseMetadataFromHtml(html);
    if (duration > 0 || title || isLive) {
      const metadata = {
        seconds: duration,
        title: title || "YouTube Video",
        channelName: channel || "",
        isLive,
        videoId: syncedVideoId ?? undefined,
      };
      pendingCacheUpdates.set(normalizedUrl, { url: tab.url, metadata });
      scheduleFlush();
      browser.runtime.sendMessage({ action: "tab-synced", tabId: tab.id, metadata }).catch(() => {});
    }
  } catch (err) {
    console.error(`[Background] Error fetching ${tab.url}:`, err);
  } finally {
    SYNC_IN_PROGRESS.delete(normalizedUrl);
  }
  return false;
}

async function handleStealthSync(tabs: TabToSync[]) {
  const data = await browser.storage.local.get("metadataCache");
  const cache = (data.metadataCache as Record<string, { seconds?: number; title?: string; channelName?: string; isLive?: boolean; timestamp?: number }>) || {};
  const toFetch: TabToSync[] = [];

  for (const tab of tabs) {
    const normalizedUrl = normalizeYoutubeUrl(tab.url);
    const cached = cache[normalizedUrl];
    const hasValidCache = cached && (cached.seconds! > 0 || cached.isLive) && cached.title;
    const cacheFresh = cached?.timestamp != null && Date.now() - cached.timestamp < CACHE_FRESH_MAX_AGE_MS;
    if (hasValidCache && cacheFresh) {
      browser.runtime.sendMessage({
        action: "tab-synced",
        tabId: tab.id,
        metadata: {
          seconds: cached.seconds ?? 0,
          title: cached.title ?? "",
          channelName: cached.channelName ?? "",
          isLive: cached.isLive ?? false,
        },
      }).catch(() => {});
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
