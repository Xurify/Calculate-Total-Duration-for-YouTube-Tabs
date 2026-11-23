import { VideoData } from "../../utils/storage";
import { popup } from "./state";
import { updateHeaderStats } from "./header";
import { startLiveTick, stopLiveTick } from "./live-tick";
import { getVideosForUpNext, nowPlayingIdsFingerprint } from "./now-playing";
import { refineNowPlaying, syncPopulateNowPlaying } from "./now-playing-card";
import { setupApp } from "./setup";
import { loadSiteBlock } from "./site-block";
import { resetVideoListFingerprint, updateVideoList, updateVideoListCardsFromState } from "./video-list";
import { getEffectiveWatchedSeconds, getQueueVideos } from "./videos";

let renderTimeout: ReturnType<typeof setTimeout> | null = null;
let probeRenderTimeout: ReturnType<typeof setTimeout> | null = null;
const PROBE_RENDER_DEBOUNCE_MS = 100;

export const NOW_PLAYING_DETECT_MS = 5000;
export const NOW_PLAYING_REFINE_DEBOUNCE_MS = 300;

export const app = document.getElementById("app")!;

function videoListStructureFingerprint(videos: VideoData[]): string {
  const sig = videos
    .map(
      (video) =>
        `${video.id}|${video.url}|${video.title}|${video.channelName}|${video.seconds}|${video.isLive ? 1 : 0}|${video.excluded ? 1 : 0}|${video.suspended ? 1 : 0}|${video.active ? 1 : 0}|${video.audible ? 1 : 0}`
    )
    .join(";");
  return `np:${nowPlayingIdsFingerprint()}|${sig}`;
}

function getQueueStats(): { totalRemaining: number; videoCount: number } {
  const queueVideos = getQueueVideos();
  const totalSeconds = queueVideos.reduce((sum, video) => sum + video.seconds, 0);
  const totalWatched = queueVideos.reduce((sum, video) => sum + getEffectiveWatchedSeconds(video), 0);
  return {
    totalRemaining: Math.max(0, totalSeconds - totalWatched),
    videoCount: queueVideos.length,
  };
}

export function refreshQueueStatsFromState(): void {
  const { totalRemaining, videoCount } = getQueueStats();
  updateHeaderStats(totalRemaining, videoCount);
}

export async function openManager(): Promise<void> {
  const managerBaseUrl = browser.runtime.getURL("/manager.html");
  const tabs = await browser.tabs.query({ url: managerBaseUrl });
  if (tabs.length > 0 && tabs[0].id != null) {
    await browser.tabs.update(tabs[0].id, { url: managerBaseUrl, active: true });
    if (tabs[0].windowId != null) {
      await browser.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await browser.tabs.create({ url: managerBaseUrl });
  }
}

function renderNow(): void {
  if (popup.videoData.length === 0) {
    stopLiveTick();
    resetVideoListFingerprint();
    setupApp();
    if (!popup.siteBlockLoaded) {
      popup.siteBlockLoaded = true;
      void loadSiteBlock();
    }

    document.getElementById("now-playing")?.classList.add("hidden");
    document.getElementById("up-next-divider")?.classList.add("hidden");

    updateHeaderStats(0, 0);

    const listEl = document.getElementById("video-list");
    if (listEl) {
      listEl.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full min-h-[260px] px-8 text-center">
          <p class="font-display text-xl text-text-primary mb-1">The desk is clear</p>
          <p class="text-xs text-text-muted leading-relaxed max-w-[240px]">Open YouTube videos in this window and they will line up here with the time they take. Saved sessions wait on the desk.</p>
        </div>
      `;
    }
    return;
  }

  setupApp();
  document.getElementById("up-next-divider")?.classList.remove("hidden");

  const { totalRemaining, videoCount } = getQueueStats();
  updateHeaderStats(totalRemaining, videoCount);
  syncPopulateNowPlaying();
  startLiveTick();
  void refineNowPlaying();

  const queueVideos = getVideosForUpNext();
  const fp = videoListStructureFingerprint(queueVideos);
  const listEl = document.getElementById("video-list");

  if (fp === popup.lastVideoListFingerprint && listEl) {
    updateVideoListCardsFromState();
    return;
  }

  popup.lastVideoListFingerprint = fp;
  updateVideoList(queueVideos);
}

export function scheduleProbeRender(): void {
  if (probeRenderTimeout != null) clearTimeout(probeRenderTimeout);
  probeRenderTimeout = setTimeout(() => {
    probeRenderTimeout = null;
    renderNow();
  }, PROBE_RENDER_DEBOUNCE_MS);
}

export function flushProbeRender(): void {
  if (probeRenderTimeout != null) {
    clearTimeout(probeRenderTimeout);
    probeRenderTimeout = null;
  }
  renderNow();
}

export function render(): void {
  if (renderTimeout != null) clearTimeout(renderTimeout);

  renderTimeout = setTimeout(() => {
    renderTimeout = null;
    renderNow();
  }, 0);
}
