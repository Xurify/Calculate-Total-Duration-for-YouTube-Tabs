import {
  VideoData,
  lookupCachedMetadata,
  normalizeYoutubeUrl,
  CachedMetadata,
  requestMetadataUpdate,
  getLiveTabSections,
} from "../../utils/storage";
import { applyStorePatch, fetchStoreState, type StoreUpdatedMessage, type StoreState } from "../../utils/store";
import { parseTimeParam, getVideoIdFromUrl, isYoutubeWatchOrShortsUrl } from "../../utils/format";
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  normalizeLanguageCode,
} from "../../utils/captionLanguage";
import { requestVideoLanguage } from "../../utils/languageRequest";
import { app } from "./state";
import { requestMissingChannelAvatars } from "./avatars";
import { renderFacetRail } from "./facets";
import { tabListStructureFingerprint } from "./fingerprint";
import {
  render,
  updateCurrentViewStatsFromState,
  updateLiveTabListCardsFromState,
  updateTabListAggregateHeadersFromState,
} from "./render";
import { updateSelectionUI } from "./selection";
import { renderSidebar } from "./sidebar";
import { pageLanguageConfirmed } from "./state";

let probeUiRaf: number | null = null;

export let storeState: StoreState = {
  prefs: {
    sortByDuration: false,
    excludedUrls: [],
    thumbnailQuality: "high",
    layoutMode: "grid",
    groupingMode: "none",
    sortOption: "started-first",
  },
  metadataCache: {},
};

function applyPrefsFromStore(): void {
  const { prefs } = storeState;
  app.thumbnailQuality = prefs.thumbnailQuality;
  app.groupingMode = prefs.groupingMode;
  app.layoutMode = prefs.layoutMode;
  app.sortOption = prefs.sortOption;
  app.sortSelectHandle?.setValue(app.sortOption);
}

function applyStoreMetadataToVideos(): void {
  const { prefs, metadataCache } = storeState;
  app.allVideos.forEach((video) => {
    video.excluded = prefs.excludedUrls.includes(normalizeYoutubeUrl(video.url));
    const cached = lookupCachedMetadata(metadataCache, video.url);
    if (cached) applyCachedMetadataToVideo(video, cached);
  });
}

export function handleStoreUpdated(message: StoreUpdatedMessage): void {
  applyStorePatch(storeState, message);
  if (message.prefs) applyPrefsFromStore();
  if (app.allVideos.length > 0 && (message.prefs || message.metadataCache || message.metadataPatch)) {
    applyStoreMetadataToVideos();
    scheduleProbeResultsToUi();
  }
}

function titleFromTab(tab: Browser.tabs.Tab): string {
  const raw = tab.title?.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();
  return raw && raw !== "YouTube" ? raw : "YouTube Video";
}

function applyCachedMetadataToVideo(video: VideoData, cached: CachedMetadata): void {
  video.title = cached.title || video.title;
  video.channelName = cached.channelName || "";
  video.seconds = cached.seconds || 0;
  video.isLive = cached.isLive || false;
  video.language = cached.language;
  video.languageName = cached.languageName;
  video.chapters = cached.chapters;
}

