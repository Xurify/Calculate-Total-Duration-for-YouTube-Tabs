import { VideoData } from "../../utils/storage";
import { formatPlaybackRate, parsePlaybackRate } from "../../utils/playbackRate";
import { app } from "./state";
import { render } from "./render";

/** The speed the user last chose on YouTube; every "left" figure is in real time at that speed. */
export let playbackRate = 1;

export function applyPlaybackRate(value: unknown): void {
  const rate = parsePlaybackRate(value);
  if (rate === playbackRate) return;
  playbackRate = rate;
  app.lastFacetRailHtml = "";
  app.lastTabListFingerprint = "";
  render();
}

export function leftSuffix(): string {
  return playbackRate === 1 ? "left" : `left at ${formatPlaybackRate(playbackRate)}`;
}

export function remainingOf(video: VideoData): number {
  if (video.isLive || video.excluded) return 0;
  return Math.max(0, video.seconds - video.currentTime) / playbackRate;
}
