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

/** "2 h 14 min", "14 min", "45 s" — for headlines, not tables. */
export function formatDurationWords(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return `${minutes} min`;
  return `${total} s`;
}

export function formatShortDuration(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

/** Queue offset label: "now" for zero, else "+10 min" / "+1 h 33". */
export function formatOffset(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  if (total < 60) return "next";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `+${hours} h ${minutes.toString().padStart(2, "0")}`;
  return `+${minutes} min`;
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
    if (urlObj.hostname === "youtu.be" || urlObj.hostname.endsWith(".youtu.be")) {
      const segment = urlObj.pathname.replace(/^\//, "").split("/")[0];
      return segment || null;
    }
    if (urlObj.pathname.startsWith("/shorts/")) {
      const m = urlObj.pathname.match(/\/shorts\/([^/?]+)/);
      return m ? m[1] : null;
    }
    return urlObj.searchParams.get("v");
  } catch {
    return null;
  }
}

export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function isYoutubeWatchOrShortsUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const urlObject = new URL(rawUrl);
    const hostname = urlObject.hostname.toLowerCase();
    const pathname = urlObject.pathname;

    const isYoutubeHost = hostname === "youtube.com" || hostname.endsWith(".youtube.com");
    if (isYoutubeHost) {
      return pathname.startsWith("/watch") || pathname.startsWith("/shorts");
    }

    const isShortHost = hostname === "youtu.be" || hostname.endsWith(".youtu.be");
    if (isShortHost) {
      return pathname.replace(/^\//, "").length > 0;
    }

    return false;
  } catch {
    return false;
  }
}

