import { normalizeYoutubeUrl, type CachedMetadata, type VideoChapter } from "../../utils/storage";
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  type DetectedLanguage,
} from "../../utils/captionLanguage";
import { extractChaptersFromPlayerResponse } from "../../utils/chapters";
import { resolveVideoLanguage } from "../../utils/channelLanguage";
import { avatarFromWatchHtml, recordChannelAvatar } from "../../utils/channelAvatars";
import { pendingCacheUpdates, scheduleFlush, storeMetadataCache, storeReady } from "./store";

export interface TabToSync {
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
  chapters: VideoChapter[];
} {
  let duration = 0;
  let title = "";
  let channel = "";
  let isLive = false;
  let syncedVideoId: string | null = null;
  let detectedLanguage: DetectedLanguage = { language: null, languageName: null };
  let languageText = "";
  let chapters: VideoChapter[] = [];

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
      chapters = extractChaptersFromPlayerResponse(playerResponse, isLive ? 0 : duration);
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
    chapters,
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
      chapters,
    } = parseMetadataFromHtml(html);
    const { language, languageName } = await resolveVideoLanguage(
      detectedLanguage,
      languageText,
      { channelName: channel, videoId: syncedVideoId },
      uiLanguage
    );
    const avatar = channel ? avatarFromWatchHtml(html) : null;
    if (avatar) void recordChannelAvatar(channel, avatar);
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
        chapters: chapters.length > 0 ? chapters : undefined,
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

export async function handleStealthSync(tabs: TabToSync[]) {
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
