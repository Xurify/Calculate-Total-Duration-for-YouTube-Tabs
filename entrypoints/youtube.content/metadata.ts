import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  type DetectedLanguage,
} from "../../utils/captionLanguage";
import { requestVideoLanguage } from "../../utils/languageRequest";
import { requestPageLanguage, type PageLanguageSource } from "../../utils/pageLanguage";
import { extractChaptersFromPlayerResponse } from "../../utils/chapters";
import { page } from "./state";
import { readChannelAvatar, reportChannelAvatar } from "./avatar";
import { updateImmersionHud } from "./hud";
import { isWatchOrShorts } from "./playback";
import { type CachedMetadataPayload, DEBOUNCE_MS, MAX_WAIT_MS, perf } from "./state";

export function getVideoIdFromLocation(): string | null {
  try {
    const pathname = window.location.pathname;
    const search = window.location.search;
    if (pathname.startsWith("/shorts/")) {
      const match = pathname.match(/\/shorts\/([^/?]+)/);
      return match ? match[1] : null;
    }
    if (pathname === "/watch" && search) {
      const searchParameters = new URLSearchParams(search);
      return searchParameters.get("v");
    }
  } catch {
    // Ignore URL parse failure
  }
  return null;
}

type PlayerResponseShape = Parameters<typeof detectLanguageFromPlayerResponse>[0] & {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    isLive?: boolean;
    lengthSeconds?: string;
    shortDescription?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        languageCode: string;
        kind?: string;
      }>;
    };
  };
};

function readPlayerResponseFromPage(): PlayerResponseShape | null {
  try {
    const moviePlayerElement = document.getElementById("movie_player") as (HTMLElement & {
      getPlayerResponse?: () => PlayerResponseShape;
    }) | null;
    if (moviePlayerElement && typeof moviePlayerElement.getPlayerResponse === "function") {
      const playerResponse = moviePlayerElement.getPlayerResponse();
      if (playerResponse) return playerResponse;
    }
  } catch {
    // Ignore player element response failure
  }

  try {
    const fromWindow = (window as unknown as { ytInitialPlayerResponse?: PlayerResponseShape })
      .ytInitialPlayerResponse;
    if (fromWindow) return fromWindow;
  } catch {
    // Ignore window read failure
  }

  try {
    for (const scriptElement of document.querySelectorAll("script:not([src])")) {
      const scriptContent = scriptElement.textContent;
      if (!scriptContent?.includes("ytInitialPlayerResponse")) continue;
      const playerResponseMatch =
        scriptContent.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
        scriptContent.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
      if (!playerResponseMatch) continue;
      return JSON.parse(playerResponseMatch[1]) as PlayerResponseShape;
    }
  } catch {
    // Ignore script parse failure
  }

  return null;
}

/** A miss is asked again after this, in case the player response was not ready yet. */
const LANGUAGE_RETRY_MS = 15_000;
let languageLookup: { videoId: string; at: number; result: Promise<DetectedLanguage | undefined> } | null = null;

async function lookUpLanguage(videoId: string): Promise<DetectedLanguage | undefined> {
  let source: PageLanguageSource | null = await requestPageLanguage(videoId);
  if (!source) {
    const playerResponse = readPlayerResponseFromPage();
    if (playerResponse?.videoDetails?.videoId === videoId) {
      source = {
        videoId,
        detected: detectLanguageFromPlayerResponse(playerResponse),
        text: languageTextFromPlayerResponse(playerResponse),
        channelName: playerResponse.videoDetails.author ?? null,
      };
    }
  }
  if (!source) return undefined;
  return requestVideoLanguage(source.detected, source.text, { channelName: source.channelName, videoId }, document.documentElement.lang);
}

async function extractLanguageFromDom(videoId: string | null, refresh = false): Promise<DetectedLanguage | undefined> {
  if (!videoId) return undefined;
  const cached = languageLookup?.videoId === videoId ? languageLookup : null;
  if (cached && !refresh) {
    const result = await cached.result;
    if (result?.language || Date.now() - cached.at < LANGUAGE_RETRY_MS) return result;
  }
  const lookup = { videoId, at: Date.now(), result: lookUpLanguage(videoId) };
  languageLookup = lookup;
  return lookup.result;
}

