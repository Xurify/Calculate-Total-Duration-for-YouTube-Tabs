export const PLAYBACK_RATE_KEY = "playbackRate";

/** YouTube allows 0.07×–16× through its custom speed setting. */
export function parsePlaybackRate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.07 && value <= 16 ? value : 1;
}

export function formatPlaybackRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}
