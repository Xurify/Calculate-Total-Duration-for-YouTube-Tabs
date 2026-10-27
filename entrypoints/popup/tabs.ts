import { lookupCachedMetadata, requestMetadataUpdate, loadPrefsAndMetadataCache } from "../../utils/storage";
import { getVideoIdFromUrl } from "../../utils/format";
import { popup } from "./state";
import {
  clearLastPlayingTabId,
  isVideoEligibleForNowPlaying,
  loadLastPlayingTabId,
  persistLastPlayingTabId,
  refreshNowPlayingDetection,
} from "./now-playing";
import { flushProbeRender, render, scheduleProbeRender } from "./render";
import { resetVideoListFingerprint } from "./video-list";
import {
  applyCachedMetadataToVideo,
  applyPlaybackTimeToVideo,
  applyProbedMetadataToVideo,
  buildMetadataForCache,
  buildVideoFromTab,
  persistVideoPlaybackToCache,
} from "./videos";

const SYNC_COOLDOWN_MS = 30_000;
let lastSyncTime = 0;

export async function getYouTubeTabs(): Promise<void> {
  try {
    // Straight from storage: asking the background would first wake its service worker, which is usually asleep
    // when the popup opens. Later changes still arrive as store-updated patches.
    const [state, allTabs, currentWindow] = await Promise.all([
      loadPrefsAndMetadataCache(),
      browser.tabs.query({}),
      browser.windows.getCurrent(),
    ]);
    popup.storeState = state;
    const { prefs, metadataCache } = popup.storeState;

    popup.popupWindowId = currentWindow.id ?? null;
    popup.sortByDuration = prefs.sortByDuration;

    const tabs = allTabs.filter((tab) => {
      if (!tab.url) return false;
      try {
        const url = new URL(tab.url);
        return (
          (url.hostname.endsWith("youtube.com") || url.hostname === "youtube.com") &&
          (url.pathname.startsWith("/watch") || url.pathname.startsWith("/shorts")) &&
          !tab.url.includes("exclude_blobs")
        );
      } catch {
        return false;
      }
    });

    resetVideoListFingerprint();
    popup.resolvedNowPlayingTabIds = [];
    popup.pinnedNowPlayingTabId = null;
    popup.videoData = tabs.map((tab, index) => {
      const video = buildVideoFromTab(tab, index, prefs.excludedUrls);
      const cached = lookupCachedMetadata(metadataCache, video.url);
      if (cached) applyCachedMetadataToVideo(video, cached);
      return video;
    });

    if (popup.popupWindowId != null) {
      popup.lastPlayingTabId = await loadLastPlayingTabId(popup.popupWindowId);
      const audibleInWindow = popup.videoData.filter(
        (video) =>
          !video.excluded &&
          !video.suspended &&
          video.windowId === popup.popupWindowId &&
          video.audible
      );
      if (audibleInWindow.length > 0) {
        const playing = audibleInWindow[0];
        if (playing) await persistLastPlayingTabId(playing.id);
      } else if (popup.lastPlayingTabId) {
        const last = popup.videoData.find((video) => video.id === popup.lastPlayingTabId);
        if (!isVideoEligibleForNowPlaying(last)) {
          await clearLastPlayingTabId();
        }
      }
    }

    render();

    const activeTabPromises = popup.videoData.map(async (video) => {
      if (video.suspended) return;

      const hasValidMetadata = video.seconds > 0 &&
                               video.title !== "YouTube Video" &&
                               video.title !== "YouTube" &&
                               !/^\(\d+\)\s*/.test(video.title);

      // Inactive tabs: still refresh playback position from cache estimate, or light probe
      if (hasValidMetadata && !video.active && !video.audible) {
        return;
      }

      const expectedVideoId = getVideoIdFromUrl(video.url);

      try {
        const contentMeta = await browser.tabs.sendMessage(video.id, { action: "get-metadata" }).catch(() => null);
        if (
          contentMeta &&
          contentMeta.videoId != null &&
          contentMeta.videoId === expectedVideoId &&
          contentMeta.title &&
          (contentMeta.seconds > 0 || contentMeta.isLive)
        ) {
          applyProbedMetadataToVideo(video, {
            title: contentMeta.title,
            channelName: contentMeta.channelName || "",
            seconds: contentMeta.seconds,
            currentTime: contentMeta.currentTime,
            isLive: contentMeta.isLive,
            paused: contentMeta.paused,
            volume: contentMeta.volume,
            muted: contentMeta.muted,
          });
          requestMetadataUpdate(video.url, buildMetadataForCache(video, expectedVideoId ?? undefined));
          scheduleProbeRender();
          return;
        }
      } catch {
        // No content script (e.g. tab loaded before extension) — fall through to inject
      }



      try {
        const results = await browser.scripting.executeScript({
          target: { tabId: video.id },
          world: "MAIN",
          args: [hasValidMetadata],
          func: (hasMetadata: boolean) => {
            const videoElement = document.querySelector("video");
            const currentTime = videoElement ? videoElement.currentTime : 0;
            const volume = videoElement ? videoElement.volume : 1;
            const muted = videoElement ? videoElement.muted : false;
            const paused = videoElement ? videoElement.paused : true;

            // Current video ID: watch ?v= or Shorts /shorts/VIDEO_ID
            const shortsMatch = window.location.pathname.match(/^\/shorts\/([^/?]+)/);
            const currentVideoId =
              new URLSearchParams(window.location.search).get("v") ||
              (shortsMatch ? shortsMatch[1] : null) ||
              null;

            // @ts-ignore - Get ytInitialPlayerResponse for SPA detection
            const playerResponse = window.ytInitialPlayerResponse;
            const playerVideoId = playerResponse?.videoDetails?.videoId;
            
            // CRITICAL: Detect SPA navigation mismatch - ytInitialPlayerResponse has stale video ID
            const isSpaTransition = playerVideoId && currentVideoId && playerVideoId !== currentVideoId;

            if (hasMetadata && !isSpaTransition) {
              return { currentTime, volume, muted, paused, skipMetadata: true };
            }

            // If SPA transition detected, return a special flag to invalidate any cached data
            if (isSpaTransition) {
              return {
                currentTime,
                volume,
                muted,
                paused,
                spaTransition: true,
                currentVideoId,
                skipMetadata: false
              };
            }

            const channel =
              (document.querySelector("#upload-info #channel-name a") as HTMLElement)?.innerText ||
              (document.querySelector(".ytd-video-owner-renderer #channel-name a") as HTMLElement)?.innerText ||
              "";

            let duration = 0;
            let isLive = false;
            let videoDetails = playerResponse?.videoDetails;

            try {
              if (videoDetails) {
                isLive = videoDetails.isLive === true;
                const liveDetails = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
                if (liveDetails && !liveDetails.endTimestamp) isLive = true;

                const lengthSeconds = parseInt(videoDetails.lengthSeconds) || 0;
                if (lengthSeconds > 0) {
                  isLive = false;
                  duration = lengthSeconds;
                }
              }

              // Shorts fallback 1: duration from ytInitialPlayerResponse.streamingData (formats/adaptiveFormats)
              if (duration === 0 && window.location.pathname.startsWith("/shorts/")) {
                try {
                  const sd = playerResponse && playerResponse.streamingData;
                  const formats = sd && sd.formats;
                  const adaptive = sd && sd.adaptiveFormats;
                  const firstFormat = (formats && formats[0]) || (adaptive && adaptive[0]);
                  const ms = firstFormat && firstFormat.approxDurationMs;
                  if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
                } catch (_) {}
              }
              // Shorts fallback 2: duration from ytInitialData (reelWatchEndpoint or other path)
              if (duration === 0 && window.location.pathname.startsWith("/shorts/")) {
                try {
                  // @ts-ignore
                  const d = window.ytInitialData;
                  const ms = d && d.contents && d.contents.reelWatchEndpoint && d.contents.reelWatchEndpoint.approxDurationMs;
                  if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
                } catch (_) {}
              }

              if (!isLive) {
                const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
                if (liveBadge && !liveBadge.hasAttribute("disabled") && getComputedStyle(liveBadge).display !== "none") {
                  isLive = true;
                }
              }

              // Consolidate title extraction
              let title = videoDetails?.title || 
                (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
                (document.querySelector("h1.title.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
                (document.querySelector(".ytd-video-primary-info-renderer h1") as HTMLElement)?.innerText ||
                (document.querySelector("ytd-video-primary-info-renderer #container h1") as HTMLElement)?.innerText ||
                document.title;

              // Clean title: remove any notification prefixes like "(1) " or "(1030) "
              title = title.replace(/^\(\d+\)\s*/g, "");
              title = title.replace(" - YouTube", "").trim();

              return {
                duration: isLive ? 0 : duration || videoElement?.duration || 0,
                currentTime,
                channelName: channel || videoDetails?.author || "",
                title: title || "YouTube Video",
                isLive,
                paused,
                volume,
                muted,
                skipMetadata: false
              };
            } catch (error) {
               // Fallback if playerResponse access fails or other error
               return {
                 duration: videoElement?.duration || 0,
                 currentTime,
                 channelName: channel,
                 title: document.title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim() || "YouTube Video",
                 isLive: false,
                 paused,
                 volume,
                 muted,
                 skipMetadata: false
               };
            }
          },
        });

        if (results[0]?.result) {
          const result = results[0].result;
          
          // SPA transition: content script observer will have updated; ask it for metadata (retry once after 500ms)
          if (result.spaTransition) {
            applyPlaybackTimeToVideo(video, result.currentTime || 0);
            const expectedId = getVideoIdFromUrl(video.url);
            const tryContentScript = async (): Promise<boolean> => {
              const meta = await browser.tabs.sendMessage(video.id, { action: "get-metadata" }).catch(() => null);
              if (meta?.videoId === expectedId && meta?.title && (meta.seconds > 0 || meta.isLive)) {
                applyProbedMetadataToVideo(video, {
                  title: meta.title,
                  channelName: meta.channelName ?? "",
                  seconds: meta.seconds,
                  currentTime: meta.currentTime ?? 0,
                  isLive: meta.isLive ?? false,
                  paused: meta.paused,
                  volume: meta.volume,
                  muted: meta.muted,
                });
                if (video.seconds > 0 || video.isLive) {
                  requestMetadataUpdate(video.url, buildMetadataForCache(video, expectedId ?? undefined));
                }
                scheduleProbeRender();
                return true;
              }
              return false;
            };
            if (await tryContentScript()) return;
            await new Promise((r) => setTimeout(r, 500));
            if (await tryContentScript()) return;
            return;
          }
          
          if (result.skipMetadata) {
            applyProbedMetadataToVideo(video, {
              currentTime: result.currentTime || 0,
              volume: result.volume,
              muted: result.muted,
              paused: result.paused,
            });
            if (!video.isLive && video.seconds > 0) {
              persistVideoPlaybackToCache(video);
            }
            scheduleProbeRender();
          } else {
            const duration = result.duration || 0;

            const hasValidTitle = result.title && result.title !== "Loading..." && result.title !== "YouTube Video";
            if (hasValidTitle || duration > 0 || result.isLive) {
              applyProbedMetadataToVideo(video, {
                title: result.title || video.title,
                channelName: result.channelName || video.channelName,
                seconds: duration,
                currentTime: result.currentTime || 0,
                isLive: result.isLive || false,
                volume: result.volume,
                muted: result.muted,
                paused: result.paused,
              });

              if (duration > 0 || result.isLive) {
                requestMetadataUpdate(video.url, buildMetadataForCache(video, expectedVideoId ?? undefined));
              }
              scheduleProbeRender();
            }
          }
        }
      } catch (error: any) {
        const errorMsg = error?.message || "";
        const isExpectedError =
          errorMsg.includes("permissions") ||
          errorMsg.includes("Cannot access") ||
          errorMsg.includes("Extension context invalidated");

        if (!isExpectedError) {
          console.warn(`Failed to probe tab ${video.id}:`, error);
        }
        scheduleProbeRender();
      }
    });
    await Promise.all(activeTabPromises);
    await refreshNowPlayingDetection();
    flushProbeRender();

    // After probing: auto-fetch durations for any tab still missing it (suspended or probe failed). Background skips when cache is fresh.
    const tabsWithoutDuration = popup.videoData.filter((v) => v.seconds === 0 && !v.isLive);
    if (tabsWithoutDuration.length > 0 && Date.now() - lastSyncTime >= SYNC_COOLDOWN_MS) {
      lastSyncTime = Date.now();
      browser.runtime
        .sendMessage({
          action: "sync-all",
          tabs: tabsWithoutDuration.map((v) => ({ id: v.id, url: v.url })),
        })
        .catch(() => {});
    }
  } catch (error: any) {
    console.error("Error scanning tabs:", error);
    const app = document.getElementById("app")!;
    app.innerHTML = `
      <div class="p-8 text-center">
        <div class="text-2xl mb-3 opacity-40">⚠️</div>
        <div class="text-sm text-text-secondary mb-1">Something went wrong</div>
        <div class="text-[10px] text-accent font-mono break-all px-4">${error?.message || "Unknown error"}</div>
        <div class="text-[10px] text-text-muted mt-4">Try refreshing your YouTube tabs</div>
      </div>
    `;
  }
}
