/**
 * Content script that runs on YouTube watch/shorts pages.
 * Uses a MutationObserver (narrow target + debounce) to capture video metadata
 * when the DOM updates (e.g. SPA navigation). Popup/manager can request
 * cached metadata via messaging; send "get-perf-stats" for dev performance stats.
 */
import {
  detectLanguageFromPlayerResponse,
  type DetectedLanguage,
} from "../utils/captionLanguage";

const DEBOUNCE_MS = 150;

const perf = {
  totalMutations: 0,
  totalReads: 0,
  mutationsSinceLastRead: 0,
};

interface CachedMetadataPayload {
  videoId: string | null;
  title: string;
  channelName: string;
  seconds: number;
  currentTime: number;
  isLive: boolean;
  language?: string | null;
  languageName?: string | null;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
}

let lastMetadata: CachedMetadataPayload = {
  videoId: null,
  title: "",
  channelName: "",
  seconds: 0,
  currentTime: 0,
  isLive: false,
  language: null,
  languageName: null,
  paused: true,
  volume: 1,
  muted: false,
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastReadTime = 0;
const MAX_WAIT_MS = 1000;

function getVideoIdFromLocation(): string | null {
  try {
    const path = window.location.pathname;
    const search = window.location.search;
    if (path.startsWith("/shorts/")) {
      const m = path.match(/\/shorts\/([^/?]+)/);
      return m ? m[1] : null;
    }
    if (path === "/watch" && search) {
      const params = new URLSearchParams(search);
      return params.get("v");
    }
  } catch {
    // ignore
  }
  return null;
}

type PlayerResponseShape = Parameters<typeof detectLanguageFromPlayerResponse>[0];

function readPlayerResponseFromPage(): PlayerResponseShape | null {
  try {
    const fromWindow = (window as unknown as { ytInitialPlayerResponse?: PlayerResponseShape })
      .ytInitialPlayerResponse;
    if (fromWindow) return fromWindow;
  } catch {
    // ignore
  }

  try {
    for (const script of document.querySelectorAll("script:not([src])")) {
      const text = script.textContent;
      if (!text?.includes("ytInitialPlayerResponse")) continue;
      const playerResponseMatch =
        text.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
        text.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
      if (!playerResponseMatch) continue;
      return JSON.parse(playerResponseMatch[1]) as PlayerResponseShape;
    }
  } catch {
    // ignore
  }

  return null;
}

function extractLanguageFromDom(): DetectedLanguage {
  const playerResponse = readPlayerResponseFromPage();
  return detectLanguageFromPlayerResponse(playerResponse);
}

function parseDurationFromTimeText(text: string): number {
  const parts = text.trim().split(":").map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

function readMetadataFromDom(): CachedMetadataPayload {
  const videoId = getVideoIdFromLocation();

  const videoEl = document.querySelector("video");
  const currentTime = videoEl ? videoEl.currentTime : 0;
  let duration = 0;

  const videoDuration = videoEl?.duration;
  if (videoDuration != null && isFinite(videoDuration) && videoDuration > 0) {
    duration = videoDuration;
  }
  if (duration === 0) {
    const durationEl = document.querySelector(".ytp-time-duration");
    if (durationEl?.textContent) {
      duration = parseDurationFromTimeText(durationEl.textContent);
    }
  }
  if (duration === 0 && videoEl?.duration) {
    const d = videoEl.duration;
    if (isFinite(d) && d > 0) duration = d;
  }

  let title =
    (document.querySelector("h1.ytd-watch-metadata yt-formatted-string") as HTMLElement)?.innerText ||
    (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
    (document.querySelector("ytd-watch-metadata h1") as HTMLElement)?.innerText ||
    document.title;
  title = title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();

  const channelName =
    (document.querySelector("ytd-watch-metadata ytd-channel-name a") as HTMLElement)?.innerText ||
    (document.querySelector("#upload-info #channel-name a") as HTMLElement)?.innerText ||
    (document.querySelector(".ytd-video-owner-renderer #channel-name a") as HTMLElement)?.innerText ||
    "";

  let isLive = false;
  const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
  if (liveBadge && getComputedStyle(liveBadge).display !== "none") {
    isLive = true;
  }

  const { language, languageName } = extractLanguageFromDom();
  const volume = videoEl ? videoEl.volume : 1;
  const muted = videoEl ? videoEl.muted : false;
  const paused = videoEl ? videoEl.paused : true;

  return {
    videoId,
    title: title || "YouTube Video",
    channelName,
    seconds: isLive ? 0 : duration,
    currentTime,
    isLive,
    language,
    languageName,
    paused,
    volume,
    muted,
  };
}

function scheduleRead(ctx: { setTimeout: (fn: () => void, ms: number) => unknown }) {
  const now = Date.now();
  const timeSinceLastRead = now - lastReadTime;

  if (debounceTimer != null) {
    if (timeSinceLastRead > MAX_WAIT_MS) {
      return;
    }
    clearTimeout(debounceTimer as unknown as number);
  }
  debounceTimer = ctx.setTimeout(() => {
    debounceTimer = null;
    if (!isWatchOrShorts()) return;
    lastMetadata = readMetadataFromDom();
    lastReadTime = Date.now();
    perf.totalReads++;
    perf.mutationsSinceLastRead = 0;
  }, DEBOUNCE_MS) as unknown as ReturnType<typeof setTimeout>;
}

function isWatchOrShorts(): boolean {
  const path = window.location.pathname;
  return path.startsWith("/watch") || path.startsWith("/shorts/");
}

function getPlaybackState() {
  const videoEl = document.querySelector("video");
  if (!videoEl) {
    return { paused: true, volume: 1, muted: false, currentTime: 0 };
  }
  return {
    paused: videoEl.paused,
    volume: videoEl.volume,
    muted: videoEl.muted,
    currentTime: videoEl.currentTime,
  };
}

function togglePlayback() {
  const videoEl = document.querySelector("video");
  if (!videoEl) return getPlaybackState();
  if (videoEl.paused) {
    void videoEl.play();
  } else {
    videoEl.pause();
  }
  return getPlaybackState();
}

function setPlaybackVolume(volume: number) {
  const videoEl = document.querySelector("video");
  if (!videoEl) return getPlaybackState();
  const clamped = Math.min(1, Math.max(0, volume));
  videoEl.volume = clamped;
  if (clamped > 0 && videoEl.muted) {
    videoEl.muted = false;
  }
  return getPlaybackState();
}

export default defineContentScript({
  matches: ["*://*.youtube.com/watch*", "*://*.youtube.com/shorts*"],
  main(ctx) {
    if (!isWatchOrShorts()) return;

    const target =
      document.querySelector("#primary") ||
      document.querySelector("#content") ||
      document.body;
    if (!target) return;

    const observer = new MutationObserver(() => {
      perf.totalMutations++;
      perf.mutationsSinceLastRead++;
      scheduleRead(ctx);
    });

    observer.observe(target, {
      childList: true,
      subtree: false,
    });

    const titleEl = document.querySelector("title");
    if (titleEl) {
      const titleObserver = new MutationObserver(() => {
        perf.totalMutations++;
        perf.mutationsSinceLastRead++;
        scheduleRead(ctx);
      });
      titleObserver.observe(titleEl, { childList: true });
    }

    ctx.addEventListener(document, "durationchange", () => scheduleRead(ctx), true);
    ctx.addEventListener(document, "loadedmetadata", () => scheduleRead(ctx), true);

    lastMetadata = readMetadataFromDom();
    perf.totalReads++;
    scheduleRead(ctx);

    ctx.addEventListener(window, "popstate", () => scheduleRead(ctx));
    ctx.addEventListener(window, "hashchange", () => scheduleRead(ctx));
    ctx.addEventListener(document, "yt-navigate-finish", () => scheduleRead(ctx));

    browser.runtime.onMessage.addListener(
      (
        message: { action: string; reset?: boolean; volume?: number; refreshLanguage?: boolean },
        _sender: unknown,
        sendResponse: (r: unknown) => void
      ) => {
        if (message?.action === "get-metadata") {
          if (isWatchOrShorts()) {
            const currentId = getVideoIdFromLocation();
            const refreshLanguage = message.refreshLanguage === true;
            if (currentId !== lastMetadata.videoId || refreshLanguage) {
              lastMetadata = readMetadataFromDom();
            }
          }
          sendResponse(lastMetadata);
          return;
        }
        if (message?.action === "get-playback-state") {
          sendResponse(getPlaybackState());
          return;
        }
        if (message?.action === "toggle-play") {
          sendResponse(togglePlayback());
          return;
        }
        if (message?.action === "set-volume" && typeof message.volume === "number") {
          sendResponse(setPlaybackVolume(message.volume));
          return;
        }
        if (message?.action === "get-perf-stats") {
          const stats = {
            totalMutations: perf.totalMutations,
            totalReads: perf.totalReads,
            mutationsSinceLastRead: perf.mutationsSinceLastRead,
            debounceMs: DEBOUNCE_MS,
            ratio: perf.totalReads > 0 ? (perf.totalMutations / perf.totalReads).toFixed(1) : "—",
          };
          if (message.reset) {
            perf.totalMutations = 0;
            perf.totalReads = 0;
            perf.mutationsSinceLastRead = 0;
          }
          sendResponse(stats);
        }
      }
    );
  },
});
