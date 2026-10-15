/**
 * Content script that runs on YouTube watch/shorts pages.
 * Handles metadata caching, chapter extraction, sentence navigation,
 * slow replay, shadowing mode, cloze capture, and in-player Mandala integration.
 */
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  type DetectedLanguage,
} from "../utils/captionLanguage";
import { resolveVideoLanguage, type VideoChannel } from "../utils/channelLanguage";
import { registerBridgeListener } from "../utils/webmcpBridge";
import { extractChaptersFromPlayerResponse } from "../utils/chapters";
import type { VideoChapter, StagedClozeCard } from "../utils/storage";

const DEBOUNCE_MS = 150;

const perf = {
  totalMutations: 0,
  totalReads: 0,
  mutationsSinceLastRead: 0,
};

interface CachedMetadataPayload {
  videoId: string | null;
  title: string;
  channelName: string;
  seconds: number;
  currentTime: number;
  isLive: boolean;
  language?: string | null;
  languageName?: string | null;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  chapters?: VideoChapter[];
}

let lastMetadata: CachedMetadataPayload = {
  videoId: null,
  title: "",
  channelName: "",
  seconds: 0,
  currentTime: 0,
  isLive: false,
  language: null,
  languageName: null,
  paused: true,
  volume: 1,
  muted: false,
  chapters: undefined,
};

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastReadTime = 0;
const MAX_WAIT_MS = 1000;

interface TranscriptSegment {
  startSeconds: number;
  durationSeconds: number;
  text: string;
}

interface Json3CaptionPayload {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{
      utf8?: string;
    }>;
  }>;
}

interface MandalaStatusResponse {
  connected: boolean;
  cached: boolean;
  activeChartTitle?: string;
  matchedShelfItem?: {
    pillarIndex: number;
    pillarTitle: string;
    linkId: string;
    toolTitle: string;
  };
  pillars: Array<{
    index: number;
    title: string;
    actionCount: number;
  }>;
}

