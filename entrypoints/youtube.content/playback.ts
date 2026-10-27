

export function isWatchOrShorts(): boolean {
  const pathname = window.location.pathname;
  return pathname.startsWith("/watch") || pathname.startsWith("/shorts/");
}

export function getPlaybackState() {
  const videoElement = document.querySelector("video");
  if (!videoElement) {
    return { paused: true, volume: 1, muted: false, currentTime: 0 };
  }
  return {
    paused: videoElement.paused,
    volume: videoElement.volume,
    muted: videoElement.muted,
    currentTime: videoElement.currentTime,
  };
}

export function togglePlayback() {
  const videoElement = document.querySelector("video");
  if (!videoElement) return getPlaybackState();
  if (videoElement.paused) {
    void videoElement.play();
  } else {
    videoElement.pause();
  }
  return getPlaybackState();
}

export function setPlaybackVolume(volume: number) {
  const videoElement = document.querySelector("video");
  if (!videoElement) return getPlaybackState();
  const clampedVolume = Math.min(1, Math.max(0, volume));
  videoElement.volume = clampedVolume;
  if (clampedVolume > 0 && videoElement.muted) {
    videoElement.muted = false;
  }
  return getPlaybackState();
}
