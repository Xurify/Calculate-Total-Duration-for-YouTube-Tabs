import type { CachedMandalaAction, MandalaStatus } from "../../utils/storage";
import { page } from "./state";
import { updateImmersionHud } from "./hud";
import { getVideoIdFromLocation } from "./metadata";
import { truncateText } from "./sentences";
import { showImmersionToast } from "./toasts";

export async function checkMandalaStatusForCurrentPage(): Promise<void> {
  page.lastMandalaStatusCheck = Date.now();
  try {
    const status = (await browser.runtime.sendMessage({
      action: "check-mandala-status",
      url: window.location.href,
    })) as MandalaStatus;

    if (status && typeof status === "object") {
      page.latestMandalaStatus = status;
      updateImmersionHud();
    }
  } catch {
    // Background unavailable or extension reloading
  }
}

export function canonicalVideoUrl(): string {
  const videoId = getVideoIdFromLocation();
  if (!videoId) return window.location.href;
  return window.location.pathname.startsWith("/shorts/")
    ? `https://www.youtube.com/shorts/${videoId}`
    : `https://www.youtube.com/watch?v=${videoId}`;
}

export function pillarTitleAt(pillarIndex: number): string {
  return (
    page.latestMandalaStatus.pillars.find((pillar) => pillar.index === pillarIndex)?.title || `Pillar ${pillarIndex + 1}`
  );
}

export async function quickLogWatchedTimeToMandala(): Promise<void> {
  const watchedMinutes = Math.max(1, Math.floor(page.sessionWatchedSeconds / 60));

  try {
    const response = (await browser.runtime.sendMessage({
      action: "log-mandala-time",
      payload: {
        url: window.location.href,
        minutes: watchedMinutes,
        videoTitle: page.lastMetadata.title,
      },
    })) as { success: boolean; queued?: boolean; actionText?: string; errorMessage?: string };

    if (!response?.success) {
      showImmersionToast(response?.errorMessage || "Couldn't log time to Mandala. Try again in a moment.");
      return;
    }
    page.sessionWatchedSeconds = 0;
    updateImmersionHud();
    showImmersionToast(
      response.queued
        ? `Logged ${watchedMinutes} min. It reaches Mandala next time you open it.`
        : `Logged ${watchedMinutes} min on “${truncateText(response.actionText || "", 40)}”`
    );
  } catch {
    showImmersionToast("Couldn't log time to Mandala. Try again in a moment.");
  }
}

export async function saveCurrentVideoToMandalaShelf(pillarIndex: number, action?: CachedMandalaAction): Promise<void> {
  const pillarTitle = pillarTitleAt(pillarIndex);
  const destination = action ? `“${truncateText(action.text, 40)}”` : pillarTitle;
  try {
    const response = (await browser.runtime.sendMessage({
      action: "save-mandala-shelf-link",
      payload: {
        pillarIndex,
        url: canonicalVideoUrl(),
        title: page.lastMetadata.title || document.title,
        kind: "repeat",
        action: action?.id,
      },
    })) as { success: boolean; queued?: boolean; errorMessage?: string };

    if (!response?.success) {
      showImmersionToast(response?.errorMessage || "Couldn't save to the shelf. Try again in a moment.");
      return;
    }
    page.latestMandalaStatus.savedPillarIndexes = [...new Set([...page.latestMandalaStatus.savedPillarIndexes, pillarIndex])].sort(
      (first, second) => first - second
    );
    updateImmersionHud();
    showImmersionToast(
      response.queued
        ? `Saved to ${destination}. It reaches Mandala next time you open it.`
        : action
          ? `Time on this video now goes to ${destination}`
          : `Saved to ${pillarTitle}'s shelf`
    );
    void checkMandalaStatusForCurrentPage();
  } catch {
    showImmersionToast("Couldn't save to the shelf. Try again in a moment.");
  }
}
