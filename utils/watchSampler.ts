import type { WatchSample } from "./watchLog";

export interface WatchMetadata {
  videoId: string | null;
  title: string;
  channelName: string;
  language?: string | null;
  languageName?: string | null;
  seconds: number;
  isLive: boolean;
}

interface Pending {
  videoId: string;
  isShort: boolean;
  startedAt: number;
  endedAt: number;
  played: number;
  covered: number;
  visible: number;
  captions: number;
  ads: number;
  position: number;
  metadata: WatchMetadata | null;
}

interface SamplerContext {
  setInterval(handler: () => void, timeout: number): unknown;
  addEventListener(target: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions | boolean): void;
}

const TICK_MS = 1000;
const FLUSH_MS = 15_000;
/** Ignore ticks after sleep or tab freeze — that gap was not watching. */
const MAX_TICK_GAP_MS = 2500;

function mainVideo(): HTMLVideoElement | null {
  const shorts = window.location.pathname.startsWith("/shorts/");
  return (
    document.querySelector<HTMLVideoElement>(shorts ? "#shorts-player video" : "#movie_player video") ??
    document.querySelector<HTMLVideoElement>("video.html5-main-video")
  );
}

export class WatchSampler {
  #pending: Pending | null = null;
  #lastTick = Date.now();

  constructor(
    private readonly options: {
      videoId: () => string | null;
      metadata: () => WatchMetadata | null;
      send: (sample: WatchSample) => Promise<unknown>;
    }
  ) {}

  start(context: SamplerContext): void {
    context.setInterval(() => this.#tick(), TICK_MS);
    context.setInterval(() => this.flush(), FLUSH_MS);
    context.addEventListener(document, "visibilitychange", () => this.flush());
    context.addEventListener(window, "pagehide", () => this.flush());
    // Media events do not bubble; capture phase on document.
    context.addEventListener(document, "pause", () => this.flush(), true);
    context.addEventListener(document, "ended", () => this.flush(), true);
  }

  #tick(): void {
    const now = Date.now();
    const gap = now - this.#lastTick;
    this.#lastTick = now;
    if (gap <= 0 || gap > MAX_TICK_GAP_MS) return;
    const videoId = this.options.videoId();
    const video = mainVideo();
    if (!videoId || !video || video.paused || video.ended || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
    const visible = document.visibilityState === "visible";
    if (!visible && (video.muted || video.volume === 0)) return;

    if (this.#pending && this.#pending.videoId !== videoId) this.flush();
    const pending = (this.#pending ??= {
      videoId,
      isShort: window.location.pathname.startsWith("/shorts/"),
      startedAt: now - gap,
      endedAt: now,
      played: 0,
      covered: 0,
      visible: 0,
      captions: 0,
      ads: 0,
      position: 0,
      metadata: null,
    });
    const seconds = gap / 1000;
    pending.endedAt = now;
    const player = video.closest(".html5-video-player");
    if (player?.classList.contains("ad-showing")) {
      pending.ads += seconds;
      return;
    }
    pending.played += seconds;
    pending.covered += seconds * (video.playbackRate || 1);
    if (visible) pending.visible += seconds;
    if (player?.querySelector('.ytp-subtitles-button[aria-pressed="true"]')) pending.captions += seconds;
    pending.position = video.currentTime;
    const metadata = this.options.metadata();
    if (metadata?.videoId === videoId) pending.metadata = metadata;
  }

  flush(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending || (pending.played < 1 && pending.ads < 1)) return;
    const metadata = pending.metadata;
    const sample: WatchSample = {
      videoId: pending.videoId,
      title: metadata?.title ?? "",
      channelName: metadata?.channelName ?? "",
      language: metadata?.language ?? null,
      languageName: metadata?.languageName ?? null,
      durationSeconds: metadata?.isLive ? 0 : metadata?.seconds ?? 0,
      isLive: metadata?.isLive ?? false,
      isShort: pending.isShort,
      startedAt: pending.startedAt,
      endedAt: pending.endedAt,
      playedSeconds: pending.played,
      videoSeconds: pending.covered,
      visibleSeconds: pending.visible,
      captionSeconds: pending.captions,
      adSeconds: pending.ads,
      position: pending.position,
    };
    void this.options.send(sample).catch(() => this.#putBack(pending));
  }

  #putBack(sent: Pending): void {
    const current = this.#pending;
    if (!current) {
      this.#pending = sent;
      return;
    }
    if (current.videoId !== sent.videoId) return;
    current.startedAt = Math.min(current.startedAt, sent.startedAt);
    current.played += sent.played;
    current.covered += sent.covered;
    current.visible += sent.visible;
    current.captions += sent.captions;
    current.ads += sent.ads;
    current.metadata ??= sent.metadata;
  }
}
