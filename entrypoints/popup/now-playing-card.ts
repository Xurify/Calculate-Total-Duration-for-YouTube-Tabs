import { VideoData } from "../../utils/storage";
import { formatCompact, formatDurationWords } from "../../utils/format";
import { syncRangeFill } from "../../utils/controls";
import { popup } from "./state";
import {
  applyLocalPlaybackControl,
  findVideoByTabId,
  getConfirmedNowPlayingVideos,
  getNowPlayingTabId,
  getPrimaryNowPlayingSync,
  getThumbnailUrl,
  getVideosForUpNext,
  isTabActivelyPlaying,
  nowPlayingIdsFingerprint,
  persistLastPlayingTabId,
  type PlaybackState,
  refreshNowPlayingDetection,
  scheduleNowPlayingRefine,
  syncUpNextIfNowPlayingChanged,
  updateAlsoPlayingLine,
} from "./now-playing";
import { getPlaybackState, setPlaybackVolume, togglePlayback } from "./playback";
import { refreshQueueStatsFromState } from "./render";
import { applyPlaybackTimeToVideo, getWatchedPercent, persistVideoPlaybackToCache } from "./videos";

const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`;
const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/></svg>`;

const VOLUME_ICON_LOW = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>`;
const VOLUME_ICON_MED = `${VOLUME_ICON_LOW}<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>`;
const VOLUME_ICON_HIGH = `${VOLUME_ICON_MED}<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>`;
const VOLUME_ICON_MUTE = `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" x2="17" y1="9" y2="15"/><line x1="17" x2="23" y1="9" y2="15"/>`;

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
      updateNowPlayingCard(card, video, state, activelyPlaying);
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

    if (target.closest(".np-go-to-tab") || target.closest(".np-title") || target.closest(".np-thumb-btn")) {
      await browser.tabs.update(tabId, { active: true });
      if (video.windowId != null) {
        await browser.windows.update(video.windowId, { focused: true });
      }
    }
  });

  card.addEventListener("input", async (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("np-volume")) return;
    syncRangeFill(target as HTMLInputElement);
    const tabId = parseInt(card.dataset.npTabId || "0", 10);
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;
    popup.lastVolumeInputTime = Date.now();
    const value = parseInt((target as HTMLInputElement).value, 10);
    const volumeIcon = card.querySelector(".np-volume-icon") as SVGElement | null;
    if (volumeIcon) {
      const vol = value / 100;
      const paths =
        vol === 0 ? VOLUME_ICON_MUTE : vol < 0.35 ? VOLUME_ICON_LOW : vol < 0.7 ? VOLUME_ICON_MED : VOLUME_ICON_HIGH;
      volumeIcon.innerHTML = paths;
    }
    const state = await setPlaybackVolume(tabId, value / 100);
    if (!state) return;
    const activelyPlaying = applyLocalPlaybackControl(tabId, video, state);
    updateNowPlayingCard(card, video, state, activelyPlaying);
    void persistLastPlayingTabId(tabId);
    scheduleNowPlayingRefine();
  });

  card.addEventListener("change", (event) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("np-volume")) return;
    const tabId = parseInt(card.dataset.npTabId || "0", 10);
    const video = tabId ? findVideoByTabId(tabId) : undefined;
    if (!tabId || !video) return;
    const value = parseInt((target as HTMLInputElement).value, 10);
    video.volume = value / 100;
    video.muted = value === 0;
    persistVideoPlaybackToCache(video);
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

function updateNowPlayingCardTime(card: HTMLElement, video: VideoData): void {
  const watchedPercent = getWatchedPercent(video);
  const progressEl = card.querySelector(".np-progress") as HTMLElement | null;
  if (progressEl) {
    if (video.isLive) {
      progressEl.style.width = "0%";
    } else {
      progressEl.style.width = `${watchedPercent}%`;
    }
  }

  const timeEl = card.querySelector(".np-time") as HTMLElement | null;
  if (!timeEl) return;

  if (video.isLive) {
    timeEl.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-youtube/15 text-youtube text-[9px] font-bold">LIVE</span>`;
  } else if (video.seconds > 0) {
    const left = Math.max(0, video.seconds - video.currentTime);
    timeEl.innerHTML = `${formatCompact(video.currentTime)}<span class="mx-0.5 opacity-30">/</span>${formatCompact(video.seconds)}<span class="text-text-muted"> · ${formatDurationWords(left)} left</span>`;
  } else {
    timeEl.innerText = formatCompact(video.currentTime);
  }
}

