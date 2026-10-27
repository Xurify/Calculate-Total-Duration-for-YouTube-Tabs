import { VideoData } from "../../utils/storage";
import { getVideoIdFromUrl } from "../../utils/format";
import { popup } from "./state";
import { refineNowPlaying } from "./now-playing-card";
import { getPlaybackState } from "./playback";
import { NOW_PLAYING_REFINE_DEBOUNCE_MS } from "./render";
import { LAST_PLAYING_SESSION_KEY } from "./state";
import { resetVideoListFingerprint, updateVideoList } from "./video-list";
import { applyPlaybackTimeToVideo, getSortedVideos, getVideosInPopupWindow } from "./videos";

export async function loadLastPlayingTabId(windowId: number): Promise<number | null> {
  try {
    const data = await browser.storage.session.get(LAST_PLAYING_SESSION_KEY);
    const map = (data[LAST_PLAYING_SESSION_KEY] as Record<string, number>) ?? {};
    const tabId = map[String(windowId)];
    return typeof tabId === "number" && tabId > 0 ? tabId : null;
  } catch {
    return null;
  }
}

export async function persistLastPlayingTabId(tabId: number): Promise<void> {
  popup.lastPlayingTabId = tabId;
  if (popup.popupWindowId == null) return;
  try {
    const data = await browser.storage.session.get(LAST_PLAYING_SESSION_KEY);
    const map = { ...((data[LAST_PLAYING_SESSION_KEY] as Record<string, number>) ?? {}) };
    map[String(popup.popupWindowId)] = tabId;
    await browser.storage.session.set({ [LAST_PLAYING_SESSION_KEY]: map });
  } catch {
    // Session storage may be unavailable in some contexts
  }
}

export async function clearLastPlayingTabId(): Promise<void> {
  popup.lastPlayingTabId = null;
  if (popup.popupWindowId == null) return;
  try {
    const data = await browser.storage.session.get(LAST_PLAYING_SESSION_KEY);
    const map = { ...((data[LAST_PLAYING_SESSION_KEY] as Record<string, number>) ?? {}) };
    delete map[String(popup.popupWindowId)];
    await browser.storage.session.set({ [LAST_PLAYING_SESSION_KEY]: map });
  } catch {
    // ignore
  }
}

export function isVideoEligibleForNowPlaying(video: VideoData | undefined): video is VideoData {
  if (!video || video.excluded || video.suspended) return false;
  if (popup.popupWindowId != null && video.windowId !== popup.popupWindowId) return false;
  return true;
}

function getNowPlayingTabIds(): Set<number> {
  return new Set(popup.resolvedNowPlayingTabIds);
}

export function isTabActivelyPlaying(video: VideoData): boolean {
  return popup.resolvedNowPlayingTabIds.includes(video.id);
}

export function nowPlayingIdsFingerprint(): string {
  return popup.resolvedNowPlayingTabIds.join(",");
}

function sortNowPlayingCandidates(videos: VideoData[]): VideoData[] {
  return [...videos].sort((a, b) => b.currentTime - a.currentTime);
}

export function getPrimaryNowPlayingSync(): VideoData | null {
  if (popup.resolvedNowPlayingTabIds.length > 0) {
    for (const id of popup.resolvedNowPlayingTabIds) {
      const video = findVideoByTabId(id);
      if (isVideoEligibleForNowPlaying(video)) return video;
    }
  }

  const audible = sortNowPlayingCandidates(getVideosInPopupWindow().filter((video) => video.audible));
  if (audible.length > 0) return audible[0] ?? null;

  if (popup.pinnedNowPlayingTabId) {
    const pinned = findVideoByTabId(popup.pinnedNowPlayingTabId);
    if (isVideoEligibleForNowPlaying(pinned)) return pinned;
  }

  if (popup.lastPlayingTabId) {
    const last = findVideoByTabId(popup.lastPlayingTabId);
    if (isVideoEligibleForNowPlaying(last)) return last;
  }

  return getVideosInPopupWindow().find((video) => video.active) ?? null;
}

export function getVideosForUpNext(): VideoData[] {
  const playingIds = getNowPlayingTabIds();
  return getSortedVideos().filter((video) => !playingIds.has(video.id));
}

export function getNowPlayingTabId(): number | null {
  const section = document.getElementById("now-playing");
  const tabId = section?.dataset.tabId ? parseInt(section.dataset.tabId, 10) : 0;
  if (tabId) {
    const pinned = popup.videoData.find((video) => video.id === tabId);
    if (pinned && !pinned.excluded && !pinned.suspended) return tabId;
  }
  return getPrimaryNowPlayingSync()?.id ?? null;
}