interface SubtitleMemoryEntry {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

let loadedSegmentsForVideoId: string | null = null;
let cachedTranscriptSegments: TranscriptSegment[] = [];
let isFetchingTranscript = false;

let observedSubtitleHistory: SubtitleMemoryEntry[] = [];
let currentlyActiveLiveSubtitle: { text: string; startSeconds: number; observedAt: number } | null = null;
let lastShadowingSentenceText = "";
let captionObserver: MutationObserver | null = null;

let sessionWatchedSeconds = 0;
let lastWatchTickTimestamp = Date.now();
let watchedTimerInterval: ReturnType<typeof setInterval> | null = null;

let isShadowingModeActive = false;
let isShadowingPauseActive = false;
let shadowingCountdownTimer: ReturnType<typeof setInterval> | null = null;
let originalPlaybackRate = 1;
let isSlowReplayActive = false;
let slowReplayTargetSegment: TranscriptSegment | null = null;

let latestMandalaStatus: MandalaStatusResponse = {
  connected: false,
  cached: false,
  pillars: [],
};

let isPillarPopoverOpen = false;
let currentWatchVideoId: string | null = null;

function getVideoIdFromLocation(): string | null {
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

async function extractLanguageFromDom(): Promise<DetectedLanguage | undefined> {
  const playerResponse = readPlayerResponseFromPage();
  if (!playerResponse) return undefined;
  return resolveVideoLanguage(
    detectLanguageFromPlayerResponse(playerResponse),
    languageTextFromPlayerResponse(playerResponse),
    { channelName: playerResponse.videoDetails?.author, videoId: playerResponse.videoDetails?.videoId },
    document.documentElement.lang
  );
}

function parseDurationFromTimeText(durationText: string): number {
  const durationParts = durationText.trim().split(":").map((durationPart) => parseInt(durationPart, 10) || 0);
  if (durationParts.length === 3) return durationParts[0] * 3600 + durationParts[1] * 60 + durationParts[2];
  if (durationParts.length === 2) return durationParts[0] * 60 + durationParts[1];
  if (durationParts.length === 1) return durationParts[0];
  return 0;
}

async function readMetadataFromDom(): Promise<CachedMetadataPayload> {
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

  let isLive = false;
  const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
  if (liveBadge && getComputedStyle(liveBadge).display !== "none") {
    isLive = true;
  }

  const detected = await extractLanguageFromDom();
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

function scheduleRead(context: { setTimeout: (handler: () => void, timeoutMilliseconds: number) => unknown }) {
  const now = Date.now();
  const timeSinceLastRead = now - lastReadTime;

  if (debounceTimer != null) {
    if (timeSinceLastRead > MAX_WAIT_MS) {
      return;
    }
    clearTimeout(debounceTimer as unknown as number);
  }
  debounceTimer = context.setTimeout(() => {
    debounceTimer = null;
    if (!isWatchOrShorts()) return;
    lastReadTime = Date.now();
    perf.totalReads++;
    perf.mutationsSinceLastRead = 0;
    void readMetadataFromDom().then((metadata) => {
      lastMetadata = metadata;
      updateImmersionHud();
    });
  }, DEBOUNCE_MS) as unknown as ReturnType<typeof setTimeout>;
}

function isWatchOrShorts(): boolean {
  const pathname = window.location.pathname;
  return pathname.startsWith("/watch") || pathname.startsWith("/shorts/");
}

function getPlaybackState() {
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

function togglePlayback() {
  const videoElement = document.querySelector("video");
  if (!videoElement) return getPlaybackState();
  if (videoElement.paused) {
    void videoElement.play();
  } else {
    videoElement.pause();
  }
  return getPlaybackState();
}

function setPlaybackVolume(volume: number) {
  const videoElement = document.querySelector("video");
  if (!videoElement) return getPlaybackState();
  const clampedVolume = Math.min(1, Math.max(0, volume));
  videoElement.volume = clampedVolume;
  if (clampedVolume > 0 && videoElement.muted) {
    videoElement.muted = false;
  }
  return getPlaybackState();
}

function decodeXmlEntities(encodedText: string): string {
  return encodedText
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_fullMatch, charCodeString) => String.fromCharCode(Number(charCodeString)));
}

function ensureSubtitlesEnabled(): boolean {
  const moviePlayerElement = document.getElementById("movie_player") as (HTMLElement & {
    isSubtitlesOn?: () => boolean;
    toggleSubtitlesOn?: () => void;
  }) | null;

  if (moviePlayerElement && typeof moviePlayerElement.isSubtitlesOn === "function") {
    try {
      if (!moviePlayerElement.isSubtitlesOn()) {
        moviePlayerElement.toggleSubtitlesOn?.();
        return true;
      }
      return true;
    } catch {
      // Ignore player method call failure
    }
  }

  const subtitlesButton = document.querySelector(".ytp-subtitles-button") as HTMLElement | null;
  if (subtitlesButton) {
    const isPressed = subtitlesButton.getAttribute("aria-pressed") === "true";
    if (!isPressed) {
      subtitlesButton.click();
      return true;
    }
  }
  return false;
}

function extractLiveCaptionText(): string {
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

async function fetchTranscriptSegmentsForActiveVideo(): Promise<TranscriptSegment[]> {
  const videoId = getVideoIdFromLocation();
  if (!videoId) return [];
  if (loadedSegmentsForVideoId === videoId && cachedTranscriptSegments.length > 0) {
    return cachedTranscriptSegments;
  }
  if (isFetchingTranscript) return cachedTranscriptSegments;

  isFetchingTranscript = true;
  try {
    const playerResponse = readPlayerResponseFromPage();
    const captionTracks =
      (playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks as Array<{
        baseUrl?: string;
        languageCode?: string;
        kind?: string;
      }>) || [];

    if (captionTracks.length === 0) {
      isFetchingTranscript = false;
      return [];
    }

    const selectedTrack =
      captionTracks.find((track) => track.kind !== "asr") || captionTracks[0];

    if (!selectedTrack?.baseUrl) {
      isFetchingTranscript = false;
      return [];
    }

    const jsonResponse = await fetch(`${selectedTrack.baseUrl}&fmt=json3`);
    if (jsonResponse.ok) {
      const responseText = await jsonResponse.text();
      if (responseText && responseText.length > 0) {
        try {
          const jsonData = JSON.parse(responseText) as Json3CaptionPayload;
          if (Array.isArray(jsonData.events)) {
            const segments: TranscriptSegment[] = [];
            for (const captionEvent of jsonData.events) {
              const startSeconds = (captionEvent.tStartMs ?? 0) / 1000;
              const durationSeconds = (captionEvent.dDurationMs ?? 0) / 1000;
              const text = (captionEvent.segs ?? [])
                .map((segmentPart) => segmentPart.utf8 ?? "")
                .join("")
                .trim();
              if (text) {
                segments.push({ startSeconds, durationSeconds, text });
              }
            }
            if (segments.length > 0) {
              loadedSegmentsForVideoId = videoId;
              cachedTranscriptSegments = segments;
              isFetchingTranscript = false;
              return segments;
            }
          }
        } catch {
          // JSON parse failed, proceed to XML fallback
        }
      }
    }

    const xmlResponse = await fetch(selectedTrack.baseUrl);
    const xmlText = await xmlResponse.text();
    if (xmlText && xmlText.length > 0) {
      const textTagRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
      const segments: TranscriptSegment[] = [];
      let match: RegExpExecArray | null;

      while ((match = textTagRegex.exec(xmlText)) !== null) {
        const startSeconds = parseFloat(match[1]) || 0;
        const durationSeconds = match[2] ? parseFloat(match[2]) || 0 : 0;
        const rawText = match[3].replace(/<[^>]+>/g, "").trim();
        const text = decodeXmlEntities(rawText);
        if (text) {
          segments.push({ startSeconds, durationSeconds, text });
        }
      }

      if (segments.length > 0) {
        loadedSegmentsForVideoId = videoId;
        cachedTranscriptSegments = segments;
        isFetchingTranscript = false;
        return segments;
      }
    }

    isFetchingTranscript = false;
    return [];
  } catch {
    isFetchingTranscript = false;
    return [];
  }
}

function getActiveSubtitleSegment(currentTimeSeconds: number): {
  segment: TranscriptSegment | null;
  index: number;
} {
  const liveCaptionText = extractLiveCaptionText();
  if (liveCaptionText) {
    return {
      segment: {
        startSeconds: Math.max(0, currentTimeSeconds - 1.2),
        durationSeconds: 3.5,
        text: liveCaptionText,
      },
      index: -1,
    };
  }

  if (observedSubtitleHistory.length > 0) {
    const matchedHistory = observedSubtitleHistory.find(
      (historyEntry) =>
        currentTimeSeconds >= historyEntry.startSeconds && currentTimeSeconds <= historyEntry.endSeconds + 1.5
    );
    if (matchedHistory) {
      return {
        segment: {
          startSeconds: matchedHistory.startSeconds,
          durationSeconds: Math.max(2, matchedHistory.endSeconds - matchedHistory.startSeconds),
          text: matchedHistory.text,
        },
        index: -1,
      };
    }
  }

  if (cachedTranscriptSegments.length > 0) {
    for (let index = 0; index < cachedTranscriptSegments.length; index++) {
      const candidateSegment = cachedTranscriptSegments[index];
      const segmentEnd = candidateSegment.startSeconds + Math.max(1, candidateSegment.durationSeconds);
      if (currentTimeSeconds >= candidateSegment.startSeconds && currentTimeSeconds <= segmentEnd) {
        return { segment: candidateSegment, index };
      }
    }

    for (let index = cachedTranscriptSegments.length - 1; index >= 0; index--) {
      if (currentTimeSeconds >= cachedTranscriptSegments[index].startSeconds) {
        return { segment: cachedTranscriptSegments[index], index };
      }
    }
  }

  if (observedSubtitleHistory.length > 0) {
    const latestHistory = observedSubtitleHistory[0];
    return {
      segment: {
        startSeconds: latestHistory.startSeconds,
        durationSeconds: Math.max(2, latestHistory.endSeconds - latestHistory.startSeconds),
        text: latestHistory.text,
      },
      index: -1,
    };
  }

  return { segment: null, index: -1 };
}

function getTargetPlayerContainer(): HTMLElement {
  const playerContainer =
    document.getElementById("movie_player") ||
    document.querySelector(".html5-video-player") ||
    document.querySelector("#player");

  if (playerContainer && playerContainer instanceof HTMLElement) {
    return playerContainer;
  }
  return document.body;
}

function showImmersionToast(messageText: string, accentColor = "#e3aa50") {
  const existingToast = document.getElementById("study-harvester-hud-toast");
  if (existingToast) {
    existingToast.remove();
  }

  const container = getTargetPlayerContainer();
  const toastElement = document.createElement("div");
  toastElement.id = "study-harvester-hud-toast";
  toastElement.textContent = messageText;
  toastElement.style.borderLeftColor = accentColor;

  container.appendChild(toastElement);
  requestAnimationFrame(() => {
    toastElement.style.opacity = "1";
    toastElement.style.transform = "translateY(0)";
  });

  window.setTimeout(() => {
    toastElement.style.opacity = "0";
    toastElement.style.transform = "translateY(8px)";
    window.setTimeout(() => toastElement.remove(), 250);
  }, 3200);
}

function triggerSentenceReplay(): void {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  const currentLive = extractLiveCaptionText();
  let targetSentence: { text: string; startSeconds: number } | null = null;

  if (currentLive && currentlyActiveLiveSubtitle) {
    targetSentence = currentlyActiveLiveSubtitle;
  } else if (observedSubtitleHistory.length > 0) {
    targetSentence = observedSubtitleHistory[0];
  } else {
    const { segment } = getActiveSubtitleSegment(videoElement.currentTime);
    targetSentence = segment;
  }

  if (!targetSentence) {
    videoElement.currentTime = Math.max(0, videoElement.currentTime - 4);
    showImmersionToast("⟲ Rewound 4s");
    return;
  }

  const distanceIntoSentence = videoElement.currentTime - targetSentence.startSeconds;
  if (distanceIntoSentence < 0.6 && observedSubtitleHistory.length > 1) {
    const previousSentence = observedSubtitleHistory[1];
    videoElement.currentTime = previousSentence.startSeconds;
    showImmersionToast(`⟲ Replaying: “${previousSentence.text.slice(0, 42)}…”`);
  } else {
    videoElement.currentTime = targetSentence.startSeconds;
    showImmersionToast(`⟲ Replaying: “${targetSentence.text.slice(0, 42)}…”`);
  }
}

function triggerSlowSentenceReplay(): void {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  const { segment } = getActiveSubtitleSegment(videoElement.currentTime);
  if (!segment) {
    videoElement.currentTime = Math.max(0, videoElement.currentTime - 4);
    videoElement.playbackRate = 0.75;
    isSlowReplayActive = true;
    showImmersionToast("🐢 0.75x Slow Replay (4s)");
    return;
  }

  videoElement.currentTime = segment.startSeconds;
  if (!isSlowReplayActive) {
    originalPlaybackRate = videoElement.playbackRate || 1;
    isSlowReplayActive = true;
  }
  slowReplayTargetSegment = segment;
  videoElement.playbackRate = 0.75;
  showImmersionToast(`🐢 0.75x Slow Replay: “${segment.text.slice(0, 36)}…”`);
}

function triggerNextSentence(): void {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  const { index } = getActiveSubtitleSegment(videoElement.currentTime);
  if (index >= 0 && index + 1 < cachedTranscriptSegments.length) {
    const nextSegment = cachedTranscriptSegments[index + 1];
    videoElement.currentTime = nextSegment.startSeconds;
    showImmersionToast(`⏭ Next: “${nextSegment.text.slice(0, 40)}…”`);
  } else {
    videoElement.currentTime += 5;
    showImmersionToast("⏭ Jumped forward 5s");
  }
}

function toggleShadowingMode(): void {
  isShadowingModeActive = !isShadowingModeActive;
  if (isShadowingModeActive) {
    ensureSubtitlesEnabled();
    showImmersionToast("🎙️ Shadowing ON · Auto-pauses at each sentence", "#48b788");
  } else {
    if (shadowingCountdownTimer) {
      clearInterval(shadowingCountdownTimer);
      shadowingCountdownTimer = null;
    }
    isShadowingPauseActive = false;
    removeShadowingCountdownHud();
    showImmersionToast("Shadowing Mode OFF", "#7a7265");
  }
  updateImmersionHud();
}

function showShadowingCountdownHud(
  secondsRemaining: number,
  spokenSentenceText: string,
  entry: SubtitleMemoryEntry
): void {
  const container = getTargetPlayerContainer();
  let hudContainer = document.getElementById("study-harvester-shadowing-hud");
  if (!hudContainer) {
    hudContainer = document.createElement("div");
    hudContainer.id = "study-harvester-shadowing-hud";
    container.appendChild(hudContainer);
  }

  hudContainer.innerHTML = "";

  const titleHeader = document.createElement("div");
  titleHeader.className = "study-harvester-shadowing-header";
  titleHeader.textContent = "🎙️ SHADOWING PRACTICE · SPEAK ALOUD";
  hudContainer.appendChild(titleHeader);

  const sentenceElement = document.createElement("div");
  sentenceElement.className = "study-harvester-shadowing-sentence";
  sentenceElement.textContent = `“${spokenSentenceText}”`;
  hudContainer.appendChild(sentenceElement);

  const timerRow = document.createElement("div");
  timerRow.className = "study-harvester-shadowing-timer-row";

  const numberSpan = document.createElement("span");
  numberSpan.className = "study-harvester-shadowing-number";
  numberSpan.textContent = String(secondsRemaining);
  timerRow.appendChild(numberSpan);

  const labelSpan = document.createElement("span");
  labelSpan.className = "study-harvester-shadowing-label";
  labelSpan.textContent = secondsRemaining === 1 ? "second remaining" : "seconds remaining";
  timerRow.appendChild(labelSpan);

  hudContainer.appendChild(timerRow);

  const buttonRow = document.createElement("div");
  buttonRow.className = "study-harvester-shadowing-actions";

  const continueButton = document.createElement("button");
  continueButton.className = "study-harvester-shadowing-btn-primary";
  continueButton.type = "button";
  continueButton.textContent = "▶ Continue (Space)";
  continueButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    resumeFromShadowingPause();
  });
  buttonRow.appendChild(continueButton);

  const replayButton = document.createElement("button");
  replayButton.className = "study-harvester-shadowing-btn-secondary";
  replayButton.type = "button";
  replayButton.textContent = "⟲ Replay (A)";
  replayButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    replayLastShadowingSentence(entry);
  });
  buttonRow.appendChild(replayButton);

  const exitButton = document.createElement("button");
  exitButton.className = "study-harvester-shadowing-btn-ghost";
  exitButton.type = "button";
  exitButton.textContent = "Stop (Shift+S)";
  exitButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    toggleShadowingMode();
  });
  buttonRow.appendChild(exitButton);

  hudContainer.appendChild(buttonRow);
}

