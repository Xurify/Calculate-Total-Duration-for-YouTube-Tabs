import { VideoData } from "../../utils/storage";
import { formatCompact } from "../../utils/format";
import { escapeHtml as escapeText } from "../../utils/timeUi";
import {
  applyLocalPlaybackControl,
  findVideoByTabId,
  getNowPlayingTabId,
  getPrimaryNowPlayingSync,
  getThumbnailUrl,
  getVideosForUpNext,
  isTabActivelyPlaying,
  nowPlayingIdsFingerprint,
  persistLastPlayingTabId,
  refreshNowPlayingDetection,
  scheduleNowPlayingRefine,
  syncUpNextIfNowPlayingChanged,
} from "./now-playing";
import { popupLanguageLabel } from "./languages";
import { getPlaybackState, togglePlayback } from "./playback";
import { popup } from "./state";
import { refreshQueueStatsFromState } from "./render";
import { applyPlaybackTimeToVideo } from "./videos";

const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>`;

export function bindNowPlayingCardEvents(): void {
  const card = document.getElementById("np-card");
  if (!card || card.dataset.bound === "1") return;
  card.dataset.bound = "1";

  card.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const tabId = parseInt(card.dataset.npTabId || "0", 10);
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;

    if (target.closest(".np-play-pause")) {
      const previousIds = nowPlayingIdsFingerprint();
      const state = await togglePlayback(tabId);
      if (!state) return;
      const activelyPlaying = applyLocalPlaybackControl(tabId, video, state);
      updateNowPlayingCard(card, video, state.paused);
      refreshQueueStatsFromState();
      syncUpNextIfNowPlayingChanged(previousIds);
      if (activelyPlaying) void persistLastPlayingTabId(tabId);
      scheduleNowPlayingRefine();
      return;
    }

    if (target.closest(".np-next")) {
      await playNextVideo(video);
      return;
    }

    if (target.closest(".np-title") || target.closest(".np-thumb-btn")) {
      await browser.tabs.update(tabId, { active: true });
      if (video.windowId != null) {
        await browser.windows.update(video.windowId, { focused: true });
      }
    }
  });
}

/** Pauses the current video and starts the first one in Up next, in its own tab. */
async function playNextVideo(current: VideoData): Promise<void> {
  const next = getVideosForUpNext().find((video) => video.id !== current.id && !video.excluded && !video.isLive);
  if (!next) return;
  if (current.paused === false) await togglePlayback(current.id);
  await browser.tabs.update(next.id, { active: true });
  if (next.windowId != null) await browser.windows.update(next.windowId, { focused: true });
  await browser.scripting
    .executeScript({
      target: { tabId: next.id },
      world: "MAIN",
      func: () => void document.querySelector("video")?.play().catch(() => {}),
    })
    .catch(() => {});
  void persistLastPlayingTabId(next.id);
}

function updateNowPlayingMeta(card: HTMLElement, video: VideoData): void {
  const metaEl = card.querySelector(".np-time") as HTMLElement | null;
  if (!metaEl) return;
  if (video.isLive) {
    metaEl.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-youtube/15 text-youtube text-[9px] font-bold">LIVE</span>`;
    return;
  }
  const position =
    video.seconds > 0 ? `${formatCompact(video.currentTime)} of ${formatCompact(video.seconds)}` : formatCompact(video.currentTime);
  const language = popupLanguageLabel(video);
  metaEl.innerHTML = language ? `${position} · ${escapeText(language)}` : position;
}

export function updateNowPlayingCard(card: HTMLElement, video: VideoData, paused: boolean): void {
  card.dataset.npTabId = String(video.id);

  const titleEl = card.querySelector(".np-title") as HTMLElement | null;
  if (titleEl) {
    titleEl.textContent = video.title;
    titleEl.title = video.title;
  }

  const thumbEl = card.querySelector(".np-thumb") as HTMLImageElement | null;
  const thumbUrl = getThumbnailUrl(video.url);
  if (thumbEl) {
    if (thumbUrl) {
      if (thumbEl.src !== thumbUrl) thumbEl.src = thumbUrl;
      thumbEl.classList.remove("hidden");
    } else {
      thumbEl.removeAttribute("src");
      thumbEl.classList.add("hidden");
    }
  }

  updateNowPlayingMeta(card, video);

  const playBtn = card.querySelector(".np-play-pause") as HTMLButtonElement | null;
  if (playBtn) {
    playBtn.innerHTML = paused ? PLAY_ICON : PAUSE_ICON;
    playBtn.title = paused ? "Play" : "Pause";
    playBtn.setAttribute("aria-label", playBtn.title);
  }
}

export function renderNowPlayingCard(primary: VideoData | null): void {
  const section = document.getElementById("now-playing");
  const card = document.getElementById("np-card");
  if (!section || !card) return;

  if (!primary) {
    section.classList.add("hidden");
    section.removeAttribute("data-tab-id");
    card.dataset.npTabId = "";
    return;
  }

  section.classList.remove("hidden");
  section.dataset.tabId = String(primary.id);
  updateNowPlayingCard(card, primary, primary.paused ?? !isTabActivelyPlaying(primary));
}

export function syncPopulateNowPlaying(): void {
  renderNowPlayingCard(getPrimaryNowPlayingSync());
}

export async function refineNowPlaying(): Promise<void> {
  const previousIds = nowPlayingIdsFingerprint();
  const previousPrimaryId = getNowPlayingTabId();
  const videos = await refreshNowPlayingDetection();
  popup.lastNowPlayingDetectAt = Date.now();
  const primary = videos[0] ?? null;

  if (!primary || primary.id !== previousPrimaryId) {
    renderNowPlayingCard(primary);
  } else {
    const card = document.getElementById("np-card");
    if (card) {
      const playback = await getPlaybackState(primary.id);
      if (playback) {
        primary.paused = playback.paused;
        primary.volume = playback.volume;
        primary.muted = playback.muted;
        applyPlaybackTimeToVideo(primary, playback.currentTime);
        updateNowPlayingCard(card, primary, playback.paused);
      }
    }
  }

  syncUpNextIfNowPlayingChanged(previousIds);
}
