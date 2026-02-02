import { normalizeYoutubeUrl } from "../utils/storage";

let cacheUpdateQueue: Promise<void> = Promise.resolve();

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ping") {
      sendResponse({ status: "ok" });
      return;
    }

    if (message.action === "update-cache" && message.url && message.metadata) {
      handleCacheUpdateRequest(message.url, message.metadata);
      return;
    }

    // On-demand only: fetch durations for given tabs (e.g. suspended tabs). Called from "Refresh durations" button.
    if (message.action === "sync-all" && message.tabs) {
      handleStealthSync(message.tabs);
      sendResponse({ started: true });
      return true;
    }
  });
});

async function handleCacheUpdateRequest(url: string, metadata: any) {
  // Use a simple queue to prevent race conditions during parallel storage writes
  cacheUpdateQueue = cacheUpdateQueue.then(async () => {
    const normalizedUrl = normalizeYoutubeUrl(url);
    const data = await browser.storage.local.get("metadataCache");
    const cache = (data.metadataCache as Record<string, any>) || {};
    const existing = cache[normalizedUrl];

    // MERGE LOGIC: Prevent overwriting good metadata with bad data
    // Only update if duration > 0 or if the existing data is very old or missing
    const shouldUpdateDuration = metadata.seconds > 0 || !existing || metadata.isLive;
    
    cache[normalizedUrl] = {
      ...(existing || {}),
      ...metadata,
      // If we are trying to set seconds to 0 but we already have a value, keep the old value unless it's a live stream
      seconds: shouldUpdateDuration ? metadata.seconds : existing.seconds,
      timestamp: Date.now(),
    };

    // Keep cache size reasonable
    const keys = Object.keys(cache);
    if (keys.length > 300) {
      const sortedKeys = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
      delete cache[sortedKeys[0]];
    }

    await browser.storage.local.set({ metadataCache: cache });
  });
}

interface TabToSync {
  id: number;
  url: string;
}

const CACHE_FRESH_MAX_AGE_MS = 10 * 60 * 1000; // 10 min — skip fetch if cache is this fresh
const SYNC_IN_PROGRESS = new Set<string>();

async function handleStealthSync(tabs: TabToSync[]) {
  const data = await browser.storage.local.get("metadataCache");
  const cache = (data.metadataCache as Record<string, { seconds?: number; title?: string; channelName?: string; isLive?: boolean; timestamp?: number }>) || {};

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
    if (SYNC_IN_PROGRESS.has(normalizedUrl)) continue;

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
        break;
      }

      const html = await response.text();
      if (html.includes("consent.youtube.com")) continue;

      const playerResponseMatch =
        html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
        html.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);

      let duration = 0;
      let title = "";
      let channel = "";
      let isLive = false;

      if (playerResponseMatch) {
        try {
          const playerResponse = JSON.parse(playerResponseMatch[1]);
          const videoDetails = playerResponse.videoDetails;
          if (videoDetails) {
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

      if (duration > 0 || title || isLive) {
        const metadata = {
          seconds: duration,
          title: title || "YouTube Video",
          channelName: channel || "",
          isLive,
        };
        await handleCacheUpdateRequest(tab.url, metadata);
        browser.runtime.sendMessage({ action: "tab-synced", tabId: tab.id, metadata }).catch(() => {});
      }

      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[Background] Error fetching ${tab.url}:`, err);
    } finally {
      SYNC_IN_PROGRESS.delete(normalizedUrl);
    }
  }

  browser.runtime.sendMessage({ action: "sync-complete" }).catch(() => {});
}