function removeShadowingCountdownHud(): void {
  const existingHud = document.getElementById("study-harvester-shadowing-hud");
  if (existingHud) {
    existingHud.remove();
  }
}

function resumeFromShadowingPause(): void {
  if (shadowingCountdownTimer) {
    clearInterval(shadowingCountdownTimer);
    shadowingCountdownTimer = null;
  }
  isShadowingPauseActive = false;
  removeShadowingCountdownHud();

  const videoElement = document.querySelector("video");
  if (videoElement && videoElement.paused) {
    void videoElement.play();
  }
}

function replayLastShadowingSentence(completedEntry?: SubtitleMemoryEntry): void {
  const targetEntry = completedEntry || observedSubtitleHistory[0];
  if (!targetEntry) return;

  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  if (shadowingCountdownTimer) {
    clearInterval(shadowingCountdownTimer);
    shadowingCountdownTimer = null;
  }
  isShadowingPauseActive = false;
  removeShadowingCountdownHud();

  videoElement.currentTime = targetEntry.startSeconds;
  void videoElement.play();
  showImmersionToast(`⟲ Replaying: “${targetEntry.text.slice(0, 38)}…”`);
}

function triggerShadowingPause(completedEntry: SubtitleMemoryEntry): void {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  videoElement.pause();
  isShadowingPauseActive = true;

  if (shadowingCountdownTimer) {
    clearInterval(shadowingCountdownTimer);
    shadowingCountdownTimer = null;
  }

  let countdownSeconds = 3;
  showShadowingCountdownHud(countdownSeconds, completedEntry.text, completedEntry);

  shadowingCountdownTimer = setInterval(() => {
    countdownSeconds--;
    if (countdownSeconds > 0) {
      showShadowingCountdownHud(countdownSeconds, completedEntry.text, completedEntry);
    } else {
      resumeFromShadowingPause();
    }
  }, 1000);
}

