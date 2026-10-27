import { page } from "./state";
import { removeImmersionHud, updateImmersionHud } from "./hud";
import { applyListenFirstClass, checkListenFirst, closeListenCard, prepareListenFirst } from "./listen-first";
import { checkMandalaStatusForCurrentPage } from "./mandala";
import { getVideoIdFromLocation, readMetadataFromDom, scheduleRead } from "./metadata";
import { checkSentencePlayback, loadImmersionTranscript, playSentence } from "./sentences";
import { injectImmersionStyles } from "./styles";

export function initializeWatchPageFeatures(context: {
  setTimeout: (handler: () => void, timeoutMilliseconds: number) => unknown;
}): void {
  const videoId = getVideoIdFromLocation();
  if (page.currentWatchVideoId !== videoId) {
    page.currentWatchVideoId = videoId;
    page.sessionWatchedSeconds = 0;
    page.lastWatchMediaTime = null;
    page.sentencePlayback = null;
    page.closeOpenClozeModal?.(false);
    closeListenCard?.(false);
    page.listenState = null;
    page.listenPreviousTime = null;
    page.listenVideoTally = { caught: 0, read: 0, missed: 0 };
  }

  injectImmersionStyles();
  applyListenFirstClass();
  if (page.listenFirst) void prepareListenFirst();
  void loadImmersionTranscript();
  void checkMandalaStatusForCurrentPage();
  void readMetadataFromDom().then((metadata) => {
    page.lastMetadata = metadata;
    updateImmersionHud();
  });

  if (!page.watchedTimerInterval) {
    page.lastWatchTickTimestamp = Date.now();
    page.watchedTimerInterval = setInterval(() => {
      const videoElement = document.querySelector("video");
      const currentTimestamp = Date.now();
      const elapsedMilliseconds = currentTimestamp - page.lastWatchTickTimestamp;
      page.lastWatchTickTimestamp = currentTimestamp;

      if (page.latestMandalaStatus.autoLogged && currentTimestamp - page.lastMandalaStatusCheck >= 60_000) {
        void checkMandalaStatusForCurrentPage();
      }

      if (videoElement && !videoElement.paused && elapsedMilliseconds > 0) {
        // Counted from how far the video moved, not the clock: a laptop asleep or a frozen tab leaves a
        // video "playing" for hours, and a seek is not watching.
        const mediaTime = videoElement.currentTime;
        const advancedSeconds = page.lastWatchMediaTime === null ? 0 : (mediaTime - page.lastWatchMediaTime) / (videoElement.playbackRate || 1);
        page.lastWatchMediaTime = mediaTime;
        if (advancedSeconds > 0 && advancedSeconds <= elapsedMilliseconds / 1000 + 1) {
          const minutesBefore = Math.floor(page.sessionWatchedSeconds / 60);
          page.sessionWatchedSeconds += advancedSeconds;
          if (Math.floor(page.sessionWatchedSeconds / 60) !== minutesBefore) {
            updateImmersionHud();
          }
        }

        checkSentencePlayback(videoElement);
        checkListenFirst(videoElement);
      } else {
        page.lastWatchMediaTime = null;
      }
    }, 100);
  }

  updateImmersionHud();
  scheduleRead(context);
}

export interface ClipRequest {
  videoId: string;
  startSeconds: number;
  endSeconds: number;
}

const CLIP_READY_TIMEOUT_MS = 10_000;

/** Plays one saved sentence for the desk's Practice page, then pauses. */
export async function playClip(clip: ClipRequest): Promise<{ success: boolean; errorMessage?: string }> {
  if (getVideoIdFromLocation() !== clip.videoId) return { success: false, errorMessage: "This tab shows another video." };
  const deadline = Date.now() + CLIP_READY_TIMEOUT_MS;
  let videoElement = document.querySelector("video");
  while ((!videoElement || videoElement.readyState < HTMLMediaElement.HAVE_METADATA) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    videoElement = document.querySelector("video");
  }
  if (!videoElement || videoElement.readyState < HTMLMediaElement.HAVE_METADATA) return { success: false, errorMessage: "The video did not load." };
  closeListenCard?.(false);
  page.closeOpenClozeModal?.(false);
  playSentence({ text: "", startSeconds: clip.startSeconds, endSeconds: clip.endSeconds }, { pauseAtEnd: true });
  try {
    await videoElement.play();
  } catch {
    return { success: false, errorMessage: "The browser blocked playback in that tab." };
  }
  return { success: true };
}

export function teardownWatchPageFeatures(): void {
  removeImmersionHud();
  page.closeOpenClozeModal?.(false);
  closeListenCard?.(false);
  applyListenFirstClass();
  page.sentencePlayback = null;
}
