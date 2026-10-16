/**
 * Loads a YouTube video's transcript. Runs in the MAIN world, which can reach
 * movie_player and ytcfg; the isolated content script asks for it with requestPageTranscript.
 */
import { detectLanguageFromPlayerResponse, normalizeLanguageCode } from "./captionLanguage";
import type { TranscriptSegment } from "./transcript";

export interface PlayerCaptionTrack {
  baseUrl: string;
  name?: { simpleText?: string; runs?: Array<{ text: string }> };
  vssId?: string;
  languageCode: string;
  kind?: string;
  isTranslatable?: boolean;
}

export interface PlayerResponseData {
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
      captionTracks?: PlayerCaptionTrack[];
    };
  };
}

export type TranscriptSource = "transcript-panel" | "caption-track" | "transcript-dom";

export interface LoadedTranscript {
  track: PlayerCaptionTrack | null;
  source: TranscriptSource;
  segments: TranscriptSegment[];
}

interface Json3CaptionPayload {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{ utf8?: string }>;
  }>;
}

export function parseDurationText(text: string): number {
  const parts = text.trim().split(":").map((part) => parseInt(part, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

export function getVideoIdFromLocation(): string | null {
  const { pathname, search } = window.location;
  if (pathname.startsWith("/shorts/")) {
    return pathname.match(/\/shorts\/([^/?]+)/)?.[1] ?? null;
  }
  if (pathname === "/watch" && search) {
    return new URLSearchParams(search).get("v");
  }
  return null;
}

export function getPlayerResponse(expectedVideoId?: string | null): PlayerResponseData | null {
  const moviePlayer = document.getElementById("movie_player") as
    | (HTMLElement & { getPlayerResponse?: () => PlayerResponseData })
    | null;
  if (typeof moviePlayer?.getPlayerResponse === "function") {
    try {
      const response = moviePlayer.getPlayerResponse();
      if (response?.videoDetails && (!expectedVideoId || response.videoDetails.videoId === expectedVideoId)) {
        return response;
      }
    } catch {
      // Continue fallback search
    }
  }

  const initial = (window as unknown as { ytInitialPlayerResponse?: PlayerResponseData }).ytInitialPlayerResponse;
  if (initial?.videoDetails && (!expectedVideoId || initial.videoDetails.videoId === expectedVideoId)) {
    return initial;
  }

  for (const scriptElement of document.querySelectorAll("script:not([src])")) {
    const scriptContent = scriptElement.textContent;
    if (!scriptContent?.includes("ytInitialPlayerResponse")) continue;
    const match =
      scriptContent.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
      scriptContent.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as PlayerResponseData;
      if (!expectedVideoId || parsed.videoDetails?.videoId === expectedVideoId) return parsed;
    } catch {
      // Continue searching
    }
  }

  return null;
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

async function fetchCaptionTrackSegments(baseUrl: string): Promise<TranscriptSegment[]> {
  const segments: TranscriptSegment[] = [];

  try {
    const jsonResponse = await fetch(`${baseUrl}&fmt=json3`);
    if (jsonResponse.ok) {
      const jsonData = (await jsonResponse.json()) as Json3CaptionPayload;
      for (const captionEvent of jsonData.events ?? []) {
        const text = (captionEvent.segs ?? [])
          .map((segment) => segment.utf8 ?? "")
          .join("")
          .trim();
        if (text) {
          segments.push({
            startSeconds: (captionEvent.tStartMs ?? 0) / 1000,
            durationSeconds: (captionEvent.dDurationMs ?? 0) / 1000,
            text,
          });
        }
      }
      if (segments.length > 0) return segments;
    }
  } catch {
    // Fall back to XML parsing
  }

  try {
    const xmlText = await (await fetch(baseUrl)).text();
    const textTagRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
    let match: RegExpExecArray | null;
    while ((match = textTagRegex.exec(xmlText)) !== null) {
      const text = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, "").trim());
      if (text) {
        segments.push({
          startSeconds: parseFloat(match[1]) || 0,
          durationSeconds: match[2] ? parseFloat(match[2]) || 0 : 0,
          text,
        });
      }
    }
  } catch (error) {
    console.warn("[Study Harvester] Failed to fetch or parse transcript XML:", error);
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

function readTranscriptFromDom(): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  document.querySelectorAll("ytd-transcript-segment-renderer, transcript-segment-view-model").forEach((element) => {
    const timestampText =
      element.querySelector(".segment-timestamp, .ytwTranscriptSegmentViewModelTimestamp")?.textContent?.trim() || "";
    const text = element.querySelector(".segment-text, .ytAttributedStringHost")?.textContent?.trim() || "";
    if (text) segments.push({ startSeconds: parseDurationText(timestampText), durationSeconds: 0, text });
  });
  return segments;
}

const TRANSCRIPT_PANEL_SELECTOR =
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"], ytd-engagement-panel-section-list-renderer[target-id="PAmodern_transcript_view"]';

/**
 * Last resort when the transcript requests fail: press the description's "Show transcript"
 * button, read the panel, and close it again if it was closed before.
 */
async function readTranscriptByOpeningPanel(): Promise<TranscriptSegment[]> {
  const alreadyShown = readTranscriptFromDom();
  if (alreadyShown.length > 0) return alreadyShown;

  const showButton = document.querySelector<HTMLElement>(
    "ytd-video-description-transcript-section-renderer button"
  );
  if (!showButton) return [];
  showButton.click();

  let segments: TranscriptSegment[] = [];
  for (let attempt = 0; attempt < 24 && segments.length === 0; attempt++) {
    await delay(250);
    segments = readTranscriptFromDom();
  }

  const panel = document.querySelector<HTMLElement>(TRANSCRIPT_PANEL_SELECTOR);
  const closeButton =
    panel?.querySelector<HTMLElement>("#visibility-button button") ??
    panel?.querySelector<HTMLElement>("#visibility-button");
  if (closeButton) closeButton.click();
  else panel?.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  return segments;
}

/** Prefers the requested language, then the spoken language, then any track; uploaded captions over auto-generated. */
export function selectCaptionTrack(
  playerResponse: PlayerResponseData | null,
  requestedLanguageCode?: string | null
): PlayerCaptionTrack | undefined {
  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const requestedCode = requestedLanguageCode ? normalizeLanguageCode(requestedLanguageCode) : null;
  const requestedTrack = requestedCode
    ? captionTracks.find((track) => normalizeLanguageCode(track.languageCode) === requestedCode)
    : undefined;
  const spokenCode = detectLanguageFromPlayerResponse(playerResponse).language;
  const spokenTracks = spokenCode
    ? captionTracks.filter((track) => normalizeLanguageCode(track.languageCode) === normalizeLanguageCode(spokenCode))
    : [];
  return (
    requestedTrack ??
    spokenTracks.find((track) => track.kind !== "asr") ??
    spokenTracks[0] ??
    captionTracks.find((track) => track.kind !== "asr") ??
    captionTracks[0]
  );
}

export async function loadTranscript(
  videoId: string | null,
  playerResponse: PlayerResponseData | null,
  requestedLanguageCode?: string | null,
  options: { allowOpeningPanel?: boolean } = {}
): Promise<LoadedTranscript> {
  const track = selectCaptionTrack(playerResponse, requestedLanguageCode) ?? null;

  if (videoId && track) {
    const segments = await fetchPanelTranscript(videoId, track.vssId);
    if (segments.length > 0) return { track, source: "transcript-panel", segments };
  }
  if (track) {
    const segments = await fetchCaptionTrackSegments(track.baseUrl);
    if (segments.length > 0) return { track, source: "caption-track", segments };
  }
  const segments = options.allowOpeningPanel ? await readTranscriptByOpeningPanel() : readTranscriptFromDom();
  return { track, source: "transcript-dom", segments };
}

const TRANSCRIPT_REQUEST_SOURCE = "study-harvester-transcript-request";
const TRANSCRIPT_RESPONSE_SOURCE = "study-harvester-transcript-response";

export interface PageTranscript {
  videoId: string;
  languageCode: string | null;
  isAutoGenerated: boolean;
  segments: TranscriptSegment[];
}

interface TranscriptRequestMessage {
  source: typeof TRANSCRIPT_REQUEST_SOURCE;
  requestIdentifier: string;
  videoId: string;
  allowOpeningPanel?: boolean;
}

interface TranscriptResponseMessage {
  source: typeof TRANSCRIPT_RESPONSE_SOURCE;
  requestIdentifier: string;
  transcript: PageTranscript | null;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/** MAIN world: answers transcript requests from the isolated content script. */
export function serveTranscriptRequests(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const request = event.data as TranscriptRequestMessage | undefined;
    if (request?.source !== TRANSCRIPT_REQUEST_SOURCE || !request.requestIdentifier || !request.videoId) return;

    void (async () => {
      let transcript: PageTranscript | null = null;
      try {
        // After SPA navigation movie_player can still hold the previous video for a moment.
        let playerResponse = getPlayerResponse(request.videoId);
        for (let attempt = 0; !playerResponse && attempt < 6; attempt++) {
          await delay(500);
          playerResponse = getPlayerResponse(request.videoId);
        }
        if (playerResponse) {
          const loaded = await loadTranscript(request.videoId, playerResponse, null, {
            allowOpeningPanel: request.allowOpeningPanel === true,
          });
          if (loaded.segments.length > 0) {
            transcript = {
              videoId: request.videoId,
              languageCode: loaded.track?.languageCode ?? null,
              isAutoGenerated: loaded.track?.kind === "asr",
              segments: loaded.segments,
            };
          }
        }
      } catch {
        transcript = null;
      }
      window.postMessage(
        {
          source: TRANSCRIPT_RESPONSE_SOURCE,
          requestIdentifier: request.requestIdentifier,
          transcript,
        } satisfies TranscriptResponseMessage,
        "*"
      );
    })();
  });
}

/**
 * Isolated world: asks the MAIN world for a transcript. Page scripts can read and answer
 * these messages too, so treat the result as untrusted text.
 */
export function requestPageTranscript(
  videoId: string,
  options: { allowOpeningPanel?: boolean } = {}
): Promise<PageTranscript | null> {
  const timeoutMilliseconds = options.allowOpeningPanel ? 20_000 : 10_000;
  return new Promise((resolve) => {
    const requestIdentifier = crypto.randomUUID();

    const timeoutTimer = window.setTimeout(() => {
      window.removeEventListener("message", handleResponse);
      resolve(null);
    }, timeoutMilliseconds);

    function handleResponse(event: MessageEvent) {
      if (event.source !== window) return;
      const response = event.data as TranscriptResponseMessage | undefined;
      if (response?.source !== TRANSCRIPT_RESPONSE_SOURCE || response.requestIdentifier !== requestIdentifier) return;
      window.clearTimeout(timeoutTimer);
      window.removeEventListener("message", handleResponse);
      const transcript = response.transcript;
      resolve(transcript?.videoId === videoId && Array.isArray(transcript.segments) ? transcript : null);
    }

    window.addEventListener("message", handleResponse);
    window.postMessage(
      {
        source: TRANSCRIPT_REQUEST_SOURCE,
        requestIdentifier,
        videoId,
        allowOpeningPanel: options.allowOpeningPanel,
      } satisfies TranscriptRequestMessage,
      "*"
    );
  });
}