function trackLiveCaptionProgress(): void {
  const videoElement = document.querySelector("video");
  if (!videoElement || videoElement.paused || isShadowingPauseActive) {
    return;
  }

  const liveCaptionText = extractLiveCaptionText();
  const currentTimestamp = Date.now();

  if (liveCaptionText) {
    if (!currentlyActiveLiveSubtitle) {
      currentlyActiveLiveSubtitle = {
        text: liveCaptionText,
        startSeconds: videoElement.currentTime,
        observedAt: currentTimestamp,
      };
    } else if (currentlyActiveLiveSubtitle.text !== liveCaptionText) {
      if (liveCaptionText.startsWith(currentlyActiveLiveSubtitle.text)) {
        currentlyActiveLiveSubtitle.text = liveCaptionText;
      } else {
        const finishedSentence = currentlyActiveLiveSubtitle.text;
        const startSeconds = currentlyActiveLiveSubtitle.startSeconds;
        const displayDurationMilliseconds = currentTimestamp - currentlyActiveLiveSubtitle.observedAt;

        const completedEntry: SubtitleMemoryEntry = {
          text: finishedSentence,
          startSeconds,
          endSeconds: videoElement.currentTime,
        };
        observedSubtitleHistory.unshift(completedEntry);
        if (observedSubtitleHistory.length > 50) observedSubtitleHistory.pop();

        currentlyActiveLiveSubtitle = {
          text: liveCaptionText,
          startSeconds: videoElement.currentTime,
          observedAt: currentTimestamp,
        };

        if (
          isShadowingModeActive &&
          displayDurationMilliseconds >= 500 &&
          finishedSentence.length >= 3 &&
          finishedSentence !== lastShadowingSentenceText
        ) {
          lastShadowingSentenceText = finishedSentence;
          triggerShadowingPause(completedEntry);
        }
      }
    }
  } else if (currentlyActiveLiveSubtitle) {
    const finishedSentence = currentlyActiveLiveSubtitle.text;
    const startSeconds = currentlyActiveLiveSubtitle.startSeconds;
    const displayDurationMilliseconds = currentTimestamp - currentlyActiveLiveSubtitle.observedAt;

    const completedEntry: SubtitleMemoryEntry = {
      text: finishedSentence,
      startSeconds,
      endSeconds: videoElement.currentTime,
    };
    observedSubtitleHistory.unshift(completedEntry);
    if (observedSubtitleHistory.length > 50) observedSubtitleHistory.pop();

    currentlyActiveLiveSubtitle = null;

    if (
      isShadowingModeActive &&
      displayDurationMilliseconds >= 500 &&
      finishedSentence.length >= 3 &&
      finishedSentence !== lastShadowingSentenceText
    ) {
      lastShadowingSentenceText = finishedSentence;
      triggerShadowingPause(completedEntry);
    }
  }
}

function extractSentenceWords(sentence: string): string[] {
  return sentence
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
}

