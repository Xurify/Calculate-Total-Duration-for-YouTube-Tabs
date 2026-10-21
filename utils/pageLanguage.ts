import { detectLanguageFromPlayerResponse, languageTextFromPlayerResponse, type DetectedLanguage } from "./captionLanguage";
import { getPlayerResponse } from "./youtubeTranscript";

const REQUEST_SOURCE = "study-harvester-language-request";
const RESPONSE_SOURCE = "study-harvester-language-response";
const PLAYER_WAIT_ATTEMPTS = 6;
const PLAYER_WAIT_MS = 500;

export interface PageLanguageSource {
  videoId: string;
  detected: DetectedLanguage;
  text: string;
  channelName: string | null;
}

interface LanguageRequestMessage {
  source: typeof REQUEST_SOURCE;
  requestIdentifier: string;
  videoId: string;
}

interface LanguageResponseMessage {
  source: typeof RESPONSE_SOURCE;
  requestIdentifier: string;
  language: PageLanguageSource | null;
}

/**
 * MAIN world: the player response for the video on screen. The isolated world sees neither
 * movie_player.getPlayerResponse nor window.ytInitialPlayerResponse, and the inline script tag
 * it can read still describes the first page loaded, not one reached by in-app navigation.
 */
export function servePageLanguageRequests(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    const request = event.data as LanguageRequestMessage | undefined;
    if (request?.source !== REQUEST_SOURCE || !request.requestIdentifier || !request.videoId) return;

    void (async () => {
      let playerResponse = getPlayerResponse(request.videoId);
      for (let attempt = 0; !playerResponse && attempt < PLAYER_WAIT_ATTEMPTS; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, PLAYER_WAIT_MS));
        playerResponse = getPlayerResponse(request.videoId);
      }
      let language: PageLanguageSource | null = null;
      try {
        if (playerResponse) {
          language = {
            videoId: request.videoId,
            detected: detectLanguageFromPlayerResponse(playerResponse),
            text: languageTextFromPlayerResponse(playerResponse),
            channelName: playerResponse.videoDetails?.author ?? null,
          };
        }
      } catch {
        language = null;
      }
      window.postMessage(
        { source: RESPONSE_SOURCE, requestIdentifier: request.requestIdentifier, language } satisfies LanguageResponseMessage,
        "*"
      );
    })();
  });
}

/** Isolated world. Page scripts can answer too, so the result is only ever a label. */
export function requestPageLanguage(videoId: string): Promise<PageLanguageSource | null> {
  const timeoutMilliseconds = PLAYER_WAIT_ATTEMPTS * PLAYER_WAIT_MS + 1000;
  return new Promise((resolve) => {
    const requestIdentifier = crypto.randomUUID();

    const timeoutTimer = window.setTimeout(() => {
      window.removeEventListener("message", handleResponse);
      resolve(null);
    }, timeoutMilliseconds);

    function handleResponse(event: MessageEvent) {
      if (event.source !== window) return;
      const response = event.data as LanguageResponseMessage | undefined;
      if (response?.source !== RESPONSE_SOURCE || response.requestIdentifier !== requestIdentifier) return;
      window.clearTimeout(timeoutTimer);
      window.removeEventListener("message", handleResponse);
      const language = response.language;
      resolve(language?.videoId === videoId && language.detected && typeof language.text === "string" ? language : null);
    }

    window.addEventListener("message", handleResponse);
    window.postMessage({ source: REQUEST_SOURCE, requestIdentifier, videoId } satisfies LanguageRequestMessage, "*");
  });
}
