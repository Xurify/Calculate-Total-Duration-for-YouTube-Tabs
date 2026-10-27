import type { PlaybackState } from "./now-playing";

export async function getPlaybackState(tabId: number): Promise<PlaybackState | null> {
  try {
    const state = await browser.tabs.sendMessage(tabId, { action: "get-playback-state" });
    if (state && typeof state.paused === "boolean") return state as PlaybackState;
  } catch {
    // Content script may not be loaded yet
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const videoEl = document.querySelector("video");
        if (!videoEl) return { paused: true, volume: 1, muted: false, currentTime: 0 };
        return {
          paused: videoEl.paused,
          volume: videoEl.volume,
          muted: videoEl.muted,
          currentTime: videoEl.currentTime,
        };
      },
    });
    return (results[0]?.result as PlaybackState) ?? null;
  } catch {
    return null;
  }
}

export async function togglePlayback(tabId: number): Promise<PlaybackState | null> {
  try {
    const state = await browser.tabs.sendMessage(tabId, { action: "toggle-play" });
    if (state && typeof state.paused === "boolean") return state as PlaybackState;
  } catch {
    // fall through
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const videoEl = document.querySelector("video");
        if (!videoEl) return { paused: true, volume: 1, muted: false, currentTime: 0 };
        if (videoEl.paused) void videoEl.play();
        else videoEl.pause();
        return {
          paused: videoEl.paused,
          volume: videoEl.volume,
          muted: videoEl.muted,
          currentTime: videoEl.currentTime,
        };
      },
    });
    return (results[0]?.result as PlaybackState) ?? null;
  } catch {
    return null;
  }
}

export async function setPlaybackVolume(tabId: number, volume: number): Promise<PlaybackState | null> {
  try {
    const state = await browser.tabs.sendMessage(tabId, { action: "set-volume", volume });
    if (state && typeof state.volume === "number") return state as PlaybackState;
  } catch {
    // fall through
  }

  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [volume],
      func: (nextVolume: number) => {
        const videoEl = document.querySelector("video");
        if (!videoEl) return { paused: true, volume: 1, muted: false, currentTime: 0 };
        const clamped = Math.min(1, Math.max(0, nextVolume));
        videoEl.volume = clamped;
        if (clamped > 0 && videoEl.muted) videoEl.muted = false;
        return {
          paused: videoEl.paused,
          volume: videoEl.volume,
          muted: videoEl.muted,
          currentTime: videoEl.currentTime,
        };
      },
    });
    return (results[0]?.result as PlaybackState) ?? null;
  } catch {
    return null;
  }
}