function cleanWordForCloze(rawWord: string): string {
  return rawWord.replace(/^[.,/#!$%^&*;:{}=\-_`~()?"'«»]+|[.,/#!$%^&*;:{}=\-_`~()?"'«»]+$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pickTargetClozeWord(sentenceText: string): string {
  const selection = window.getSelection()?.toString().trim();
  if (selection && sentenceText.toLowerCase().includes(selection.toLowerCase())) {
    return cleanWordForCloze(selection);
  }

  const cleanWords = sentenceText
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'«»]/g, " ")
    .split(/\s+/)
    .map((word) => cleanWordForCloze(word))
    .filter((word) => word.length >= 4);

  if (cleanWords.length > 0) {
    cleanWords.sort((firstWord, secondWord) => secondWord.length - firstWord.length);
    return cleanWords[0];
  }

  const firstWord = sentenceText.split(/\s+/)[0] || "word";
  return cleanWordForCloze(firstWord);
}

function closeClozeCaptureModal(): void {
  const existingModal = document.getElementById("study-harvester-cloze-modal");
  if (existingModal) {
    existingModal.remove();
  }
}

function showClozeCaptureModal(
  initialSentence: string,
  initialTargetWord: string,
  timestampSeconds: number
): void {
  closeClozeCaptureModal();

  const container = getTargetPlayerContainer();
  const modalWrapper = document.createElement("div");
  modalWrapper.id = "study-harvester-cloze-modal";

  let activeTargetWord = cleanWordForCloze(initialTargetWord);
  const activeSentence = initialSentence;

  const cardElement = document.createElement("div");
  cardElement.className = "study-harvester-cloze-card";
  modalWrapper.appendChild(cardElement);

  const headerRow = document.createElement("div");
  headerRow.className = "study-harvester-cloze-header";

  const titleBadge = document.createElement("div");
  titleBadge.className = "study-harvester-cloze-title";
  titleBadge.innerHTML = `<span>🗂️</span> STAGE CLOZEMASTER CARD`;
  headerRow.appendChild(titleBadge);

  const minutes = Math.floor(timestampSeconds / 60);
  const seconds = Math.floor(timestampSeconds % 60);
  const timeFormatted = `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;

  const timePill = document.createElement("div");
  timePill.className = "study-harvester-cloze-time";
  timePill.textContent = `▶ ${timeFormatted}`;
  headerRow.appendChild(timePill);

  const closeButton = document.createElement("button");
  closeButton.className = "study-harvester-cloze-close";
  closeButton.type = "button";
  closeButton.innerHTML = "&times;";
  closeButton.title = "Close (Esc)";
  closeButton.addEventListener("click", () => {
    closeClozeCaptureModal();
    const videoElement = document.querySelector("video");
    if (videoElement && videoElement.paused) void videoElement.play();
  });
  headerRow.appendChild(closeButton);

  cardElement.appendChild(headerRow);

  const instructionLabel = document.createElement("div");
  instructionLabel.className = "study-harvester-cloze-label";
  instructionLabel.textContent = "Click any word below to set as cloze blank {{...}}:";
  cardElement.appendChild(instructionLabel);

  const chipsContainer = document.createElement("div");
  chipsContainer.className = "study-harvester-chips-container";
  cardElement.appendChild(chipsContainer);

  const previewBox = document.createElement("div");
  previewBox.className = "study-harvester-cloze-preview";
  cardElement.appendChild(previewBox);

  const translationGroup = document.createElement("div");
  translationGroup.className = "study-harvester-input-group";
  const translationLabel = document.createElement("label");
  translationLabel.textContent = "Translation / Video Context:";
  const translationInput = document.createElement("input");
  translationInput.type = "text";
  translationInput.value = lastMetadata.title || document.title;
  translationGroup.appendChild(translationLabel);
  translationGroup.appendChild(translationInput);
  cardElement.appendChild(translationGroup);

  const hintGroup = document.createElement("div");
  hintGroup.className = "study-harvester-input-group";
  const hintLabel = document.createElement("label");
  hintLabel.textContent = "Hint (Channel / Notes):";
  const hintInput = document.createElement("input");
  hintInput.type = "text";
  hintInput.value = lastMetadata.channelName || "";
  hintGroup.appendChild(hintLabel);
  hintGroup.appendChild(hintInput);
  cardElement.appendChild(hintGroup);

  const updateWordChipsAndPreview = () => {
    chipsContainer.innerHTML = "";
    const rawWords = extractSentenceWords(activeSentence);

    for (const rawWord of rawWords) {
      const cleanedWord = cleanWordForCloze(rawWord);
      const chipButton = document.createElement("button");
      chipButton.type = "button";
      chipButton.className = `study-harvester-word-chip ${
        cleanedWord.toLowerCase() === activeTargetWord.toLowerCase() ? "active" : ""
      }`;
      chipButton.textContent = rawWord;
      chipButton.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        if (cleanedWord) {
          activeTargetWord = cleanedWord;
          updateWordChipsAndPreview();
        }
      });
      chipsContainer.appendChild(chipButton);
    }

    const pattern = new RegExp(`\\b${escapeRegExp(activeTargetWord)}\\b`, "i");
    const maskedText = activeSentence.replace(pattern, `{{${activeTargetWord}}}`);
    previewBox.innerHTML = `
      <span style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #e3aa50; font-weight: 700; display: block; margin-bottom: 4px;">Card Preview:</span>
      <span style="color: #efe7da; font-weight: 500;">${
        maskedText.includes("{{") ? maskedText : `{{${activeTargetWord}}} ${activeSentence}`
      }</span>
    `;
  };

  updateWordChipsAndPreview();

  const footerRow = document.createElement("div");
  footerRow.className = "study-harvester-cloze-footer";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "study-harvester-btn-cancel";
  cancelButton.textContent = "Cancel (Esc)";
  cancelButton.addEventListener("click", () => {
    closeClozeCaptureModal();
    const videoElement = document.querySelector("video");
    if (videoElement && videoElement.paused) void videoElement.play();
  });
  footerRow.appendChild(cancelButton);

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "study-harvester-btn-save";
  saveButton.textContent = "Stage Flashcard (Enter)";

  const handleSave = async () => {
    const pattern = new RegExp(`\\b${escapeRegExp(activeTargetWord)}\\b`, "i");
    const masked = activeSentence.replace(pattern, `{{${activeTargetWord}}}`);
    const finalSentence = masked.includes("{{") ? masked : `{{${activeTargetWord}}} ${activeSentence}`;

    const stagedCard: StagedClozeCard = {
      id: crypto.randomUUID(),
      sentence: finalSentence,
      targetWord: activeTargetWord,
      translation: translationInput.value.trim() || lastMetadata.title || "YouTube Immersion",
      hint: hintInput.value.trim() || lastMetadata.channelName,
      videoId: lastMetadata.videoId,
      videoTitle: lastMetadata.title,
      timestampSeconds: Math.floor(timestampSeconds),
      createdAt: Date.now(),
    };

    try {
      await browser.runtime.sendMessage({
        action: "stage-cloze-card",
        card: stagedCard,
      });
      showImmersionToast(`✓ Staged cloze: «${activeTargetWord}» for Clozemaster`, "#48b788");
    } catch {
      showImmersionToast("Failed to save cloze card", "#e37050");
    }

    closeClozeCaptureModal();
    const videoElement = document.querySelector("video");
    if (videoElement && videoElement.paused) void videoElement.play();
  };

  saveButton.addEventListener("click", () => void handleSave());
  footerRow.appendChild(saveButton);

  cardElement.appendChild(footerRow);

  modalWrapper.addEventListener("keydown", (keyboardEvent) => {
    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      closeClozeCaptureModal();
      const videoElement = document.querySelector("video");
      if (videoElement && videoElement.paused) void videoElement.play();
      return;
    }
    if (
      keyboardEvent.key === "Enter" &&
      keyboardEvent.target !== translationInput &&
      keyboardEvent.target !== hintInput
    ) {
      keyboardEvent.preventDefault();
      void handleSave();
    }
  });

  container.appendChild(modalWrapper);
}

async function triggerClozeCardCapture(): Promise<void> {
  const videoElement = document.querySelector("video");
  const currentTime = videoElement ? videoElement.currentTime : 0;

  if (videoElement && !videoElement.paused) {
    videoElement.pause();
  }

  ensureSubtitlesEnabled();

  let sentenceText = extractLiveCaptionText();
  if (!sentenceText && observedSubtitleHistory.length > 0) {
    sentenceText = observedSubtitleHistory[0].text;
  }

  if (!sentenceText) {
    const { segment } = getActiveSubtitleSegment(currentTime);
    if (segment?.text) {
      sentenceText = segment.text;
    }
  }

  if (!sentenceText) {
    const selection = window.getSelection()?.toString().trim();
    if (selection) {
      sentenceText = selection;
    }
  }

  if (!sentenceText) {
    sentenceText = lastMetadata.title || document.title || "Immersion Sentence";
  }

  const targetWord = pickTargetClozeWord(sentenceText);
  showClozeCaptureModal(sentenceText, targetWord, currentTime);
}

async function checkMandalaStatusForCurrentPage(): Promise<void> {
  try {
    const status = (await browser.runtime.sendMessage({
      action: "check-mandala-status",
      url: window.location.href,
    })) as MandalaStatusResponse;

    if (status && typeof status === "object") {
      latestMandalaStatus = status;
      updateImmersionHud();
    }
  } catch {
    // Background unavailable or extension reloading
  }
}

async function quickLogWatchedTimeToMandala(): Promise<void> {
  const watchedMinutes = Math.max(1, Math.floor(sessionWatchedSeconds / 60));
  const linkId = latestMandalaStatus.matchedShelfItem?.linkId;

  try {
    const response = (await browser.runtime.sendMessage({
      action: "log-mandala-time",
      payload: {
        minutes: watchedMinutes,
        linkId,
        videoTitle: lastMetadata.title,
      },
    })) as { success: boolean; queued: boolean; minutes: number };

    if (response?.success) {
      sessionWatchedSeconds = 0;
      updateImmersionHud();
      showImmersionToast(
        response.queued
          ? `✓ Staged ${watchedMinutes} min for Mandala (syncs when open)`
          : `✓ Logged ${watchedMinutes} min to Mandala!`,
        "#48b788"
      );
    }
  } catch {
    showImmersionToast("Could not log time to Mandala", "#e37050");
  }
}

async function saveCurrentVideoToMandalaShelf(pillarIndex: number): Promise<void> {
  try {
    const response = (await browser.runtime.sendMessage({
      action: "save-mandala-shelf-link",
      payload: {
        pillarIndex,
        url: window.location.href,
        title: lastMetadata.title || document.title,
        kind: "repeat",
      },
    })) as { success: boolean; queued: boolean };

    if (response?.success) {
      const pillarTitle =
        latestMandalaStatus.pillars.find((pillar) => pillar.index === pillarIndex)?.title ||
        `Pillar ${pillarIndex + 1}`;

      latestMandalaStatus.matchedShelfItem = {
        pillarIndex,
        pillarTitle,
        linkId: "staged",
        toolTitle: lastMetadata.title,
      };

      updateImmersionHud();
      showImmersionToast(
        response.queued
          ? `✓ Staged on ${pillarTitle}'s shelf`
          : `✓ Saved to ${pillarTitle}'s shelf!`,
        "#48b788"
      );
    }
  } catch {
    showImmersionToast("Failed to save to shelf", "#e37050");
  }
}