export function updateNowPlayingCard(
  card: HTMLElement,
  video: VideoData,
  state: PlaybackState,
  isActivelyPlaying: boolean
): void {
  card.dataset.npTabId = String(video.id);

  const channelEl = card.querySelector(".np-channel") as HTMLElement | null;
  const channelName = formatNowPlayingChannelName(video);
  if (channelEl) {
    channelEl.textContent = channelName || "\u00a0";
    channelEl.classList.toggle("invisible", !channelName);
  }

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

  updateNowPlayingCardTime(card, video);

  const playBtn = card.querySelector(".np-play-pause") as HTMLButtonElement | null;
  const volumeInput = card.querySelector(".np-volume") as HTMLInputElement | null;
  const volumeIcon = card.querySelector(".np-volume-icon") as SVGElement | null;

  if (playBtn) {
    playBtn.innerHTML = state.paused ? PLAY_ICON : PAUSE_ICON;
    playBtn.title = state.paused ? "Play" : "Pause";
    playBtn.setAttribute("aria-label", playBtn.title);
  }
  if (volumeInput) {
    const isInteracting = document.activeElement === volumeInput && (Date.now() - popup.lastVolumeInputTime < 1500);
    if (!isInteracting) {
      const displayVolume = state.muted ? 0 : Math.round(state.volume * 100);
      volumeInput.value = String(displayVolume);
      syncRangeFill(volumeInput);
    }
  }
  if (volumeIcon) {
    const vol = state.muted ? 0 : state.volume;
    const paths =
      vol === 0 ? VOLUME_ICON_MUTE : vol < 0.35 ? VOLUME_ICON_LOW : vol < 0.7 ? VOLUME_ICON_MED : VOLUME_ICON_HIGH;
    volumeIcon.innerHTML = paths;
  }
  card.className = `np-card${isActivelyPlaying ? " np-card--playing" : ""}`;
  const kicker = card.querySelector(".np-kicker") as HTMLElement | null;
  if (kicker) kicker.textContent = isActivelyPlaying ? "Playing now" : "Paused";
}

export function renderNowPlayingCard(primary: VideoData | null, confirmedPlaying: VideoData[]): void {
  const section = document.getElementById("now-playing");
  const alsoEl = document.getElementById("np-also-playing");
  const card = document.getElementById("np-card");
  if (!section || !card) return;

  if (!primary) {
    section.classList.add("hidden");
    section.removeAttribute("data-tab-id");
    card.dataset.npTabId = "";
    if (alsoEl) {
      alsoEl.classList.add("hidden");
      alsoEl.textContent = "";
    }
    return;
  }

  section.classList.remove("hidden");
  section.dataset.tabId = String(primary.id);

  updateNowPlayingCard(
    card,
    primary,
    {
      paused: primary.paused ?? !isTabActivelyPlaying(primary),
      volume: primary.volume ?? 1,
      muted: primary.muted ?? false,
      currentTime: primary.currentTime,
    },
    isTabActivelyPlaying(primary)
  );

  updateAlsoPlayingLine(confirmedPlaying, primary);
}

function formatNowPlayingChannelName(video: VideoData): string {
  if (!video.channelName || video.channelName === "YouTube" || video.channelName === "YouTube Video") {
    return "";
  }
  return video.channelName;
}

export function syncPopulateNowPlaying(): void {
  renderNowPlayingCard(getPrimaryNowPlayingSync(), getConfirmedNowPlayingVideos());
}

export async function refineNowPlaying(): Promise<void> {
  const previousIds = nowPlayingIdsFingerprint();
  const previousPrimaryId = getNowPlayingTabId();
  const videos = await refreshNowPlayingDetection();
  popup.lastNowPlayingDetectAt = Date.now();
  const confirmed = getConfirmedNowPlayingVideos();
  const primary = videos[0] ?? null;

  if (!primary || primary.id !== previousPrimaryId) {
    renderNowPlayingCard(primary, confirmed);
  } else {
    updateAlsoPlayingLine(confirmed, primary);
    const card = document.getElementById("np-card");
    if (card) {
      const playback = await getPlaybackState(primary.id);
      if (playback) {
        primary.paused = playback.paused;
        primary.volume = playback.volume;
        primary.muted = playback.muted;
        applyPlaybackTimeToVideo(primary, playback.currentTime);
        updateNowPlayingCard(card, primary, playback, isTabActivelyPlaying(primary));
      }
    }
  }

  syncUpNextIfNowPlayingChanged(previousIds);
}
