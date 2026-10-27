import {
  VideoData,
  CachedMetadata,
  lookupCachedMetadata,
  saveStorage as saveStorageUtil,
  requestMetadataUpdate,
  normalizeYoutubeUrl,
} from "../../utils/storage";
import { applyStorePatch, type StoreUpdatedMessage } from "../../utils/store";
import { parseTimeParam, getVideoIdFromUrl } from "../../utils/format";
import { popup } from "./state";
import { scheduleProbeRender } from "./render";

function applyStoreToVideos(): void {
  const { prefs, metadataCache } = popup.storeState;
  popup.sortByDuration = prefs.sortByDuration;
  popup.videoData.forEach((video) => {
    video.excluded = prefs.excludedUrls.includes(normalizeYoutubeUrl(video.url));
    const cached = lookupCachedMetadata(metadataCache, video.url);
    if (cached) applyCachedDurableMetadataToVideo(video, cached);
  });
}

export function handleStoreUpdated(message: StoreUpdatedMessage): void {
  applyStorePatch(popup.storeState, message);
  if (popup.videoData.length > 0) {
    applyStoreToVideos();
    scheduleProbeRender();
  }
}

/** Persist prefs in background — UI already updated in memory. */
export function saveStorage(): void {
  void saveStorageUtil(popup.videoData, popup.sortByDuration).catch((error) => {
    console.warn("Failed to save prefs:", error);
  });
}

function titleFromTab(tab: Browser.tabs.Tab): string {
  const raw = tab.title?.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();
  return raw && raw !== "YouTube" ? raw : "YouTube Video";
}

export function persistVideoPlaybackToCache(video: VideoData): void {
  void requestMetadataUpdate(video.url, buildMetadataForCache(video));
}

export function buildMetadataForCache(
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

export function applyProbedMetadataToVideo(
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

export function getEffectiveWatchedSeconds(video: VideoData): number {
  if (video.isLive || video.excluded) return 0;
  if (video.seconds <= 0) return 0;
  return Math.min(video.currentTime, video.seconds);
}

export function getWatchedPercent(video: VideoData): number {
  if (video.isLive || video.seconds <= 0) return 0;
  return Math.min(100, Math.max(0, (video.currentTime / video.seconds) * 100));
}

export function getQueueVideos(): VideoData[] {
  return popup.videoData.filter((video) => !video.excluded && !video.isLive);
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

export function applyPlaybackTimeToVideo(video: VideoData, currentTime: number): void {
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

export function applyCachedMetadataToVideo(video: VideoData, cached: CachedMetadata): void {
  applyCachedDurableMetadataToVideo(video, cached);
  applyCachedPlaybackToVideo(video, cached);
}

export function buildVideoFromTab(
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

export function getSortedVideos(): VideoData[] {
  return [...popup.videoData].sort((a, b) => {
    if (popup.sortByDuration) return b.seconds - a.seconds;
    return a.index - b.index;
  });
}

export function getVideosInPopupWindow(): VideoData[] {
  const included = popup.videoData.filter((video) => !video.excluded && !video.suspended);
  if (popup.popupWindowId == null) return included;
  return included.filter((video) => video.windowId === popup.popupWindowId);
}