function injectImmersionStyles(): void {
  if (document.getElementById("study-harvester-immersion-styles")) return;

  const styleElement = document.createElement("style");
  styleElement.id = "study-harvester-immersion-styles";
  styleElement.textContent = `
    #study-harvester-player-hud {
      position: absolute;
      top: 14px;
      right: 70px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 2147483600;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      color: #efe7da;
      user-select: none;
      pointer-events: auto;
    }
    .study-harvester-hud-btn {
      background-color: rgba(35, 31, 27, 0.92);
      backdrop-filter: blur(8px);
      color: #efe7da;
      border: 1px solid rgba(239, 231, 218, 0.2);
      padding: 6px 11px;
      border-radius: 8px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-weight: 500;
      font-size: 11px;
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.1s ease;
    }
    .study-harvester-hud-btn:hover {
      background-color: rgba(45, 40, 35, 0.98);
      border-color: rgba(227, 170, 80, 0.55);
      color: #ffffff;
      transform: translateY(-1px);
    }
    .study-harvester-hud-btn.active {
      background-color: rgba(72, 183, 136, 0.28);
      border-color: #48b788;
      color: #48b788;
      font-weight: 700;
    }
    .study-harvester-shelf-popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      background-color: #231f1b;
      border: 1px solid rgba(239, 231, 218, 0.2);
      border-radius: 10px;
      padding: 8px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.85);
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 220px;
      z-index: 2147483610;
    }
    .study-harvester-pillar-item {
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 11px;
      color: #efe7da;
      text-align: left;
      border: none;
      background: transparent;
      transition: background-color 0.12s ease;
    }
    .study-harvester-pillar-item:hover {
      background-color: rgba(227, 170, 80, 0.22);
      color: #ffffff;
    }
    #study-harvester-shadowing-hud {
      position: absolute;
      top: 32%;
      left: 50%;
      transform: translate(-50%, -50%);
      background-color: rgba(28, 24, 20, 0.96);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(72, 183, 136, 0.45);
      border-radius: 16px;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.9);
      padding: 22px 28px;
      min-width: 340px;
      max-width: 580px;
      text-align: center;
      z-index: 2147483646;
      color: #efe7da;
      font-family: system-ui, -apple-system, sans-serif;
      pointer-events: auto;
    }
    .study-harvester-shadowing-header {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: #48b788;
      margin-bottom: 8px;
      font-weight: 700;
    }
    .study-harvester-shadowing-sentence {
      font-size: 16px;
      font-weight: 500;
      color: #efe7da;
      margin-bottom: 14px;
      font-style: italic;
      line-height: 1.4;
    }
    .study-harvester-shadowing-timer-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      margin-bottom: 16px;
    }
    .study-harvester-shadowing-number {
      font-size: 32px;
      font-weight: 800;
      color: #48b788;
      font-variant-numeric: tabular-nums;
    }
    .study-harvester-shadowing-label {
      font-size: 13px;
      color: #a89e90;
    }
    .study-harvester-shadowing-actions {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .study-harvester-shadowing-btn-primary {
      background-color: #48b788;
      color: #10261b;
      font-weight: 700;
      padding: 7px 15px;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      font-size: 12px;
      transition: background-color 0.15s ease;
    }
    .study-harvester-shadowing-btn-primary:hover {
      background-color: #58c998;
    }
    .study-harvester-shadowing-btn-secondary {
      background-color: rgba(239, 231, 218, 0.1);
      color: #efe7da;
      border: 1px solid rgba(239, 231, 218, 0.2);
      padding: 7px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      transition: background-color 0.15s ease;
    }
    .study-harvester-shadowing-btn-secondary:hover {
      background-color: rgba(239, 231, 218, 0.18);
    }
    .study-harvester-shadowing-btn-ghost {
      background: transparent;
      color: #a89e90;
      border: none;
      cursor: pointer;
      font-size: 11px;
      padding: 6px 10px;
    }
    .study-harvester-shadowing-btn-ghost:hover {
      color: #efe7da;
    }
    #study-harvester-cloze-modal {
      position: absolute;
      inset: 0;
      background-color: rgba(18, 15, 12, 0.82);
      backdrop-filter: blur(8px);
      z-index: 2147483645;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      box-sizing: border-box;
      pointer-events: auto;
    }
    .study-harvester-cloze-card {
      background-color: #231f1b;
      border: 1px solid rgba(227, 170, 80, 0.4);
      border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.9);
      width: 100%;
      max-width: 540px;
      padding: 22px;
      color: #efe7da;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .study-harvester-cloze-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .study-harvester-cloze-title {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: #e3aa50;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .study-harvester-cloze-time {
      font-size: 12px;
      color: #a89e90;
      font-variant-numeric: tabular-nums;
    }
    .study-harvester-cloze-close {
      background: transparent;
      border: none;
      color: #a89e90;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .study-harvester-cloze-close:hover {
      color: #ffffff;
    }
    .study-harvester-cloze-label {
      font-size: 11px;
      color: #a89e90;
      margin-bottom: -4px;
    }
    .study-harvester-chips-container {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px;
      background-color: rgba(0, 0, 0, 0.3);
      border-radius: 10px;
      border: 1px solid rgba(239, 231, 218, 0.1);
      max-height: 120px;
      overflow-y: auto;
    }
    .study-harvester-word-chip {
      background-color: rgba(239, 231, 218, 0.08);
      border: 1px solid rgba(239, 231, 218, 0.16);
      color: #efe7da;
      padding: 5px 9px;
      border-radius: 7px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.12s ease;
    }
    .study-harvester-word-chip:hover {
      background-color: rgba(227, 170, 80, 0.2);
      border-color: #e3aa50;
      color: #ffffff;
    }
    .study-harvester-word-chip.active {
      background-color: #e3aa50;
      color: #1a1612;
      font-weight: 700;
      border-color: #e3aa50;
      box-shadow: 0 0 10px rgba(227, 170, 80, 0.4);
    }
    .study-harvester-cloze-preview {
      background-color: rgba(0, 0, 0, 0.4);
      border: 1px dashed rgba(227, 170, 80, 0.4);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
    }
    .study-harvester-input-group {
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .study-harvester-input-group label {
      font-size: 11px;
      color: #a89e90;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .study-harvester-input-group input {
      background-color: #2a2520;
      border: 1px solid rgba(239, 231, 218, 0.18);
      border-radius: 8px;
      padding: 8px 12px;
      color: #efe7da;
      font-size: 13px;
      width: 100%;
      box-sizing: border-box;
      outline: none;
    }
    .study-harvester-input-group input:focus {
      border-color: #e3aa50;
    }
    .study-harvester-cloze-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 6px;
    }
    .study-harvester-btn-cancel {
      background: transparent;
      color: #a89e90;
      border: 1px solid rgba(239, 231, 218, 0.18);
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .study-harvester-btn-cancel:hover {
      color: #efe7da;
      border-color: rgba(239, 231, 218, 0.35);
    }
    .study-harvester-btn-save {
      background-color: #e3aa50;
      color: #1a1612;
      font-weight: 700;
      border: none;
      padding: 8px 18px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 12px;
      transition: background-color 0.15s ease;
    }
    .study-harvester-btn-save:hover {
      background-color: #f1b95f;
    }
    #study-harvester-hud-toast {
      position: absolute;
      bottom: 70px;
      right: 24px;
      background-color: #231f1b;
      color: #efe7da;
      padding: 12px 18px;
      border-radius: 10px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.85);
      font-size: 13px;
      font-weight: 600;
      letter-spacing: 0.02em;
      font-family: system-ui, -apple-system, sans-serif;
      z-index: 2147483647;
      border: 1px solid rgba(239, 231, 218, 0.16);
      border-left: 4px solid #e3aa50;
      transition: opacity 0.22s ease-out, transform 0.22s ease-out;
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
    }
  `;
  document.head.appendChild(styleElement);
}

