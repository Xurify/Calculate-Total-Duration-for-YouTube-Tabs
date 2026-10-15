/**
 * YouTube WebMCP Content Script (runs in MAIN world).
 * Registers tools on document.modelContext for browser AI agents.
 */
import {
  isWebMcpSupported,
  registerWebMcpTool,
  type WebMcpToolDefinition,
} from "../utils/webmcp";
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  normalizeLanguageCode,
  type DetectedLanguage,
} from "../utils/captionLanguage";
import { sendBridgeRequest } from "../utils/webmcpBridge";

interface PlayerCaptionTrack {
  baseUrl: string;
  name?: { simpleText?: string; runs?: Array<{ text: string }> };
  vssId?: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
}

interface PlayerResponseCaptionContainer {
  captionTracks?: PlayerCaptionTrack[];
}

interface PlayerResponseData {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    isLive?: boolean;
    lengthSeconds?: string;
    shortDescription?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: PlayerResponseCaptionContainer;
  };
}

function showHarvesterToast(messageText: string) {
  const existingToast = document.getElementById("webmcp-harvester-toast");
  if (existingToast) {
    existingToast.remove();
  }

  const toastContainer = document.createElement("div");
  toastContainer.id = "webmcp-harvester-toast";
  toastContainer.textContent = messageText;
  Object.assign(toastContainer.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    backgroundColor: "#231f1b",
    color: "#efe7da",
    padding: "12px 18px",
    borderRadius: "12px",
    boxShadow: "0 14px 36px -20px rgba(0, 0, 0, 0.7)",
    fontSize: "14px",
    fontWeight: "500",
    fontFamily: "system-ui, -apple-system, sans-serif",
    zIndex: "999999",
    border: "1px solid rgba(239, 231, 218, 0.14)",
    borderLeft: "4px solid #e3aa50",
    transition: "opacity 0.25s ease-in-out, transform 0.25s ease-in-out",
    opacity: "0",
    transform: "translateY(8px)",
    pointerEvents: "none",
  });

  document.body.appendChild(toastContainer);
  requestAnimationFrame(() => {
    toastContainer.style.opacity = "1";
    toastContainer.style.transform = "translateY(0)";
  });

  window.setTimeout(() => {
    toastContainer.style.opacity = "0";
    toastContainer.style.transform = "translateY(8px)";
    window.setTimeout(() => toastContainer.remove(), 300);
  }, 4000);
}

interface MoviePlayerElement extends HTMLElement {
  getPlayerResponse?: () => PlayerResponseData;
  playVideo?: () => void;
  pauseVideo?: () => void;
  seekTo?: (seconds: number, allowSeekAhead?: boolean) => void;
  setPlaybackRate?: (rate: number) => void;
  setVolume?: (volume: number) => void;
  mute?: () => void;
  unMute?: () => void;
  isMuted?: () => boolean;
  getVolume?: () => number;
  getCurrentTime?: () => number;
  getDuration?: () => number;
  getPlayerState?: () => number;
}

function getMoviePlayerElement(): MoviePlayerElement | null {
  return document.getElementById("movie_player") as MoviePlayerElement | null;
}

function getVideoIdFromCurrentLocation(): string | null {
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
    // Ignore URL parse failures
  }
  return null;
}

function getPlayerResponseFromWindow(expectedVideoId?: string | null): PlayerResponseData | null {
  const moviePlayer = getMoviePlayerElement();
  if (typeof moviePlayer?.getPlayerResponse === "function") {
    try {
      const response = moviePlayer.getPlayerResponse();
      if (response?.videoDetails) {
        if (!expectedVideoId || response.videoDetails.videoId === expectedVideoId) {
          return response;
        }
      }
    } catch {
      // Continue fallback search
    }
  }

  const windowWithPlayerResponse = window as unknown as {
    ytInitialPlayerResponse?: PlayerResponseData;
  };
  if (windowWithPlayerResponse.ytInitialPlayerResponse?.videoDetails) {
    if (
      !expectedVideoId ||
      windowWithPlayerResponse.ytInitialPlayerResponse.videoDetails.videoId === expectedVideoId
    ) {
      return windowWithPlayerResponse.ytInitialPlayerResponse;
    }
  }

  for (const scriptElement of document.querySelectorAll("script:not([src])")) {
    const scriptContent = scriptElement.textContent;
    if (!scriptContent || !scriptContent.includes("ytInitialPlayerResponse")) {
      continue;
    }
    const match =
      scriptContent.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
      scriptContent.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
    if (match) {
      try {
        const parsedResponse = JSON.parse(match[1]) as PlayerResponseData;
        if (!expectedVideoId || parsedResponse.videoDetails?.videoId === expectedVideoId) {
          return parsedResponse;
        }
      } catch {
        // Continue searching
      }
    }
  }

  return null;
}

