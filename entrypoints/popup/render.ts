import { mountThemeControl, THEME_CONTROL_HTML } from "../../utils/theme";
import packageJson from "../../package.json";
import { VideoData, clearCache } from "../../utils/storage";
import { popup } from "./state";
import { showConfirm } from "./dialogs";
import { updateHeaderStats } from "./header";
import { startLiveTick, stopLiveTick } from "./live-tick";
import { getVideosForUpNext, nowPlayingIdsFingerprint } from "./now-playing";
import { refineNowPlaying, syncPopulateNowPlaying } from "./now-playing-card";
import { setupApp } from "./setup";
import { loadSiteBlock } from "./site-block";
import { getYouTubeTabs } from "./tabs";
import { resetVideoListFingerprint, updateVideoList, updateVideoListCardsFromState } from "./video-list";
import { getEffectiveWatchedSeconds, getQueueVideos } from "./videos";

const VERSION_NUMBER = packageJson.version;

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
  return `${popup.sortByDuration ? 1 : 0}|np:${nowPlayingIdsFingerprint()}|${sig}`;
}

function getQueueStats(): {
  totalSeconds: number;
  totalWatched: number;
  totalRemaining: number;
  videoCount: number;
} {
  const queueVideos = getQueueVideos();
  const totalSeconds = queueVideos.reduce((sum, video) => sum + video.seconds, 0);
  const totalWatched = queueVideos.reduce((sum, video) => sum + getEffectiveWatchedSeconds(video), 0);
  return {
    totalSeconds,
    totalWatched,
    totalRemaining: Math.max(0, totalSeconds - totalWatched),
    videoCount: queueVideos.length,
  };
}

export function refreshQueueStatsFromState(): void {
  const { totalSeconds, totalWatched, totalRemaining, videoCount } = getQueueStats();
  updateHeaderStats(totalSeconds, totalRemaining, videoCount, totalWatched);
}

export function goToSettings(): void {
  popup.currentView = "settings";
  render();
}

export async function openManager(queryParameter = ""): Promise<void> {
  const managerBaseUrl = browser.runtime.getURL("/manager.html");
  const targetUrl = browser.runtime.getURL(`/manager.html${queryParameter}`);
  const tabs = await browser.tabs.query({ url: managerBaseUrl });
  if (tabs.length > 0 && tabs[0].id != null) {
    await browser.tabs.update(tabs[0].id, { url: targetUrl, active: true });
    if (tabs[0].windowId != null) {
      await browser.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await browser.tabs.create({ url: targetUrl });
  }
}

function renderNow(): void {
  if (popup.currentView === "settings") {
    stopLiveTick();
    resetVideoListFingerprint();
    app.innerHTML = `
          <div data-v-header class="pt-3.5 px-4 pb-3 relative">
            <div class="flex items-center gap-2 mb-4">
              <button id="back-to-dashboard" type="button" class="popup-icon -ml-1" aria-label="Back">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <h2 class="font-display text-[18px] font-medium text-text-primary m-0">Settings</h2>
            </div>
            <div class="rounded-xl border border-border bg-surface-elevated px-3">
              <div class="flex items-center justify-between gap-3 py-2.5">
                <div>
                  <div class="text-[12px] font-semibold text-text-primary">Appearance</div>
                  <div class="text-[10px] text-text-muted">System follows your computer</div>
                </div>
                <div id="appearance-control" class="shrink-0"></div>
              </div>
              <div class="flex items-center justify-between gap-3 py-2.5 border-t border-border">
                <div>
                  <div class="text-[12px] font-semibold text-text-primary">Clear video details</div>
                  <div class="text-[10px] text-text-muted">Titles and lengths load again from open tabs</div>
                </div>
                <button type="button" id="btn-clear-cache" class="chip chip--danger h-7 px-2.5 text-[12px] shrink-0">Clear</button>
              </div>
            </div>
            <div class="mt-3 pt-3 pb-0 border-t border-border/50 text-center">
              <div class="text-[11px] text-text-muted"><span class="font-display">Study Harvester</span> · v${VERSION_NUMBER} · <span class="inline-flex items-center gap-1 text-success" title="Pages that support WebMCP can use Study Harvester's tools"><span class="w-1.5 h-1.5 rounded-full bg-success"></span>WebMCP on</span></div>
            </div>
          </div>
          <div id="popup-confirm-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-scrim backdrop-blur-sm" aria-modal="true" role="dialog" aria-labelledby="popup-confirm-title">
            <div class="bg-surface-elevated border border-border rounded-lg shadow-xl w-full max-w-[calc(100%-2rem)] mx-4 p-4">
              <h3 id="popup-confirm-title" class="text-sm font-bold text-text-primary mb-2"></h3>
              <p id="popup-confirm-message" class="text-xs text-text-secondary mb-4"></p>
              <div class="flex justify-end gap-2">
                <button type="button" id="popup-confirm-cancel" data-dialog-cancel data-dialog-focus class="px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-surface-hover text-text-primary hover:bg-surface cursor-pointer">Cancel</button>
                <button type="button" id="popup-confirm-ok" class="px-3 py-1.5 text-xs font-medium rounded-md border-0 bg-danger text-on-accent hover:bg-danger-hover cursor-pointer transition-colors">Clear</button>
              </div>
            </div>
          </div>
        `;
    const appearanceControl = document.getElementById("appearance-control");
    if (appearanceControl) {
      appearanceControl.innerHTML = THEME_CONTROL_HTML;
      mountThemeControl(appearanceControl);
    }
    document.getElementById("back-to-dashboard")!.addEventListener("click", () => {
      popup.currentView = "dashboard";
      render();
    });

    document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
      const confirmed = await showConfirm({
        title: "Clear video details?",
        message: "Saved titles and lengths are forgotten and load again from open tabs. Sessions, history and settings stay.",
      });
      if (confirmed) {
        await clearCache();
        popup.storeState.metadataCache = {};
        await getYouTubeTabs();
        popup.currentView = "dashboard";
        render();
      }
    });
    return;
  }

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

    updateHeaderStats(0, 0, 0, 0);

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

  const { totalSeconds, totalWatched, totalRemaining, videoCount } = getQueueStats();
  updateHeaderStats(totalSeconds, totalRemaining, videoCount, totalWatched);
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
