/**
 * Shared time formatting and URL helpers for popup and manager.
 */

export function formatTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function formatCompact(totalSeconds: number): string {
  return formatTime(totalSeconds);
}

export function parseTimeParam(url: string): number {
  try {
    const urlObj = new URL(url);
    const timeParam = urlObj.searchParams.get("t") || urlObj.searchParams.get("time_continue");
    if (!timeParam) return 0;
    if (timeParam.match(/[hms]/)) {
      const h = parseInt(timeParam.match(/(\d+)h/)?.[1] || "0");
      const m = parseInt(timeParam.match(/(\d+)m/)?.[1] || "0");
      const s = parseInt(timeParam.match(/(\d+)s/)?.[1] || "0");
      return h * 3600 + m * 60 + s;
    }
    return parseInt(timeParam) || 0;
  } catch {
    return 0;
  }
}

export function getVideoIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    if (urlObj.pathname.startsWith("/shorts/")) {
      const m = urlObj.pathname.match(/\/shorts\/([^/?]+)/);
      return m ? m[1] : null;
    }
    return urlObj.searchParams.get("v");
  } catch {
    return null;
  }
}