function removeImmersionHud(): void {
  const existingHud = document.getElementById("study-harvester-player-hud");
  if (existingHud) {
    existingHud.remove();
  }
}

function updateImmersionHud(): void {
  if (!isWatchOrShorts()) {
    removeImmersionHud();
    return;
  }

  injectImmersionStyles();

  const playerContainer = getTargetPlayerContainer();
  let hudContainer = document.getElementById("study-harvester-player-hud");
  if (!hudContainer) {
    hudContainer = document.createElement("div");
    hudContainer.id = "study-harvester-player-hud";
    playerContainer.appendChild(hudContainer);
  }

  const matchedShelf = latestMandalaStatus.matchedShelfItem;
  const watchedMinutes = Math.floor(sessionWatchedSeconds / 60);

  hudContainer.innerHTML = "";

  const shelfButton = document.createElement("button");
  shelfButton.className = "study-harvester-hud-btn";
  shelfButton.type = "button";
  if (matchedShelf) {
    shelfButton.innerHTML = `<span style="color:#48b788;">🌿</span> ${matchedShelf.pillarTitle}`;
    shelfButton.title = `Saved on Mandala's ${matchedShelf.pillarTitle} shelf`;
  } else {
    shelfButton.innerHTML = `<span>+</span> Mandala Shelf`;
    shelfButton.title = "Save this video to a Mandala pillar shelf";
  }
  shelfButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    isPillarPopoverOpen = !isPillarPopoverOpen;
    updateImmersionHud();
  });
  hudContainer.appendChild(shelfButton);

  if (isPillarPopoverOpen) {
    const popover = document.createElement("div");
    popover.className = "study-harvester-shelf-popover";

    const header = document.createElement("div");
    header.style.fontSize = "10px";
    header.style.textTransform = "uppercase";
    header.style.letterSpacing = "0.08em";
    header.style.color = "#e3aa50";
    header.style.padding = "4px 8px";
    header.textContent = "Save to Mandala Pillar";
    popover.appendChild(header);

    const pillars =
      latestMandalaStatus.pillars.length > 0
        ? latestMandalaStatus.pillars
        : Array.from({ length: 8 }, (_item, pillarIndex) => ({
            index: pillarIndex,
            title: `Pillar ${pillarIndex + 1}`,
            actionCount: 0,
          }));

    for (const pillar of pillars) {
      const pillarButton = document.createElement("button");
      pillarButton.className = "study-harvester-pillar-item";
      pillarButton.type = "button";
      pillarButton.textContent = `${pillar.index + 1}. ${pillar.title}`;
      pillarButton.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        isPillarPopoverOpen = false;
        void saveCurrentVideoToMandalaShelf(pillar.index);
      });
      popover.appendChild(pillarButton);
    }

    hudContainer.appendChild(popover);
  }

  if (watchedMinutes >= 1) {
    const logTimeButton = document.createElement("button");
    logTimeButton.className = "study-harvester-hud-btn";
    logTimeButton.type = "button";
    logTimeButton.innerHTML = `⏱️ Log ${watchedMinutes}m`;
    logTimeButton.title = `Log ${watchedMinutes} minutes to Mandala chart`;
    logTimeButton.addEventListener("click", (clickEvent) => {
      clickEvent.stopPropagation();
      void quickLogWatchedTimeToMandala();
    });
    hudContainer.appendChild(logTimeButton);
  }

  const shadowingButton = document.createElement("button");
  shadowingButton.className = `study-harvester-hud-btn ${isShadowingModeActive ? "active" : ""}`;
  shadowingButton.type = "button";
  shadowingButton.innerHTML = `🎙️ ${isShadowingModeActive ? "Shadowing ON" : "Shadow"}`;
  shadowingButton.title = "Toggle Shadowing Mode (Shift + S): auto-pauses at end of each sentence";
  shadowingButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    toggleShadowingMode();
  });
  hudContainer.appendChild(shadowingButton);

  const clozeButton = document.createElement("button");
  clozeButton.className = "study-harvester-hud-btn";
  clozeButton.type = "button";
  clozeButton.innerHTML = `🗂️ Cloze`;
  clozeButton.title = "Capture current sentence into Clozemaster (Alt + C)";
  clozeButton.addEventListener("click", (clickEvent) => {
    clickEvent.stopPropagation();
    void triggerClozeCardCapture();
  });
  hudContainer.appendChild(clozeButton);
}

