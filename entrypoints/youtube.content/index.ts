/**
 * Content script that runs on YouTube watch/shorts pages.
 * Handles metadata caching, watch time, chapter extraction, transcript sentence navigation,
 * cloze capture, and in-player Mandala integration.
 */
import type { DetectedLanguage } from "../../utils/captionLanguage";
import type { VideoChannel } from "../../utils/channelLanguage";
import { requestVideoLanguage } from "../../utils/languageRequest";
import { registerBridgeListener } from "../../utils/webmcpBridge";
import { PLAYBACK_RATE_KEY } from "../../utils/playbackRate";
import { WatchSampler } from "../../utils/watchSampler";
import type { LimitWarning } from "../../utils/languageLimits";
import type { Recommendation } from "../../utils/recommendations";
import { LISTEN_FIRST_KEY } from "../../utils/listening";
import { page } from "./state";
import { updateImmersionHud } from "./hud";
import { applyListenFirstClass, closeListenCard, prepareListenFirst } from "./listen-first";
import { canonicalVideoUrl, checkMandalaStatusForCurrentPage } from "./mandala";
import { getVideoIdFromLocation, readMetadataFromDom, scheduleRead } from "./metadata";
import { getPlaybackState, isWatchOrShorts, setPlaybackVolume, togglePlayback } from "./playback";
import { mountShelfPopover } from "./shelf-popover";
import { handleGlobalKeydown } from "./shortcuts";
import { DEBOUNCE_MS, perf } from "./state";
import { LIMIT_TOAST_MS, limitWarningText, showImmersionToast, showLimitCard } from "./toasts";
import { type ClipRequest, initializeWatchPageFeatures, playClip, teardownWatchPageFeatures } from "./watch-page";

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  main(context) {
    // Media events don't bubble, so listen in the capture phase to catch every <video> YouTube swaps in.
    document.addEventListener(
      "ratechange",
      (event) => {
        const videoElement = event.target;
        if (!(videoElement instanceof HTMLVideoElement) || page.sentencePlayback?.restoreRate != null) return;
        void browser.storage.local.set({ [PLAYBACK_RATE_KEY]: videoElement.playbackRate });
      },
      true
    );
    registerBridgeListener({
      "get-open-tabs-catalog": () => browser.runtime.sendMessage({ action: "get-open-tabs-catalog" }),
      "stage-focused-study-queue": (payload) =>
        browser.runtime.sendMessage({ action: "stage-focused-study-queue", payload }),
      "clozemaster-list": (payload) =>
        browser.runtime.sendMessage({ action: "clozemaster-remote", op: "list", payload }),
      "clozemaster-add": (payload) =>
        browser.runtime.sendMessage({ action: "clozemaster-remote", op: "add", payload }),
      "get-staged-cloze-cards": () => browser.runtime.sendMessage({ action: "get-staged-cloze-cards" }),
      "clear-staged-cloze-cards": (payload) =>
        browser.runtime.sendMessage({
          action: "clear-staged-cloze-cards",
          ids: (payload as { ids?: unknown })?.ids,
        }),
      "get-saved-sessions": () => browser.runtime.sendMessage({ action: "get-saved-sessions" }),
      "open-saved-session": (payload) => browser.runtime.sendMessage({ action: "open-saved-session", payload }),
      "mandala-status": () =>
        browser.runtime.sendMessage({ action: "mandala-remote", op: "status", payload: { url: window.location.href } }),
      "mandala-save": async (payload) => {
        const { pillarIndex, kind } = (payload ?? {}) as { pillarIndex?: unknown; kind?: unknown };
        const response = (await browser.runtime.sendMessage({
          action: "mandala-remote",
          op: "save",
          payload: { pillarIndex, kind, url: canonicalVideoUrl(), title: page.lastMetadata.title || document.title },
        })) as { success?: boolean } | undefined;
        if (response?.success) void checkMandalaStatusForCurrentPage();
        return response;
      },
      "mandala-log": async (payload) => {
        const requestedMinutes = (payload as { minutes?: unknown } | undefined)?.minutes;
        const fromThisTab = requestedMinutes === undefined || requestedMinutes === null;
        const watchedMinutes = Math.floor(page.sessionWatchedSeconds / 60);
        if (fromThisTab && watchedMinutes < 1) {
          return {
            success: false,
            errorMessage: "Less than a minute of this video has been watched in this tab. Pass minutes to log a specific amount.",
          };
        }
        const response = (await browser.runtime.sendMessage({
          action: "mandala-remote",
          op: "log",
          payload: {
            url: window.location.href,
            minutes: fromThisTab ? watchedMinutes : requestedMinutes,
            videoTitle: page.lastMetadata.title,
          },
        })) as { success?: boolean } | undefined;
        if (response?.success && fromThisTab) {
          page.sessionWatchedSeconds = 0;
          updateImmersionHud();
        }
        return response;
      },
      "refine-language": (payload) => {
        const { detected, text, channelName, videoId } = payload as VideoChannel & {
          detected: DetectedLanguage;
          text: string;
        };
        return requestVideoLanguage(detected, text, { channelName, videoId }, document.documentElement.lang);
      },
    });

    browser.runtime.onMessage.addListener(
      (
        runtimeMessage: { action: string; reset?: boolean; volume?: number; refreshLanguage?: boolean },
        _sender: unknown,
        sendResponse: (responseResult: unknown) => void
      ) => {
        if (runtimeMessage?.action === "get-metadata") {
          const currentId = getVideoIdFromLocation();
          const needsRead =
            isWatchOrShorts() &&
            (currentId !== page.lastMetadata.videoId || runtimeMessage.refreshLanguage === true);
          if (!needsRead) {
            sendResponse(page.lastMetadata);
            return;
          }
          void readMetadataFromDom(runtimeMessage.refreshLanguage === true).then((metadata) => {
            page.lastMetadata = metadata;
            updateImmersionHud();
            sendResponse(metadata);
          });
          return true;
        }
        if (runtimeMessage?.action === "play-clip") {
          void playClip(runtimeMessage as unknown as ClipRequest).then(sendResponse);
          return true;
        }
        if (runtimeMessage?.action === "get-playback-state") {
          sendResponse(getPlaybackState());
          return;
        }
        if (runtimeMessage?.action === "toggle-play") {
          sendResponse(togglePlayback());
          return;
        }
        if (runtimeMessage?.action === "set-volume" && typeof runtimeMessage.volume === "number") {
          sendResponse(setPlaybackVolume(runtimeMessage.volume));
          return;
        }
        if (runtimeMessage?.action === "get-perf-stats") {
          const stats = {
            totalMutations: perf.totalMutations,
            totalReads: perf.totalReads,
            mutationsSinceLastRead: perf.mutationsSinceLastRead,
            debounceMs: DEBOUNCE_MS,
            ratio: perf.totalReads > 0 ? (perf.totalMutations / perf.totalReads).toFixed(1) : "—",
          };
          if (runtimeMessage.reset) {
            perf.totalMutations = 0;
            perf.totalReads = 0;
            perf.mutationsSinceLastRead = 0;
          }
          sendResponse(stats);
        }
      }
    );

    new WatchSampler({
      videoId: () => (isWatchOrShorts() ? getVideoIdFromLocation() : null),
      metadata: () => page.lastMetadata,
      send: async (sample) => {
        const response = (await browser.runtime.sendMessage({ action: "watch-sample", sample })) as
          | { limitWarnings?: LimitWarning[]; recommendations?: Recommendation[] }
          | undefined;
        const warnings = response?.limitWarnings ?? [];
        const over = warnings.find((warning) => warning.level === "over");
        if (over && response?.recommendations?.length) showLimitCard(over, response.recommendations);
        else if (warnings[0]) showImmersionToast(limitWarningText(over ?? warnings[0]), LIMIT_TOAST_MS);
        return response;
      },
    }).start(context);

    context.addEventListener(window, "keydown", handleGlobalKeydown, { capture: true });

    void browser.storage.local.get(LISTEN_FIRST_KEY).then((stored) => {
      page.listenFirst = stored[LISTEN_FIRST_KEY] === true;
      applyListenFirstClass();
      updateImmersionHud();
      if (page.listenFirst && isWatchOrShorts()) void prepareListenFirst();
    });
    browser.storage.onChanged.addListener((changes, area) => {
      const change = changes[LISTEN_FIRST_KEY];
      if (area !== "local" || !change || change.newValue === page.listenFirst) return;
      page.listenFirst = change.newValue === true;
      if (!page.listenFirst) closeListenCard?.(false);
      applyListenFirstClass();
      updateImmersionHud();
    });

    document.addEventListener("click", () => {
      if (page.isPillarPopoverOpen) {
        page.isPillarPopoverOpen = false;
        page.popoverPillarIndex = null;
        updateImmersionHud();
      }
    });
    const repositionShelfPopover = () => {
      const popover = document.getElementById("study-harvester-shelf-popover");
      if (popover instanceof HTMLElement) mountShelfPopover(popover);
    };
    context.addEventListener(window, "scroll", repositionShelfPopover, true);
    context.addEventListener(window, "resize", repositionShelfPopover);
    context.addEventListener(document, "fullscreenchange", repositionShelfPopover);

    const handleNavigation = () => {
      if (isWatchOrShorts()) {
        initializeWatchPageFeatures(context);
      } else {
        teardownWatchPageFeatures();
      }
    };

    context.addEventListener(window, "popstate", handleNavigation);
    context.addEventListener(window, "hashchange", handleNavigation);
    context.addEventListener(document, "yt-navigate-finish", handleNavigation);

    const target =
      document.querySelector("#primary") ||
      document.querySelector("#content") ||
      document.body;
    if (target) {
      const observer = new MutationObserver(() => {
        perf.totalMutations++;
        perf.mutationsSinceLastRead++;
        scheduleRead(context);
      });

      observer.observe(target, {
        childList: true,
        subtree: false,
      });
    }

    const titleElement = document.querySelector("title");
    if (titleElement) {
      const titleObserver = new MutationObserver(() => {
        perf.totalMutations++;
        perf.mutationsSinceLastRead++;
        scheduleRead(context);
      });
      titleObserver.observe(titleElement, { childList: true });
    }

    context.addEventListener(document, "durationchange", () => scheduleRead(context), true);
    context.addEventListener(document, "loadedmetadata", () => scheduleRead(context), true);

    if (isWatchOrShorts()) {
      initializeWatchPageFeatures(context);
      perf.totalReads++;
      scheduleRead(context);
    }
  },
});
