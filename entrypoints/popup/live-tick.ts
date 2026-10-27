import { popup } from "./state";
import {
  findVideoByTabId,
  getConfirmedNowPlayingVideos,
  getNowPlayingTabId,
  isTabActivelyPlaying,
  nowPlayingIdsFingerprint,
  refreshNowPlayingDetection,
  syncUpNextIfNowPlayingChanged,
  updateAlsoPlayingLine,
} from "./now-playing";
import { renderNowPlayingCard, updateNowPlayingCard } from "./now-playing-card";
import { getPlaybackState } from "./playback";
import { NOW_PLAYING_DETECT_MS, refreshQueueStatsFromState } from "./render";
import { updateVideoListCardsFromState } from "./video-list";
import { applyPlaybackTimeToVideo, persistVideoPlaybackToCache } from "./videos";

const LIVE_TICK_MS = 1000;

let liveTickInterval: ReturnType<typeof setInterval> | null = null;
let liveTickInFlight = false;

export function startLiveTick(): void {
  if (liveTickInterval != null) return;
  liveTickInterval = setInterval(() => void livePlaybackTick(), LIVE_TICK_MS);
}

export function stopLiveTick(): void {
  const primaryId = getNowPlayingTabId();
  const primary = primaryId ? findVideoByTabId(primaryId) : undefined;
  if (primary && primary.seconds > 0 && !primary.isLive) {
    persistVideoPlaybackToCache(primary);
  }

  if (liveTickInterval != null) {
    clearInterval(liveTickInterval);
    liveTickInterval = null;
  }
  if (popup.nowPlayingRefineTimeout != null) {
    clearTimeout(popup.nowPlayingRefineTimeout);
    popup.nowPlayingRefineTimeout = null;
  }
  liveTickInFlight = false;
}

export async function livePlaybackTick(): Promise<void> {
  if (liveTickInFlight) return;
  if (popup.currentView !== "dashboard" || !document.getElementById("stat-remaining")) return;

  liveTickInFlight = true;
  try {
    const primaryId = getNowPlayingTabId();
    const primary = primaryId ? findVideoByTabId(primaryId) : undefined;

    if (primary) {
      const card = document.getElementById("np-card");
      const playback = await getPlaybackState(primary.id);
      if (card && playback) {
        primary.paused = playback.paused;
        primary.volume = playback.volume;
        primary.muted = playback.muted;
        applyPlaybackTimeToVideo(primary, playback.currentTime);
        updateNowPlayingCard(card, primary, playback, isTabActivelyPlaying(primary));
      }
    }

    refreshQueueStatsFromState();
    updateVideoListCardsFromState();

    const now = Date.now();
    if (now - popup.lastNowPlayingDetectAt < NOW_PLAYING_DETECT_MS) return;
    popup.lastNowPlayingDetectAt = now;

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
          nextPrimary.volume = playback.volume;
          nextPrimary.muted = playback.muted;
          applyPlaybackTimeToVideo(nextPrimary, playback.currentTime);
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
