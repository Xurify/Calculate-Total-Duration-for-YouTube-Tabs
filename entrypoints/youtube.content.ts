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

let loadedSegmentsForVideoId: string | null = null;
let cachedTranscriptSegments: TranscriptSegment[] = [];
let isFetchingTranscript = false;

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

function parseDurationFromTimeText(text: string): number {
  const parts = text.trim().split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
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
  const clamped = Math.min(1, Math.max(0, volume));
  videoElement.volume = clamped;
  if (clamped > 0 && videoElement.muted) {
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
      const jsonData = (await jsonResponse.json()) as Json3CaptionPayload;
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
    }

    const xmlResponse = await fetch(selectedTrack.baseUrl);
    const xmlText = await xmlResponse.text();
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

    loadedSegmentsForVideoId = videoId;
    cachedTranscriptSegments = segments;
    isFetchingTranscript = false;
    return segments;
  } catch (error) {
    console.warn("[Study Harvester] Failed to load captions:", error);
    isFetchingTranscript = false;
    return [];
  }
}

function getActiveSubtitleSegment(currentTimeSeconds: number): {
  segment: TranscriptSegment | null;
  index: number;
} {
  if (cachedTranscriptSegments.length === 0) {
    const domCaptionElement = document.querySelector(".ytp-caption-segment");
    if (domCaptionElement?.textContent) {
      return {
        segment: {
          startSeconds: Math.max(0, currentTimeSeconds - 1),
          durationSeconds: 3,
          text: domCaptionElement.textContent.trim(),
        },
        index: -1,
      };
    }
    return { segment: null, index: -1 };
  }

  for (let index = 0; index < cachedTranscriptSegments.length; index++) {
    const candidate = cachedTranscriptSegments[index];
    const segmentEnd = candidate.startSeconds + Math.max(1, candidate.durationSeconds);
    if (currentTimeSeconds >= candidate.startSeconds && currentTimeSeconds <= segmentEnd) {
      return { segment: candidate, index };
    }
  }

  for (let index = cachedTranscriptSegments.length - 1; index >= 0; index--) {
    if (currentTimeSeconds >= cachedTranscriptSegments[index].startSeconds) {
      return { segment: cachedTranscriptSegments[index], index };
    }
  }

  return { segment: cachedTranscriptSegments[0], index: 0 };
}

function showImmersionToast(messageText: string, accentColor = "#e3aa50") {
  const existingToast = document.getElementById("study-harvester-hud-toast");
  if (existingToast) {
    existingToast.remove();
  }

  const toastElement = document.createElement("div");
  toastElement.id = "study-harvester-hud-toast";
  toastElement.textContent = messageText;
  Object.assign(toastElement.style, {
    position: "fixed",
    bottom: "32px",
    right: "32px",
    backgroundColor: "#231f1b",
    color: "#efe7da",
    padding: "12px 20px",
    borderRadius: "10px",
    boxShadow: "0 16px 36px rgba(0, 0, 0, 0.75)",
    fontSize: "13px",
    fontWeight: "600",
    letterSpacing: "0.02em",
    fontFamily: "system-ui, -apple-system, sans-serif",
    zIndex: "9999999",
    border: "1px solid rgba(239, 231, 218, 0.16)",
    borderLeft: `4px solid ${accentColor}`,
    transition: "opacity 0.22s ease-out, transform 0.22s ease-out",
    opacity: "0",
    transform: "translateY(8px)",
    pointerEvents: "none",
  });

  document.body.appendChild(toastElement);
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

  const { segment, index } = getActiveSubtitleSegment(videoElement.currentTime);
  if (!segment) {
    showImmersionToast("No active sentence to replay");
    return;
  }

  const distanceIntoSentence = videoElement.currentTime - segment.startSeconds;
  if (distanceIntoSentence < 0.45 && index > 0 && cachedTranscriptSegments[index - 1]) {
    const previousSegment = cachedTranscriptSegments[index - 1];
    videoElement.currentTime = previousSegment.startSeconds;
    showImmersionToast(`⟲ Replaying: “${previousSegment.text.slice(0, 40)}…”`);
  } else {
    videoElement.currentTime = segment.startSeconds;
    showImmersionToast(`⟲ Replaying: “${segment.text.slice(0, 40)}…”`);
  }
}

function triggerSlowSentenceReplay(): void {
  const videoElement = document.querySelector("video");
  if (!videoElement) return;

  const { segment } = getActiveSubtitleSegment(videoElement.currentTime);
  if (!segment) {
    showImmersionToast("No active sentence for slow replay");
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
    showImmersionToast("End of transcript reached");
  }
}