export function findVideoByTabId(tabId: number): VideoData | undefined {
  return popup.videoData.find((video) => video.id === tabId);
}

export interface PlaybackState {
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
  if (popup.popupWindowId == null) return;
  const tabs = await browser.tabs.query({ windowId: popup.popupWindowId });
  const flags = new Map<number, boolean>();
  for (const tab of tabs) {
    if (tab.id != null) flags.set(tab.id, tab.audible === true);
  }
  for (const video of popup.videoData) {
    if (video.windowId === popup.popupWindowId) {
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
    popup.resolvedNowPlayingTabIds = [];
    popup.pinnedNowPlayingTabId = null;
    return [];
  }

  const probeIds = new Set<number>();
  for (const video of inWindow) {
    if (video.audible) probeIds.add(video.id);
  }
  if (popup.lastPlayingTabId) probeIds.add(popup.lastPlayingTabId);
  if (popup.pinnedNowPlayingTabId) probeIds.add(popup.pinnedNowPlayingTabId);
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
    popup.resolvedNowPlayingTabIds = sorted.map((video) => video.id);
    popup.pinnedNowPlayingTabId = null;
    const primary = sorted[0];
    if (primary) await persistLastPlayingTabId(primary.id);
    return sorted;
  }

  popup.resolvedNowPlayingTabIds = [];

  if (popup.lastPlayingTabId) {
    const last = findVideoByTabId(popup.lastPlayingTabId);
    if (isVideoEligibleForNowPlaying(last)) {
      await applyPlaybackStateToVideo(last);
      popup.pinnedNowPlayingTabId = last.id;
      return [last];
    }
    await clearLastPlayingTabId();
  }

  if (active) {
    await applyPlaybackStateToVideo(active);
    popup.pinnedNowPlayingTabId = active.id;
    return [active];
  }

  popup.pinnedNowPlayingTabId = null;
  return [];
}

export async function refreshNowPlayingDetection(): Promise<VideoData[]> {
  if (popup.nowPlayingDetectPromise) return popup.nowPlayingDetectPromise;
  popup.nowPlayingDetectPromise = refreshNowPlayingDetectionInner().finally(() => {
    popup.nowPlayingDetectPromise = null;
  });
  return popup.nowPlayingDetectPromise;
}

export function scheduleNowPlayingRefine(): void {
  if (popup.nowPlayingRefineTimeout != null) clearTimeout(popup.nowPlayingRefineTimeout);
  popup.nowPlayingRefineTimeout = setTimeout(() => {
    popup.nowPlayingRefineTimeout = null;
    void refineNowPlaying();
  }, NOW_PLAYING_REFINE_DEBOUNCE_MS);
}

export function applyLocalPlaybackControl(tabId: number, video: VideoData, state: PlaybackState): boolean {
  video.paused = state.paused;
  video.volume = state.volume;
  video.muted = state.muted;
  applyPlaybackTimeToVideo(video, state.currentTime);
  const activelyPlaying = isPlaybackActive(state);
  if (activelyPlaying) {
    if (!popup.resolvedNowPlayingTabIds.includes(tabId)) {
      popup.resolvedNowPlayingTabIds = sortNowPlayingCandidates([
        video,
        ...popup.resolvedNowPlayingTabIds
          .map((id) => findVideoByTabId(id))
          .filter(isVideoEligibleForNowPlaying),
      ]).map((entry) => entry.id);
    }
    popup.pinnedNowPlayingTabId = null;
  } else {
    popup.resolvedNowPlayingTabIds = popup.resolvedNowPlayingTabIds.filter((id) => id !== tabId);
    popup.pinnedNowPlayingTabId = tabId;
  }
  return activelyPlaying;
}

export function syncUpNextIfNowPlayingChanged(previousIds: string): void {
  if (nowPlayingIdsFingerprint() === previousIds) return;
  resetVideoListFingerprint();
  updateVideoList(getVideosForUpNext());
}

export function updateAlsoPlayingLine(confirmedPlaying: VideoData[], primary: VideoData): void {
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

export function getConfirmedNowPlayingVideos(): VideoData[] {
  return popup.resolvedNowPlayingTabIds
    .map((id) => findVideoByTabId(id))
    .filter(isVideoEligibleForNowPlaying);
}

export function getThumbnailUrl(url: string): string | null {
  const id = getVideoIdFromUrl(url);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null;
}