function isEditableTarget(targetElement: EventTarget | null): boolean {
  if (!targetElement || !(targetElement instanceof HTMLElement)) return false;
  const tagName = targetElement.tagName.toLowerCase();
  return (
    targetElement.isContentEditable ||
    tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select"
  );
}

function handleGlobalKeydown(keyboardEvent: KeyboardEvent): void {
  const clozeModal = document.getElementById("study-harvester-cloze-modal");
  if (clozeModal) {
    if (keyboardEvent.key === "Escape") {
      keyboardEvent.preventDefault();
      closeClozeCaptureModal();
      const videoElement = document.querySelector("video");
      if (videoElement && videoElement.paused) void videoElement.play();
    }
    return;
  }

  if (isShadowingPauseActive) {
    if (keyboardEvent.code === "Space") {
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      resumeFromShadowingPause();
      return;
    }
    if (
      keyboardEvent.code === "KeyA" &&
      !keyboardEvent.ctrlKey &&
      !keyboardEvent.altKey &&
      !keyboardEvent.metaKey
    ) {
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      replayLastShadowingSentence();
      return;
    }
  }

  if (isEditableTarget(keyboardEvent.target)) {
    return;
  }

  const isAltC =
    keyboardEvent.altKey &&
    (keyboardEvent.code === "KeyC" || keyboardEvent.key === "c" || keyboardEvent.key === "C");
  if (isAltC) {
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    void triggerClozeCardCapture();
    return;
  }

  const isShiftS =
    keyboardEvent.shiftKey &&
    (keyboardEvent.code === "KeyS" || keyboardEvent.key === "S" || keyboardEvent.key === "s");
  if (isShiftS) {
    keyboardEvent.preventDefault();
    keyboardEvent.stopPropagation();
    toggleShadowingMode();
    return;
  }

  if (
    !keyboardEvent.ctrlKey &&
    !keyboardEvent.altKey &&
    !keyboardEvent.metaKey &&
    !keyboardEvent.shiftKey
  ) {
    if (keyboardEvent.code === "KeyA" || keyboardEvent.key === "a" || keyboardEvent.key === "A") {
      keyboardEvent.preventDefault();
      triggerSentenceReplay();
      return;
    }
    if (keyboardEvent.code === "KeyS" || keyboardEvent.key === "s" || keyboardEvent.key === "S") {
      keyboardEvent.preventDefault();
      triggerSlowSentenceReplay();
      return;
    }
    if (keyboardEvent.code === "KeyD" || keyboardEvent.key === "d" || keyboardEvent.key === "D") {
      keyboardEvent.preventDefault();
      triggerNextSentence();
      return;
    }
  }
}

function initializeWatchPageFeatures(context: {
  setTimeout: (handler: () => void, timeoutMilliseconds: number) => unknown;
}): void {
  const videoId = getVideoIdFromLocation();
  if (currentWatchVideoId !== videoId) {
    currentWatchVideoId = videoId;
    sessionWatchedSeconds = 0;
    observedSubtitleHistory = [];
    currentlyActiveLiveSubtitle = null;
    lastShadowingSentenceText = "";
    isShadowingPauseActive = false;
    removeShadowingCountdownHud();
    closeClozeCaptureModal();
  }

  injectImmersionStyles();
  ensureSubtitlesEnabled();
  void fetchTranscriptSegmentsForActiveVideo();
  void checkMandalaStatusForCurrentPage();
  void readMetadataFromDom().then((metadata) => {
    lastMetadata = metadata;
    updateImmersionHud();
  });

  if (!captionObserver) {
    captionObserver = new MutationObserver(() => {
      trackLiveCaptionProgress();
    });

    const observerTarget =
      document.getElementById("ytp-caption-window-container") ||
      document.querySelector(".ytp-caption-window-container") ||
      document.getElementById("movie_player") ||
      document.body;

    if (observerTarget) {
      captionObserver.observe(observerTarget, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }
  }

  if (!watchedTimerInterval) {
    lastWatchTickTimestamp = Date.now();
    watchedTimerInterval = setInterval(() => {
      const videoElement = document.querySelector("video");
      const currentTimestamp = Date.now();
      const elapsedMilliseconds = currentTimestamp - lastWatchTickTimestamp;
      lastWatchTickTimestamp = currentTimestamp;

      if (videoElement && !videoElement.paused && elapsedMilliseconds > 0) {
        sessionWatchedSeconds += elapsedMilliseconds / 1000;
        if (Math.floor(sessionWatchedSeconds) % 30 === 0) {
          updateImmersionHud();
        }

        if (isSlowReplayActive && slowReplayTargetSegment) {
          const targetEnd =
            slowReplayTargetSegment.startSeconds +
            Math.max(1, slowReplayTargetSegment.durationSeconds);
          if (
            videoElement.currentTime >= targetEnd ||
            videoElement.currentTime < slowReplayTargetSegment.startSeconds
          ) {
            videoElement.playbackRate = originalPlaybackRate;
            isSlowReplayActive = false;
            slowReplayTargetSegment = null;
          }
        }

        trackLiveCaptionProgress();
      }
    }, 100);
  }

  updateImmersionHud();
  scheduleRead(context);
}

function teardownWatchPageFeatures(): void {
  removeImmersionHud();
  removeShadowingCountdownHud();
  closeClozeCaptureModal();
  isShadowingModeActive = false;
  isShadowingPauseActive = false;
  if (shadowingCountdownTimer) {
    clearInterval(shadowingCountdownTimer);
    shadowingCountdownTimer = null;
  }
}

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  main(context) {
    registerBridgeListener({
      "get-open-tabs-catalog": () => browser.runtime.sendMessage({ action: "get-open-tabs-catalog" }),
      "stage-focused-study-queue": (payload) =>
        browser.runtime.sendMessage({ action: "stage-focused-study-queue", payload }),
      "refine-language": (payload) => {
        const { detected, text, channelName, videoId } = payload as VideoChannel & {
          detected: DetectedLanguage;
          text: string;
        };
        return resolveVideoLanguage(detected, text, { channelName, videoId }, document.documentElement.lang);
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
            (currentId !== lastMetadata.videoId || runtimeMessage.refreshLanguage === true);
          if (!needsRead) {
            sendResponse(lastMetadata);
            return;
          }
          void readMetadataFromDom().then((metadata) => {
            lastMetadata = metadata;
            updateImmersionHud();
            sendResponse(metadata);
          });
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

    context.addEventListener(window, "keydown", handleGlobalKeydown, { capture: true });
    context.addEventListener(document, "keydown", handleGlobalKeydown, { capture: true });

    document.addEventListener("click", () => {
      if (isPillarPopoverOpen) {
        isPillarPopoverOpen = false;
        updateImmersionHud();
      }
    });

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
