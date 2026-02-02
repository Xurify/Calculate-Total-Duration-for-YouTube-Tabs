/**
 * Content script that runs on YouTube watch/shorts pages.
 * Uses a MutationObserver (narrow target + debounce) to capture video metadata
 * when the DOM updates (e.g. SPA navigation). Popup/manager can request
 * cached metadata via messaging; send "get-perf-stats" for dev performance stats.
 */
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
}

let lastMetadata: CachedMetadataPayload = {
  videoId: null,
  title: "",
  channelName: "",
  seconds: 0,
  currentTime: 0,
  isLive: false,
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  return {
    videoId,
    title: title || "YouTube Video",
    channelName,
    seconds: isLive ? 0 : duration,
    currentTime,
    isLive,
  };
}

function scheduleRead(ctx: { setTimeout: (fn: () => void, ms: number) => unknown }) {
  if (debounceTimer != null) clearTimeout(debounceTimer as unknown as number);
  debounceTimer = ctx.setTimeout(() => {
    debounceTimer = null;
    if (!isWatchOrShorts()) return;
    lastMetadata = readMetadataFromDom();
    perf.totalReads++;
    perf.mutationsSinceLastRead = 0;
  }, DEBOUNCE_MS) as unknown as ReturnType<typeof setTimeout>;
}

function isWatchOrShorts(): boolean {
  const path = window.location.pathname;
  return path.startsWith("/watch") || path.startsWith("/shorts/");
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
      subtree: true,
    });

    lastMetadata = readMetadataFromDom();
    perf.totalReads++;
    scheduleRead(ctx);

    ctx.addEventListener(window, "popstate", () => scheduleRead(ctx));
    ctx.addEventListener(window, "hashchange", () => scheduleRead(ctx));

    browser.runtime.onMessage.addListener(
      (message: { action: string; reset?: boolean }, _sender: unknown, sendResponse: (r: unknown) => void) => {
        if (message?.action === "get-metadata") {
          if (isWatchOrShorts()) {
            lastMetadata = readMetadataFromDom();
          }
          sendResponse(lastMetadata);
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