export function getThumbnailSrc(videoId: string | null, quality: string): string {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/${quality}` : "";
}

export async function fetchTabs(skipInitialRender = false) {
  const tabIdsBefore = skipInitialRender
    ? app.allVideos
        .map((video) => video.id)
        .sort((a, b) => a - b)
        .join(",")
    : "";

  const [state, allTabs, sectionsState] = await Promise.all([
    fetchStoreState(),
    browser.tabs.query({}),
    getLiveTabSections(),
  ]);
  storeState = state;
  const { prefs, metadataCache: metadataRecord } = storeState;

  applyPrefsFromStore();
  app.liveTabSectionsState = sectionsState;

  const youtubeTabs = allTabs.filter(tab => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url)));

  const oldVideosMap = new Map<number, VideoData>();
  app.allVideos.forEach((video) => {
    if (video.id) oldVideosMap.set(video.id, video);
  });

  app.allVideos = youtubeTabs.map((tab, index) => {
    const url = tab.url!;
    const normalizedUrl = normalizeYoutubeUrl(url);
    const video: VideoData = {
      id: tab.id || 0,
      title: titleFromTab(tab),
      channelName: "",
      seconds: 0,
      currentTime: parseTimeParam(url),
      excluded: prefs.excludedUrls.includes(normalizedUrl),
      index,
      url,
      suspended: tab.discarded || false,
      active: tab.active,
      audible: tab.audible || false,
      isLive: false,
      windowId: tab.windowId,
    };

    const oldVideo = oldVideosMap.get(video.id);
    if (oldVideo && normalizeYoutubeUrl(oldVideo.url) === normalizedUrl) {
      video.title = oldVideo.title;
      video.channelName = oldVideo.channelName;
      video.seconds = oldVideo.seconds;
      video.currentTime = oldVideo.currentTime;
      video.isLive = oldVideo.isLive;
      video.language = oldVideo.language;
      video.languageName = oldVideo.languageName;
      video.videoId = oldVideo.videoId;
      video.audible = oldVideo.audible;
      video.paused = oldVideo.paused;
      video.chapters = oldVideo.chapters;
    } else {
      const cached = lookupCachedMetadata(metadataRecord, url);
      if (cached) applyCachedMetadataToVideo(video, cached);
    }
    return video;
  });

  const groups = new Map<number, VideoData[]>();
  app.allVideos.forEach(video => {
    const windowId = video.windowId;
    if (windowId === undefined) return;
    if (!groups.has(windowId)) groups.set(windowId, []);
    groups.get(windowId)!.push(video);
  });

  const windows = await browser.windows.getAll();
  app.windowGroups = windows
    .filter(window => groups.has(window.id!))
    .map((window, windowIndex) => {
      const tabs = groups.get(window.id!) || [];
      const duration = tabs.reduce((accumulator, video) => accumulator + video.seconds, 0);
      return {
        id: window.id!,
        tabs,
        duration,
        label: `Window ${windowIndex + 1}`
      };
    })
    .sort((a, b) => b.tabs.length - a.tabs.length);

  const tabIdsAfter = app.allVideos
    .map((video) => video.id)
    .sort((a, b) => a - b)
    .join(",");
  const tabsStructureChanged = skipInitialRender && tabIdsBefore !== tabIdsAfter;

  if (!skipInitialRender || tabsStructureChanged) render();
  await probeTabsMetadata();

  const tabsWithoutDuration = app.allVideos.filter((video) => (video.seconds === 0 && !video.isLive) || video.language === undefined);
  if (tabsWithoutDuration.length > 0 && Date.now() - lastSyncTime >= SYNC_COOLDOWN_MS) {
    lastSyncTime = Date.now();
    browser.runtime
      .sendMessage({
        action: "sync-all",
        tabs: tabsWithoutDuration.map((video) => ({ id: video.id, url: video.url })),
      })
      .catch(() => {});
  }
}

function recomputeWindowGroupDurations(): void {
  for (const group of app.windowGroups) {
    group.duration = group.tabs.reduce((accumulator, video) => accumulator + video.seconds, 0);
  }
}

export function scheduleProbeResultsToUi(): void {
  if (probeUiRaf != null) return;
  probeUiRaf = requestAnimationFrame(() => {
    probeUiRaf = null;
    applyProbeResultsToUi();
  });
}

/** Coalesced metadata updates: patch cards in place; full rebuild only when layout structure changes. */
function applyProbeResultsToUi(): void {
  recomputeWindowGroupDurations();
  requestMissingChannelAvatars();

  const nextStructureFp = tabListStructureFingerprint();
  if (!app.selectedSession && nextStructureFp !== app.lastTabListFingerprint) {
    render();
    return;
  }

  updateLiveTabListCardsFromState();
  updateTabListAggregateHeadersFromState();
  updateCurrentViewStatsFromState();
  // Languages and channels arrive with the metadata, so the facet counts change even when the list layout doesn't.
  renderFacetRail();
  renderSidebar();
  updateSelectionUI();
}

function hasValidCoreMetadata(video: VideoData): boolean {
  return (
    video.seconds > 0 &&
    video.title !== "YouTube Video" &&
    video.title !== "YouTube" &&
    !/^\(\d+\)\s*/.test(video.title)
  );
}

function languageMetadataChanged(
  video: VideoData,
  language: string | null | undefined,
  languageName: string | null | undefined
): boolean {
  if (language === undefined) return false;
  if (video.language == null && language == null) {
    return video.languageName !== languageName;
  }
  if (video.language == null || language == null) return true;
  if (normalizeLanguageCode(video.language) !== normalizeLanguageCode(language)) return true;
  return (video.languageName ?? "") !== (languageName ?? "");
}

function persistVideoMetadata(video: VideoData, expectedVideoId: string | null | undefined): void {
  requestMetadataUpdate(video.url, {
    seconds: video.seconds,
    title: video.title,
    channelName: video.channelName,
    currentTime: video.currentTime,
    isLive: video.isLive,
    videoId: expectedVideoId ?? undefined,
    language: video.language,
    languageName: video.languageName,
  });
}

function applyLanguageMetadata(
  video: VideoData,
  language: string | null | undefined,
  languageName: string | null | undefined,
  expectedVideoId: string | null | undefined
): boolean {
  if (language === undefined) return false;
  const changed = languageMetadataChanged(video, language, languageName);
  video.language = language;
  video.languageName = languageName;
  if (changed) persistVideoMetadata(video, expectedVideoId);
  return changed;
}

async function probeTabsMetadata() {
  const activeTabPromises = app.allVideos.map(async (video) => {
    if (video.suspended) return;

    const expectedVideoId = getVideoIdFromUrl(video.url);
    const hasCore = hasValidCoreMetadata(video);
    const pageLanguageKey = `${video.id}:${expectedVideoId ?? ""}`;
    const needPageLanguage = !pageLanguageConfirmed.has(pageLanguageKey);
    const skipHeavyProbe =
      hasCore && !needPageLanguage && !video.active && !video.audible;

    try {
      const contentMeta = await browser.tabs
        .sendMessage(video.id, { action: "get-metadata", refreshLanguage: true })
        .catch(() => null);

      if (contentMeta?.videoId != null && contentMeta.videoId === expectedVideoId) {
        applyLanguageMetadata(
          video,
          contentMeta.language,
          contentMeta.languageName,
          expectedVideoId
        );

        if (contentMeta.title && (contentMeta.seconds > 0 || contentMeta.isLive)) {
          const isPlaceholder = (title: string) =>
            !title || title === "YouTube Video" || title === "YouTube";
          video.title = isPlaceholder(contentMeta.title)
            ? video.title || contentMeta.title
            : contentMeta.title;
          video.channelName = contentMeta.channelName || "";
          video.seconds = contentMeta.seconds;
          video.currentTime = contentMeta.currentTime;
          video.isLive = contentMeta.isLive;
          persistVideoMetadata(video, expectedVideoId);
        }

        if (skipHeavyProbe) return;
      }
    } catch {
      // No content script — fall through to inject
    }

    if (skipHeavyProbe) return;

    try {
      const results = await browser.scripting.executeScript({
        target: { tabId: video.id },
        world: "MAIN",
        args: [hasCore],
        func: (hasMetadata: boolean) => {
          const videoElement = document.querySelector("video");
          const currentTime = videoElement ? videoElement.currentTime : 0;

          const shortsMatch = window.location.pathname.match(/^\/shorts\/([^/?]+)/);
          const currentVideoId =
            new URLSearchParams(window.location.search).get("v") ||
            (shortsMatch ? shortsMatch[1] : null) ||
            null;

          // @ts-ignore - Get ytInitialPlayerResponse for SPA detection
          const playerResponse = window.ytInitialPlayerResponse;
          const playerVideoId = playerResponse?.videoDetails?.videoId;

          const isSpaTransition =
            playerVideoId && currentVideoId && playerVideoId !== currentVideoId;

          const readLanguageSource = () => {
            if (!playerResponse) return undefined;
            const micro = playerResponse?.microformat?.playerMicroformatRenderer;
            const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer;
            const mapFormats = (list: Array<{ audioTrack?: { id?: string; displayName?: string; audioIsDefault?: boolean; isAutoDubbed?: boolean } }> | undefined) =>
              (list || [])
                .filter((format) => format?.audioTrack?.id)
                .map((format) => ({
                  audioTrack: {
                    id: format.audioTrack?.id,
                    displayName: format.audioTrack?.displayName,
                    audioIsDefault: format.audioTrack?.audioIsDefault,
                    isAutoDubbed: format.audioTrack?.isAutoDubbed,
                  },
                }));

            return {
              videoDetails: {
                defaultAudioLanguageCode: playerResponse?.videoDetails?.defaultAudioLanguageCode,
                defaultLanguage: playerResponse?.videoDetails?.defaultLanguage,
                videoId: playerResponse?.videoDetails?.videoId as string | undefined,
                author: playerResponse?.videoDetails?.author as string | undefined,
                title: playerResponse?.videoDetails?.title as string | undefined,
                shortDescription: playerResponse?.videoDetails?.shortDescription as string | undefined,
              },
              uiLanguage: document.documentElement.lang,
              microformat: {
                playerMicroformatRenderer: {
                  defaultAudioLanguage: micro?.defaultAudioLanguage,
                  defaultLanguage: micro?.defaultLanguage,
                },
              },
              captions: renderer
                ? {
                    playerCaptionsTracklistRenderer: {
                      captionTracks: (renderer.captionTracks || []).map((track: {
                        kind?: string;
                        languageCode?: string;
                        name?: { simpleText?: string };
                      }) => ({
                        kind: track.kind,
                        languageCode: track.languageCode,
                        name: track.name?.simpleText ? { simpleText: track.name.simpleText } : undefined,
                      })),
                      audioTracks: (renderer.audioTracks || []).map((track: {
                        audioTrackId?: string;
                        defaultCaptionTrackIndex?: number;
                      }) => ({
                        audioTrackId: track.audioTrackId,
                        defaultCaptionTrackIndex: track.defaultCaptionTrackIndex,
                      })),
                      defaultAudioTrackIndex: renderer.defaultAudioTrackIndex,
                    },
                  }
                : undefined,
              streamingData: {
                formats: mapFormats(playerResponse?.streamingData?.formats),
                adaptiveFormats: mapFormats(playerResponse?.streamingData?.adaptiveFormats),
              },
            };
          };

          if (hasMetadata && !isSpaTransition) {
            return {
              currentTime,
              skipMetadata: true,
              languageSource: readLanguageSource(),
            };
          }

          if (isSpaTransition) {
            return {
              currentTime,
              spaTransition: true,
              currentVideoId,
              skipMetadata: false,
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
              const liveDetails =
                playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
              if (liveDetails && !liveDetails.endTimestamp) isLive = true;

              const lengthSeconds = parseInt(videoDetails.lengthSeconds) || 0;
              if (lengthSeconds > 0) {
                isLive = false;
                duration = lengthSeconds;
              }
            }

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
            if (duration === 0 && window.location.pathname.startsWith("/shorts/")) {
              try {
                // @ts-ignore
                const initialData = window.ytInitialData;
                const ms =
                  initialData &&
                  initialData.contents &&
                  initialData.contents.reelWatchEndpoint &&
                  initialData.contents.reelWatchEndpoint.approxDurationMs;
                if (ms != null && !isNaN(ms)) duration = Number(ms) / 1000;
              } catch (_) {}
            }

            if (!isLive) {
              const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
              if (
                liveBadge &&
                !liveBadge.hasAttribute("disabled") &&
                getComputedStyle(liveBadge).display !== "none"
              ) {
                isLive = true;
              }
            }

            let title =
              videoDetails?.title ||
              (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
              (document.querySelector("h1.title.ytd-video-primary-info-renderer") as HTMLElement)
                ?.innerText ||
              (document.querySelector(".ytd-video-primary-info-renderer h1") as HTMLElement)?.innerText ||
              (document.querySelector("ytd-video-primary-info-renderer #container h1") as HTMLElement)
                ?.innerText ||
              document.title;

            title = title.replace(/^\(\d+\)\s*/g, "");
            title = title.replace(" - YouTube", "").trim();

            return {
              duration: isLive ? 0 : duration || videoElement?.duration || 0,
              currentTime,
              channelName: channel || videoDetails?.author || "",
              title: title || "YouTube Video",
              isLive,
              skipMetadata: false,
              languageSource: readLanguageSource(),
              language: undefined as string | null | undefined,
              languageName: undefined as string | null | undefined,
            };
          } catch (error) {
            return {
              duration: videoElement?.duration || 0,
              currentTime,
              channelName: channel,
              title:
                document.title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim() ||
                "YouTube Video",
              isLive: false,
              skipMetadata: false,
              language: undefined as string | null | undefined,
              languageName: undefined as string | null | undefined,
            };
          }
        },
      });

      if (results[0]?.result) {
        const result = results[0].result;

        if (result.languageSource) {
          const sourceDetails = result.languageSource.videoDetails;
          const detected = await requestVideoLanguage(
            detectLanguageFromPlayerResponse(result.languageSource),
            languageTextFromPlayerResponse(result.languageSource),
            { channelName: sourceDetails?.author, videoId: sourceDetails?.videoId },
            result.languageSource.uiLanguage
          );
          result.language = detected.language;
          result.languageName = detected.languageName;
          const renderer = result.languageSource.captions?.playerCaptionsTracklistRenderer;
          const trackCount = renderer?.captionTracks?.length ?? 0;
          const formats = [
            ...(result.languageSource.streamingData?.formats ?? []),
            ...(result.languageSource.streamingData?.adaptiveFormats ?? []),
          ];
          const hasAudioHint =
            formats.some((format) => format.audioTrack?.id) ||
            typeof renderer?.defaultAudioTrackIndex === "number";
          if (detected.language || trackCount === 0 || hasAudioHint) {
            pageLanguageConfirmed.add(pageLanguageKey);
          }
        }

        if (result.spaTransition) {
          video.currentTime = result.currentTime || 0;
          const tryContentScript = async (): Promise<boolean> => {
            const meta = await browser.tabs
              .sendMessage(video.id, { action: "get-metadata", refreshLanguage: true })
              .catch(() => null);
            if (meta?.videoId === expectedVideoId && meta?.title && (meta.seconds > 0 || meta.isLive)) {
              video.title = meta.title;
              video.channelName = meta.channelName ?? "";
              video.seconds = meta.seconds;
              video.currentTime = meta.currentTime ?? 0;
              video.isLive = meta.isLive ?? false;
              applyLanguageMetadata(
                video,
                meta.language,
                meta.languageName,
                expectedVideoId
              );
              if (video.seconds > 0 || video.isLive) {
                persistVideoMetadata(video, expectedVideoId);
              }
              return true;
            }
            return false;
          };
          if (await tryContentScript()) return;
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (await tryContentScript()) return;
          return;
        }

        if (result.skipMetadata) {
          video.currentTime = result.currentTime || 0;
          applyLanguageMetadata(
            video,
            result.language,
            result.languageName,
            expectedVideoId
          );
        } else {
          const duration = result.duration || 0;

          const hasValidTitle =
            result.title &&
            result.title !== "Loading..." &&
            result.title !== "YouTube Video" &&
            result.title !== "YouTube";
          if (hasValidTitle || duration > 0 || result.isLive) {
            video.title = hasValidTitle ? result.title : video.title || result.title;
            video.channelName = result.channelName || video.channelName;
            video.seconds = duration;
            video.currentTime = result.currentTime || 0;
            video.isLive = result.isLive || false;
            applyLanguageMetadata(
              video,
              result.language,
              result.languageName,
              expectedVideoId
            );

            if (duration > 0 || result.isLive) {
              persistVideoMetadata(video, expectedVideoId);
            }
          }
        }
      }
    } catch (error) {
      // Ignore errors (permissions, closed tabs, etc)
    }
  });

  await Promise.all(activeTabPromises);
  scheduleProbeResultsToUi();
}

const SYNC_COOLDOWN_MS = 30_000;
let lastSyncTime = 0;

let fetchTabsFromEventsTimeout: ReturnType<typeof setTimeout> | null = null;
const FETCH_TABS_DEBOUNCE_MS = 400;

export function scheduleFetchTabsFromEvents() {
  if (fetchTabsFromEventsTimeout != null) clearTimeout(fetchTabsFromEventsTimeout);
  fetchTabsFromEventsTimeout = setTimeout(() => {
    fetchTabsFromEventsTimeout = null;
    fetchTabs(true);
  }, FETCH_TABS_DEBOUNCE_MS);
}