function parseDurationText(text: string): number {
  const parts = text.trim().split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

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

function decodeHtmlEntities(encodedText: string): string {
  return encodedText
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_fullMatch, charCodeString) => String.fromCharCode(Number(charCodeString)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_fullMatch, hexCodeString) =>
      String.fromCharCode(parseInt(hexCodeString, 16))
    );
}

async function fetchTranscriptSegments(
  baseUrl: string
): Promise<TranscriptSegment[]> {
  const segments: TranscriptSegment[] = [];

  try {
    const jsonResponse = await fetch(`${baseUrl}&fmt=json3`);
    if (jsonResponse.ok) {
      const jsonData = (await jsonResponse.json()) as Json3CaptionPayload;
      if (Array.isArray(jsonData.events)) {
        for (const captionEvent of jsonData.events) {
          const startSeconds = (captionEvent.tStartMs ?? 0) / 1000;
          const durationSeconds = (captionEvent.dDurationMs ?? 0) / 1000;
          const text = (captionEvent.segs ?? [])
            .map((segment) => segment.utf8 ?? "")
            .join("")
            .trim();
          if (text) {
            segments.push({ startSeconds, durationSeconds, text });
          }
        }
        if (segments.length > 0) {
          return segments;
        }
      }
    }
  } catch {
    // Fall back to XML parsing
  }

  try {
    const xmlResponse = await fetch(baseUrl);
    const xmlText = await xmlResponse.text();
    const textTagRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
    let match: RegExpExecArray | null;
    while ((match = textTagRegex.exec(xmlText)) !== null) {
      const startSeconds = parseFloat(match[1]) || 0;
      const durationSeconds = match[2] ? parseFloat(match[2]) || 0 : 0;
      const rawText = match[3].replace(/<[^>]+>/g, "").trim();
      const text = decodeHtmlEntities(rawText);
      if (text) {
        segments.push({ startSeconds, durationSeconds, text });
      }
    }
  } catch (error) {
    console.warn("[WebMCP] Failed to fetch or parse transcript XML:", error);
  }

  return segments;
}

function readYtcfg(key: string): unknown {
  const ytcfg = (window as unknown as { ytcfg?: { get?: (name: string) => unknown } }).ytcfg;
  try {
    return ytcfg?.get?.(key);
  } catch {
    return undefined;
  }
}

function protobufVarint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 127) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  bytes.push(value);
  return bytes;
}

function protobufBytesField(fieldNumber: number, bytes: number[]): number[] {
  return [...protobufVarint((fieldNumber << 3) | 2), ...protobufVarint(bytes.length), ...bytes];
}

/**
 * Rebuilds the params the "Show transcript" button sends to get_panel:
 * field 149 { 1: videoId, 3: 1, 6: caption vssId such as ".et" or "a.et" }.
 * Captured from YouTube's own request in October 2026.
 */
function buildTranscriptPanelParams(videoId: string, vssId?: string): string {
  const encoder = new TextEncoder();
  let inner = [...protobufBytesField(1, [...encoder.encode(videoId)]), 0x18, 1];
  if (vssId) inner = [...inner, ...protobufBytesField(6, [...encoder.encode(vssId)])];
  return btoa(String.fromCharCode(...protobufBytesField(149, inner)));
}

function collectTranscriptSegmentModels(node: unknown, found: Array<{ simpleText?: string; timestamp?: string }>) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) collectTranscriptSegmentModels(child, found);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "transcriptSegmentViewModel" && value && typeof value === "object") {
      found.push(value as { simpleText?: string; timestamp?: string });
    } else {
      collectTranscriptSegmentModels(value, found);
    }
  }
}