function parseDurationFromTimeText(durationText: string): number {
  const durationParts = durationText.trim().split(":").map((durationPart) => parseInt(durationPart, 10) || 0);
  if (durationParts.length === 3) return durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
  if (durationParts.length === 2) return durationParts[0] * 60 + durationParts[1];
  if (durationParts.length === 1) return durationParts[0];
  return 0;
}

export async function readMetadataFromDom(refreshLanguage = false): Promise<CachedMetadataPayload> {
  const videoId = getVideoIdFromLocation();
  const videoElement = document.querySelector("video");
  const currentTime = videoElement ? videoElement.currentTime : 0;
  let duration = 0;

  const videoDuration = videoElement?.duration;
  if (videoDuration != null && isFinite(videoDuration) && videoDuration > 0) {
    duration = videoDuration;
  }
  if (duration === 0) {
    const durationElement = document.querySelector(".ytp-time-duration");
    if (durationElement?.textContent) {
      duration = parseDurationFromTimeText(durationElement.textContent);
    }
  }

  const playerResponse = readPlayerResponseFromPage();
  if (duration === 0 && playerResponse?.videoDetails?.lengthSeconds) {
    duration = parseInt(playerResponse.videoDetails.lengthSeconds, 10) || 0;
  }

  let title =
    (document.querySelector("h1.ytd-watch-metadata yt-formatted-string") as HTMLElement)?.innerText ||
    (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
    (document.querySelector("ytd-watch-metadata h1") as HTMLElement)?.innerText ||
    playerResponse?.videoDetails?.title ||
    document.title;
  title = title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();

  const channelName =
    (document.querySelector("ytd-watch-metadata ytd-channel-name a") as HTMLElement)?.innerText ||
    (document.querySelector("#upload-info #channel-name a") as HTMLElement)?.innerText ||
    (document.querySelector(".ytd-video-owner-renderer #channel-name a") as HTMLElement)?.innerText ||
    playerResponse?.videoDetails?.author ||
    "";
  const channelAvatar = readChannelAvatar();
  reportChannelAvatar(channelName, channelAvatar);

  let isLive = false;
  const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
  if (liveBadge && getComputedStyle(liveBadge).display !== "none") {
    isLive = true;
  }

  const detected = await extractLanguageFromDom(videoId, refreshLanguage);
  const language = detected?.language;
  const languageName = detected?.languageName;
  const volume = videoElement ? videoElement.volume : 1;
  const muted = videoElement ? videoElement.muted : false;
  const paused = videoElement ? videoElement.paused : true;

  const chapters = extractChaptersFromPlayerResponse(playerResponse, isLive ? 0 : duration);

  return {
    videoId,
    title: title || "YouTube Video",
    channelName,
    channelAvatar,
    seconds: isLive ? 0 : duration,
    currentTime,
    isLive,
    language,
    languageName,
    paused,
    volume,
    muted,
    chapters: chapters.length > 0 ? chapters : undefined,
  };
}

export function scheduleRead(context: { setTimeout: (handler: () => void, timeoutMilliseconds: number) => unknown }) {
  const now = Date.now();
  const timeSinceLastRead = now - page.lastReadTime;

  if (page.debounceTimer != null) {
    if (timeSinceLastRead > MAX_WAIT_MS) {
      return;
    }
    clearTimeout(page.debounceTimer as unknown as number);
  }
  page.debounceTimer = context.setTimeout(() => {
    page.debounceTimer = null;
    if (!isWatchOrShorts()) return;
    page.lastReadTime = Date.now();
    perf.totalReads++;
    perf.mutationsSinceLastRead = 0;
    void readMetadataFromDom().then((metadata) => {
      page.lastMetadata = metadata;
      updateImmersionHud();
    });
  }, DEBOUNCE_MS) as unknown as ReturnType<typeof setTimeout>;
}

export function extractLiveCaptionText(): string {
  const segmentElements = document.querySelectorAll(".ytp-caption-segment");
  if (segmentElements.length === 0) return "";
  const textParts: string[] = [];
  for (const segmentElement of segmentElements) {
    const textContent = segmentElement.textContent?.trim();
    if (textContent) {
      textParts.push(textContent);
    }
  }
  return textParts.join(" ").replace(/\s+/g, " ").trim();
}