function toggleShadowingMode(): void {
  isShadowingModeActive = !isShadowingModeActive;
  if (isShadowingModeActive) {
    showImmersionToast("🎙️ Shadowing Mode ON: Pauses at sentence ends", "#48b788");
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

function showShadowingCountdownHud(secondsRemaining: number, spokenSentenceText: string) {
  let hudContainer = document.getElementById("study-harvester-shadowing-hud");
  if (!hudContainer) {
    hudContainer = document.createElement("div");
    hudContainer.id = "study-harvester-shadowing-hud";
    Object.assign(hudContainer.style, {
      position: "fixed",
      top: "16%",
      left: "50%",
      transform: "translateX(-50%)",
      backgroundColor: "#231f1b",
      color: "#efe7da",
      padding: "16px 28px",
      borderRadius: "14px",
      boxShadow: "0 24px 48px rgba(0, 0, 0, 0.8)",
      fontSize: "15px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      zIndex: "9999999",
      border: "1px solid rgba(239, 231, 218, 0.2)",
      textAlign: "center",
      minWidth: "320px",
      pointerEvents: "none",
      transition: "opacity 0.2s ease-in-out",
    });
    document.body.appendChild(hudContainer);
  }

  hudContainer.innerHTML = `
    <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: #e3aa50; margin-bottom: 6px; font-weight: 700;">
      🎙️ Shadowing Practice · Repeat Now
    </div>
    <div style="font-size: 14px; font-weight: 500; color: #efe7da; margin-bottom: 12px; font-style: italic;">
      “${spokenSentenceText}”
    </div>
    <div style="display: flex; align-items: center; justify-content: center; gap: 8px;">
      <span style="font-size: 26px; font-weight: 800; color: #48b788; font-variant-numeric: tabular-nums;">
        ${secondsRemaining}
      </span>
      <span style="font-size: 13px; color: #a89e90;">seconds remaining</span>
    </div>
  `;
}

function removeShadowingCountdownHud(): void {
  const existingHud = document.getElementById("study-harvester-shadowing-hud");
  if (existingHud) {
    existingHud.remove();
  }
}

function handleShadowingSentenceBoundary(currentTimeSeconds: number): void {
  if (!isShadowingModeActive || isShadowingPauseActive) return;

  const videoElement = document.querySelector("video");
  if (!videoElement || videoElement.paused) return;

  const { segment } = getActiveSubtitleSegment(currentTimeSeconds);
  if (!segment) return;

  const segmentEndTime = segment.startSeconds + Math.max(1, segment.durationSeconds);
  const remainingTimeInSegment = segmentEndTime - currentTimeSeconds;

  if (remainingTimeInSegment <= 0.08 && remainingTimeInSegment >= -0.2) {
    videoElement.pause();
    isShadowingPauseActive = true;

    let countdownSeconds = 3;
    showShadowingCountdownHud(countdownSeconds, segment.text);

    shadowingCountdownTimer = setInterval(() => {
      countdownSeconds--;
      if (countdownSeconds > 0) {
        showShadowingCountdownHud(countdownSeconds, segment.text);
      } else {
        if (shadowingCountdownTimer) {
          clearInterval(shadowingCountdownTimer);
          shadowingCountdownTimer = null;
        }
        removeShadowingCountdownHud();
        isShadowingPauseActive = false;
        videoElement.currentTime = segmentEndTime + 0.05;
        void videoElement.play();
      }
    }, 1000);
  }
}

function pickTargetClozeWord(sentenceText: string): string {
  const selection = window.getSelection()?.toString().trim();
  if (selection && sentenceText.toLowerCase().includes(selection.toLowerCase())) {
    return selection;
  }

  const cleanWords = sentenceText
    .replace(/[.,/#!$%^&*;:{}=\-_`~()?"'«»]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4);

  if (cleanWords.length > 0) {
    cleanWords.sort((firstWord, secondWord) => secondWord.length - firstWord.length);
    return cleanWords[0];
  }

  return sentenceText.split(/\s+/)[0] || "word";
}

async function triggerClozeCardCapture(): Promise<void> {
  const videoElement = document.querySelector("video");
  const currentTime = videoElement ? videoElement.currentTime : 0;

  let sentenceText = "";
  const { segment } = getActiveSubtitleSegment(currentTime);
  if (segment?.text) {
    sentenceText = segment.text;
  } else {
    const domCaption = document.querySelector(".ytp-caption-segment");
    sentenceText = domCaption?.textContent?.trim() || "";
  }

  if (!sentenceText) {
    showImmersionToast("No active subtitle found at current time", "#e37050");
    return;
  }

  const targetWord = pickTargetClozeWord(sentenceText);
  const clozePattern = new RegExp(`\\b${targetWord}\\b`, "i");
  const maskedSentence = sentenceText.replace(clozePattern, `{{${targetWord}}}`);

  const stagedCard: StagedClozeCard = {
    id: crypto.randomUUID(),
    sentence: maskedSentence.includes("{{") ? maskedSentence : `{{${targetWord}}} ${sentenceText}`,
    targetWord,
    translation: lastMetadata.title || "YouTube Immersion",
    hint: lastMetadata.channelName,
    videoId: lastMetadata.videoId,
    videoTitle: lastMetadata.title,
    timestampSeconds: Math.floor(currentTime),
    createdAt: Date.now(),
  };

  try {
    await browser.runtime.sendMessage({
      action: "stage-cloze-card",
      card: stagedCard,
    });
    showImmersionToast(`🗂️ Staged Cloze: «${targetWord}»`, "#e3aa50");
  } catch (error) {
    showImmersionToast("Failed to save cloze card", "#e37050");
  }
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
  } catch (error) {
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
  } catch (error) {
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
      right: 14px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 60;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 12px;
      color: #efe7da;
      user-select: none;
      transition: opacity 0.2s ease-in-out;
    }
    .study-harvester-hud-btn {
      background-color: rgba(35, 31, 27, 0.88);
      backdrop-filter: blur(8px);
      color: #efe7da;
      border: 1px solid rgba(239, 231, 218, 0.16);
      padding: 6px 10px;
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
      background-color: rgba(45, 40, 35, 0.96);
      border-color: rgba(227, 170, 80, 0.45);
      color: #ffffff;
    }
    .study-harvester-hud-btn.active {
      background-color: rgba(227, 170, 80, 0.22);
      border-color: #e3aa50;
      color: #e3aa50;
      font-weight: 600;
    }
    .study-harvester-shelf-popover {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      background-color: #231f1b;
      border: 1px solid rgba(239, 231, 218, 0.2);
      border-radius: 10px;
      padding: 8px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.8);
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 220px;
      z-index: 100;
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
      background-color: rgba(227, 170, 80, 0.18);
      color: #ffffff;
    }
  `;
  document.head.appendChild(styleElement);
}

let isPillarPopoverOpen = false;

function updateImmersionHud(): void {
  if (!isWatchOrShorts()) {
    const existingHud = document.getElementById("study-harvester-player-hud");
    if (existingHud) existingHud.remove();
    return;
  }

  injectImmersionStyles();

  const playerContainer =
    document.getElementById("movie_player") ||
    document.querySelector(".html5-video-player") ||
    document.querySelector("#player");

  if (!playerContainer) return;

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
  if (isEditableTarget(keyboardEvent.target)) {
    return;
  }

  if (keyboardEvent.altKey && (keyboardEvent.key === "c" || keyboardEvent.key === "C")) {
    keyboardEvent.preventDefault();
    void triggerClozeCardCapture();
    return;
  }

  if (keyboardEvent.shiftKey && (keyboardEvent.key === "S" || keyboardEvent.key === "s")) {
    keyboardEvent.preventDefault();
    toggleShadowingMode();
    return;
  }

  if (!keyboardEvent.ctrlKey && !keyboardEvent.altKey && !keyboardEvent.metaKey && !keyboardEvent.shiftKey) {
    if (keyboardEvent.key === "a" || keyboardEvent.key === "A") {
      keyboardEvent.preventDefault();
      triggerSentenceReplay();
      return;
    }
    if (keyboardEvent.key === "s" || keyboardEvent.key === "S") {
      keyboardEvent.preventDefault();
      triggerSlowSentenceReplay();
      return;
    }
    if (keyboardEvent.key === "d" || keyboardEvent.key === "D") {
      keyboardEvent.preventDefault();
      triggerNextSentence();
      return;
    }
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

    if (!isWatchOrShorts()) return;

    void fetchTranscriptSegmentsForActiveVideo();
    void checkMandalaStatusForCurrentPage();

    context.addEventListener(window, "keydown", handleGlobalKeydown, { capture: true });

    document.addEventListener("click", () => {
      if (isPillarPopoverOpen) {
        isPillarPopoverOpen = false;
        updateImmersionHud();
      }
    });

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
          if (videoElement.currentTime >= targetEnd || videoElement.currentTime < slowReplayTargetSegment.startSeconds) {
            videoElement.playbackRate = originalPlaybackRate;
            isSlowReplayActive = false;
            slowReplayTargetSegment = null;
          }
        }

        if (isShadowingModeActive) {
          handleShadowingSentenceBoundary(videoElement.currentTime);
        }
      }
    }, 100);

    const target =
      document.querySelector("#primary") ||
      document.querySelector("#content") ||
      document.body;
    if (!target) return;

    const observer = new MutationObserver(() => {
      perf.totalMutations++;
      perf.mutationsSinceLastRead++;
      scheduleRead(context);
    });

    observer.observe(target, {
      childList: true,
      subtree: false,
    });

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

    void readMetadataFromDom().then((metadata) => {
      lastMetadata = metadata;
      updateImmersionHud();
    });
    perf.totalReads++;
    scheduleRead(context);

    const handleNavigationReset = () => {
      sessionWatchedSeconds = 0;
      isShadowingModeActive = false;
      isShadowingPauseActive = false;
      removeShadowingCountdownHud();
      void fetchTranscriptSegmentsForActiveVideo();
      void checkMandalaStatusForCurrentPage();
      scheduleRead(context);
    };

    context.addEventListener(window, "popstate", handleNavigationReset);
    context.addEventListener(window, "hashchange", handleNavigationReset);
    context.addEventListener(document, "yt-navigate-finish", handleNavigationReset);

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
  },
});