/** Same request the "Show transcript" panel makes, so the text is the track itself, never a translation. */
async function fetchPanelTranscript(videoId: string, vssId?: string): Promise<TranscriptSegment[]> {
  const context = readYtcfg("INNERTUBE_CONTEXT");
  if (!context) return [];

  try {
    const response = await fetch("/youtubei/v1/get_panel?prettyPrint=false", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Youtube-Client-Name": String(readYtcfg("INNERTUBE_CONTEXT_CLIENT_NAME") ?? "1"),
        "X-Youtube-Client-Version": String(readYtcfg("INNERTUBE_CLIENT_VERSION") ?? ""),
      },
      body: JSON.stringify({
        context,
        panelId: "PAmodern_transcript_view",
        params: buildTranscriptPanelParams(videoId, vssId),
      }),
    });
    if (!response.ok) return [];

    const models: Array<{ simpleText?: string; timestamp?: string }> = [];
    collectTranscriptSegmentModels(await response.json(), models);
    const segments = models
      .map((model) => ({
        startSeconds: parseDurationText(model.timestamp ?? "0"),
        durationSeconds: 0,
        text: (model.simpleText ?? "").trim(),
      }))
      .filter((segment) => segment.text);
    segments.forEach((segment, index) => {
      const next = segments[index + 1];
      if (next) segment.durationSeconds = Math.max(0, next.startSeconds - segment.startSeconds);
    });
    return segments;
  } catch {
    return [];
  }
}

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  world: "MAIN",
  runAt: "document_idle",
  async main() {
    if (!isWebMcpSupported()) {
      return;
    }

    const abortController = new AbortController();

    const getActiveVideoDetailsTool: WebMcpToolDefinition<
      Record<string, unknown>,
      unknown
    > = {
      name: "get_active_video_details",
      description:
        "Returns comprehensive metadata and playback state for the currently active YouTube video or short, including duration, current time, remaining time, language, and volume.",
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: async () => {
        const videoElement = document.querySelector("video");
        const videoId = getVideoIdFromCurrentLocation();
        const playerResponse = getPlayerResponseFromWindow(videoId);

        let durationSeconds = 0;
        if (videoElement && isFinite(videoElement.duration) && videoElement.duration > 0) {
          durationSeconds = videoElement.duration;
        } else if (playerResponse?.videoDetails?.lengthSeconds) {
          durationSeconds = parseInt(playerResponse.videoDetails.lengthSeconds, 10) || 0;
        } else {
          const durationElement = document.querySelector(".ytp-time-duration");
          if (durationElement?.textContent) {
            durationSeconds = parseDurationText(durationElement.textContent);
          }
        }

        const currentTimeSeconds = videoElement ? videoElement.currentTime : 0;
        const remainingSeconds = Math.max(0, durationSeconds - currentTimeSeconds);

        let title =
          (document.querySelector("h1.ytd-watch-metadata yt-formatted-string") as HTMLElement)?.innerText ||
          (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
          playerResponse?.videoDetails?.title ||
          document.title;
        title = title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim();

        const channelName =
          (document.querySelector("ytd-watch-metadata ytd-channel-name a") as HTMLElement)?.innerText ||
          (document.querySelector("#upload-info #channel-name a") as HTMLElement)?.innerText ||
          playerResponse?.videoDetails?.author ||
          "";

        const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
        const isLive = Boolean(
          playerResponse?.videoDetails?.isLive ||
            (liveBadge && getComputedStyle(liveBadge).display !== "none")
        );

        const captionTracks =
          playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        let detected = detectLanguageFromPlayerResponse(playerResponse);
        if (!detected.language || detected.weak) {
          // browser.i18n lives in the isolated world, so the YouTube content script runs CLD for us.
          detected = await sendBridgeRequest<
            { detected: DetectedLanguage; text: string; channelName: string; videoId: string | null },
            DetectedLanguage
          >(
            "refine-language",
            {
              detected,
              text: languageTextFromPlayerResponse(playerResponse),
              channelName: playerResponse?.videoDetails?.author || channelName,
              videoId,
            }
          ).catch(() => detected);
        }

        return {
          videoId,
          title: title || "YouTube Video",
          channelName,
          durationSeconds: isLive ? 0 : durationSeconds,
          currentTimeSeconds,
          remainingSeconds: isLive ? 0 : remainingSeconds,
          isLive,
          language: detected.language,
          languageName: detected.languageName,
          availableLanguages: captionTracks.map((track) => ({
            code: track.languageCode,
            name: track.name?.simpleText ?? track.languageCode,
            isAutoGenerated: track.kind === "asr",
          })),
          paused: videoElement ? videoElement.paused : true,
          volume: videoElement ? videoElement.volume : 1,
          muted: videoElement ? videoElement.muted : false,
          playbackRate: videoElement ? videoElement.playbackRate : 1,
          url: window.location.href,
        };
      },
    };

    const getVideoTranscriptTool: WebMcpToolDefinition<
      { targetLanguageCode?: string; startSeconds?: number; endSeconds?: number },
      unknown
    > = {
      name: "get_video_transcript",
      description:
        "Extracts timestamped transcript segments for the current YouTube video in its original language, from the same source as YouTube's \"Show transcript\" panel (never auto-translated). Useful for language study, generating cloze review cards, and active recall exercises.",
      inputSchema: {
        type: "object",
        properties: {
          targetLanguageCode: {
            type: "string",
            description: "Optional preferred language code (e.g. 'sk', 'en', 'es', 'de')",
          },
          startSeconds: {
            type: "number",
            description: "Optional start time in seconds to restrict transcript extract",
          },
          endSeconds: {
            type: "number",
            description: "Optional end time in seconds to restrict transcript extract",
          },
        },
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: async (inputArguments) => {
        const videoId = getVideoIdFromCurrentLocation();
        const playerResponse = getPlayerResponseFromWindow(videoId);
        const captionTracks =
          playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

        if (captionTracks.length === 0) {
          return {
            videoId,
            available: false,
            message: "No caption or transcript tracks available for this video.",
            segments: [],
            fullText: "",
          };
        }

        const requestedCode = inputArguments.targetLanguageCode
          ? normalizeLanguageCode(inputArguments.targetLanguageCode)
          : null;
        const requestedTrack = requestedCode
          ? captionTracks.find((track) => normalizeLanguageCode(track.languageCode) === requestedCode)
          : undefined;
        const spokenCode = detectLanguageFromPlayerResponse(playerResponse).language;

        const spokenTracks = spokenCode
          ? captionTracks.filter(
              (track) => normalizeLanguageCode(track.languageCode) === normalizeLanguageCode(spokenCode)
            )
          : [];
        const selectedTrack: PlayerCaptionTrack | undefined =
          requestedTrack ??
          spokenTracks.find((track) => track.kind !== "asr") ??
          spokenTracks[0] ??
          captionTracks.find((track) => track.kind !== "asr") ??
          captionTracks[0];
        let segmentsToFilter: TranscriptSegment[] = [];
        let source: "transcript-panel" | "caption-track" | "transcript-dom" = "transcript-panel";

        if (videoId && selectedTrack) {
          segmentsToFilter = await fetchPanelTranscript(videoId, selectedTrack.vssId);
        }

        if (segmentsToFilter.length === 0 && selectedTrack) {
          source = "caption-track";
          segmentsToFilter = await fetchTranscriptSegments(selectedTrack.baseUrl);
        }

        if (segmentsToFilter.length === 0) {
          source = "transcript-dom";
          const domSegmentElements = document.querySelectorAll(
            "ytd-transcript-segment-renderer, transcript-segment-view-model"
          );
          const domSegments: TranscriptSegment[] = [];
          domSegmentElements.forEach((element) => {
            const timestampText =
              element.querySelector(".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp")
                ?.textContent?.trim() || "";
            const segmentText =
              element.querySelector(".segment-text, .ytAttributedStringHost")?.textContent?.trim() || "";
            if (segmentText) {
              domSegments.push({
                startSeconds: parseDurationText(timestampText),
                durationSeconds: 0,
                text: segmentText,
              });
            }
          });
          segmentsToFilter = domSegments;
        }

        const filteredSegments = segmentsToFilter.filter((segment) => {
          if (
            typeof inputArguments.startSeconds === "number" &&
            segment.startSeconds < inputArguments.startSeconds
          ) {
            return false;
          }
          if (
            typeof inputArguments.endSeconds === "number" &&
            segment.startSeconds > inputArguments.endSeconds
          ) {
            return false;
          }
          return true;
        });

        if (filteredSegments.length === 0) {
          return {
            videoId,
            available: false,
            message: "No transcript segments found or matched the criteria.",
            segments: [],
            fullText: "",
          };
        }

        const fullText = filteredSegments.map((segment) => segment.text).join(" ");

        return {
          videoId,
          available: true,
          languageCode: selectedTrack?.languageCode ?? null,
          languageName: selectedTrack?.name?.simpleText ?? selectedTrack?.languageCode ?? null,
          isAutoGenerated: selectedTrack?.kind === "asr",
          source,
          segmentsCount: filteredSegments.length,
          segments: filteredSegments,
          fullText,
        };
      },
    };

    const controlPlaybackTool: WebMcpToolDefinition<
      {
        action: "play" | "pause" | "toggle" | "seek" | "set_speed" | "set_volume" | "mute" | "unmute";
        seekSeconds?: number;
        playbackSpeed?: number;
        volume?: number;
      },
      unknown
    > = {
      name: "control_playback",
      description:
        "Controls video playback on the active YouTube player (play, pause, toggle, seek, adjust speed, adjust volume, mute, unmute).",
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["play", "pause", "toggle", "seek", "set_speed", "set_volume", "mute", "unmute"],
            description: "Playback action to perform",
          },
          seekSeconds: {
            type: "number",
            description: "Target timestamp in seconds for the seek action (required when action is 'seek')",
          },
          playbackSpeed: {
            type: "number",
            description: "Target playback rate (e.g. 0.75, 1.0, 1.25, 1.5, 2.0; required when action is 'set_speed')",
          },
          volume: {
            type: "number",
            description: "Volume level between 0.0 and 1.0 (required when action is 'set_volume')",
          },
        },
        required: ["action"],
      },
      annotations: {
        readOnlyHint: false,
      },
      execute: (inputArguments) => {
        const moviePlayer = getMoviePlayerElement();
        const videoElement = document.querySelector("video");
        if (!moviePlayer && !videoElement) {
          return { success: false, errorMessage: "No video player element found on the active page." };
        }

        const validActions = [
          "play",
          "pause",
          "toggle",
          "seek",
          "set_speed",
          "set_volume",
          "mute",
          "unmute",
        ] as const;
        if (!validActions.includes(inputArguments.action)) {
          return {
            success: false,
            errorMessage: `Unknown playback action "${inputArguments.action}". Valid actions are: ${validActions.join(", ")}`,
          };
        }

        switch (inputArguments.action) {
          case "play":
            if (typeof moviePlayer?.playVideo === "function") {
              moviePlayer.playVideo();
            } else if (videoElement) {
              void videoElement.play();
            }
            break;
          case "pause":
            if (typeof moviePlayer?.pauseVideo === "function") {
              moviePlayer.pauseVideo();
            } else if (videoElement) {
              videoElement.pause();
            }
            break;
          case "toggle":
            if (typeof moviePlayer?.getPlayerState === "function") {
              if (moviePlayer.getPlayerState() === 1) {
                moviePlayer.pauseVideo?.();
              } else {
                moviePlayer.playVideo?.();
              }
            } else if (videoElement) {
              if (videoElement.paused) {
                void videoElement.play();
              } else {
                videoElement.pause();
              }
            }
            break;
          case "seek":
            if (typeof inputArguments.seekSeconds !== "number" || isNaN(inputArguments.seekSeconds)) {
              return {
                success: false,
                errorMessage: "seekSeconds is required and must be a valid number when action is 'seek'.",
              };
            }
            const targetSeconds = Math.max(0, inputArguments.seekSeconds);
            if (typeof moviePlayer?.seekTo === "function") {
              moviePlayer.seekTo(targetSeconds, true);
            } else if (videoElement) {
              videoElement.currentTime = targetSeconds;
            }
            break;
          case "set_speed":
            if (
              typeof inputArguments.playbackSpeed !== "number" ||
              isNaN(inputArguments.playbackSpeed) ||
              inputArguments.playbackSpeed <= 0
            ) {
              return {
                success: false,
                errorMessage: "playbackSpeed is required and must be a positive number when action is 'set_speed'.",
              };
            }
            if (typeof moviePlayer?.setPlaybackRate === "function") {
              moviePlayer.setPlaybackRate(inputArguments.playbackSpeed);
            }
            if (videoElement) {
              videoElement.playbackRate = inputArguments.playbackSpeed;
            }
            break;
          case "set_volume":
            if (
              typeof inputArguments.volume !== "number" ||
              isNaN(inputArguments.volume) ||
              inputArguments.volume < 0 ||
              inputArguments.volume > 1
            ) {
              return {
                success: false,
                errorMessage: "volume is required and must be a number between 0.0 and 1.0 when action is 'set_volume'.",
              };
            }
            const clampedVolume = inputArguments.volume;
            if (typeof moviePlayer?.setVolume === "function") {
              moviePlayer.setVolume(clampedVolume * 100);
              if (clampedVolume > 0 && typeof moviePlayer?.unMute === "function") {
                moviePlayer.unMute();
              }
            }
            if (videoElement) {
              videoElement.volume = clampedVolume;
              if (clampedVolume > 0 && videoElement.muted) {
                videoElement.muted = false;
              }
            }
            break;
          case "mute":
            if (typeof moviePlayer?.mute === "function") {
              moviePlayer.mute();
            }
            if (videoElement) {
              videoElement.muted = true;
            }
            break;
          case "unmute":
            if (typeof moviePlayer?.unMute === "function") {
              moviePlayer.unMute();
            }
            if (videoElement) {
              videoElement.muted = false;
            }
            break;
        }

        return {
          success: true,
          actionExecuted: inputArguments.action,
          paused: videoElement ? videoElement.paused : undefined,
          currentTime: videoElement ? videoElement.currentTime : moviePlayer?.getCurrentTime?.(),
          duration: videoElement ? videoElement.duration : moviePlayer?.getDuration?.(),
          volume: videoElement ? videoElement.volume : (moviePlayer?.getVolume?.() ?? 100) / 100,
          muted: videoElement ? videoElement.muted : moviePlayer?.isMuted?.(),
          playbackRate: videoElement ? videoElement.playbackRate : 1,
        };
      },
    };

    const getOpenTabsCatalogTool: WebMcpToolDefinition<Record<string, unknown>, unknown> = {
      name: "get_open_tabs_catalog",
      description:
        "Returns the complete catalog of all open YouTube tabs across all browser windows, including their video IDs, titles, channel names, total durations, remaining times, and detected languages. Use this to help the user plan focused study sessions. The first call from this page opens an approval window, so the user must allow it.",
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: async () => {
        return await sendBridgeRequest("get-open-tabs-catalog", {});
      },
    };

    const stageFocusedStudyQueueTool: WebMcpToolDefinition<
      {
        orderedTabIds: number[];
        stashDistractionTabs?: boolean;
        sessionName?: string;
        playbackSpeed?: number;
      },
      unknown
    > = {
      name: "stage_focused_study_queue",
      description:
        "Stages a curated list of YouTube tabs for a focused study session. Can automatically stash unselected/distraction tabs into extension storage ('Saved Sessions') and close them guilt-free. The user must approve this in a separate window before anything is closed or removed.",
      inputSchema: {
        type: "object",
        properties: {
          orderedTabIds: {
            type: "array",
            items: { type: "number" },
            description: "Array of YouTube tab IDs selected for the study session in planned order",
          },
          stashDistractionTabs: {
            type: "boolean",
            description:
              "If true, saves all other open YouTube tabs to a named session in extension storage and closes them to eliminate tab hoarding",
          },
          sessionName: {
            type: "string",
            description: "Custom name for the stashed session (defaults to 'Stashed Backlog')",
          },
          playbackSpeed: {
            type: "number",
            description: "Optional playback speed to set on the primary video",
          },
        },
        required: ["orderedTabIds"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      execute: async (inputArguments) => {
        const result = await sendBridgeRequest("stage-focused-study-queue", inputArguments);

        if (result && typeof result === "object" && "stashedCount" in result) {
          const stashedResult = result as { stashedCount: number };
          if (stashedResult.stashedCount > 0) {
            showHarvesterToast(
              `Stashed ${stashedResult.stashedCount} tabs into "${inputArguments.sessionName || "Stashed Backlog"}"`
            );
          }
        }

        return result;
      },
    };

    await Promise.all([
      registerWebMcpTool(getActiveVideoDetailsTool, abortController.signal),
      registerWebMcpTool(getVideoTranscriptTool, abortController.signal),
      registerWebMcpTool(controlPlaybackTool, abortController.signal),
      registerWebMcpTool(getOpenTabsCatalogTool, abortController.signal),
      registerWebMcpTool(stageFocusedStudyQueueTool, abortController.signal),
    ]);
  },
});
