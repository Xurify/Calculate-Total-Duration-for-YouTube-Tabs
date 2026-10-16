/**
 * YouTube MAIN-world content script. Serves transcripts to the isolated content script
 * and, where WebMCP is available, registers tools on document.modelContext for AI agents.
 */
import {
  isWebMcpSupported,
  registerWebMcpTool,
  type WebMcpToolDefinition,
} from "../utils/webmcp";
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  type DetectedLanguage,
} from "../utils/captionLanguage";
import { sendBridgeRequest } from "../utils/webmcpBridge";
import {
  CARDS_INPUT_SCHEMA,
  COLLECTION_TARGET_PROPERTIES,
  MAX_CARDS_PER_CALL,
  type AddSentencesInput,
} from "../utils/clozemasterTools";
import { buildSentences, type TranscriptSegment } from "../utils/transcript";
import { extractChaptersFromPlayerResponse } from "../utils/chapters";
import { listSavedSessionsTool, openSavedSessionTool } from "../utils/sessionTools";
import { CLEAR_STAGED_CARDS_INPUT_SCHEMA, type ClearStagedCardsInput } from "../utils/stagedCardTools";
import type { StagedClozeCard } from "../utils/storage";
import {
  getPlayerResponse as getPlayerResponseFromWindow,
  getVideoIdFromLocation as getVideoIdFromCurrentLocation,
  loadTranscript,
  parseDurationText,
  serveTranscriptRequests,
  type PlayerResponseData,
} from "../utils/youtubeTranscript";

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

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  world: "MAIN",
  runAt: "document_idle",
  async main() {
    serveTranscriptRequests();

    if (!isWebMcpSupported()) {
      return;
    }

    const abortController = new AbortController();

    const getActiveVideoDetailsTool: WebMcpToolDefinition<
      Record<string, unknown>,
      unknown
    > = {
      name: "youtube_get_current_video",
      description:
        "Returns comprehensive metadata and playback state for the currently active YouTube video or short, including duration, current time, remaining time, language, volume, and its chapters with start times. Seek to a chapter with youtube_control_playback, or pass its start and end to youtube_get_transcript to read just that chapter.",
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
          chapters: extractChaptersFromPlayerResponse(playerResponse, isLive ? 0 : durationSeconds),
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
      { targetLanguageCode?: string; startSeconds?: number; endSeconds?: number; unit?: "sentence" | "caption" },
      unknown
    > = {
      name: "youtube_get_transcript",
      description:
        "Extracts the timestamped transcript of the current YouTube video in its original language, from the same source as YouTube's \"Show transcript\" panel (never auto-translated). By default segments are whole sentences, rebuilt from the caption lines, which is what cloze cards and active recall need; pass unit \"caption\" for the raw caption lines.",
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
          unit: {
            type: "string",
            enum: ["sentence", "caption"],
            description: "\"sentence\" (default) for whole sentences, \"caption\" for the caption lines as YouTube shows them",
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

        const { track, source, segments: captionSegments } = await loadTranscript(
          videoId,
          playerResponse,
          inputArguments.targetLanguageCode,
          { allowOpeningPanel: true }
        );

        let punctuated: boolean | undefined;
        let segmentsToFilter: TranscriptSegment[] = captionSegments;
        if (inputArguments.unit !== "caption") {
          const built = buildSentences(captionSegments);
          punctuated = built.punctuated;
          segmentsToFilter = built.sentences.map((sentence) => ({
            startSeconds: Math.round(sentence.startSeconds * 10) / 10,
            durationSeconds: Math.round((sentence.endSeconds - sentence.startSeconds) * 10) / 10,
            text: sentence.text,
          }));
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
          languageCode: track?.languageCode ?? null,
          languageName: track?.name?.simpleText ?? track?.languageCode ?? null,
          isAutoGenerated: track?.kind === "asr",
          source,
          unit: inputArguments.unit === "caption" ? "caption" : "sentence",
          ...(punctuated === false
            ? { note: "These captions have no punctuation, so sentence boundaries are approximate." }
            : {}),
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
      name: "youtube_control_playback",
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
      name: "youtube_list_open_tabs",
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
      name: "youtube_stage_study_queue",
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

    const languagePairProperty = {
      languagePair: {
        type: "string",
        description:
          'Clozemaster language pair from its URLs, such as "slk-eng" (Slovak for English speakers). Optional when the user studies only one language or has that language open in Clozemaster; otherwise the error lists the pairs to choose from.',
      },
    };

    const clozemasterListCollectionsTool: WebMcpToolDefinition<{ languagePair?: string }, unknown> = {
      name: "clozemaster_list_collections",
      description:
        "Lists the user's own Clozemaster collections (decks) for one language, with IDs, slugs, play URLs and sentence counts, without leaving YouTube: the extension uses an open Clozemaster tab or opens one in the background. The first call from this page asks the user to allow it. On failure it returns reason and instruction.",
      inputSchema: { type: "object", properties: languagePairProperty },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (inputArguments) => sendBridgeRequest("clozemaster-list", inputArguments),
    };

    const clozemasterAddSentencesTool: WebMcpToolDefinition<
      AddSentencesInput & { languagePair?: string } & Record<string, unknown>,
      unknown
    > = {
      name: "clozemaster_add_sentences",
      description: `Adds cloze sentences from this video to the user's Clozemaster without leaving YouTube. Pass collectionId to add to an existing collection (deck), or collectionName to add to the collection with that name, creating a new deck if there is none. Each sentence must be in the video's language with exactly one word wrapped in {{ }}, plus a translation; youtube_get_transcript gives whole sentences to pick from. At most ${MAX_CARDS_PER_CALL} sentences per call; call again with the same collection for a bigger deck. The user approves every call in a separate window. Requires Clozemaster Pro.`,
      inputSchema: {
        type: "object",
        properties: { ...languagePairProperty, ...COLLECTION_TARGET_PROPERTIES, cards: CARDS_INPUT_SCHEMA },
        required: ["cards"],
      },
      annotations: { readOnlyHint: false },
      execute: (inputArguments) => sendBridgeRequest("clozemaster-add", inputArguments),
    };

    const clozemasterGetStagedCardsTool: WebMcpToolDefinition<{ language?: string }, unknown> = {
      name: "clozemaster_get_staged_cards",
      description:
        "Returns the sentences the user captured from YouTube videos with the Cloze button and has not yet sent to Clozemaster. Each card has an id, the sentence with its cloze word in {{ }}, a translation (empty when the user left it for you to write), the language code and the video it came from. Pass language to keep only one language. Send them with clozemaster_add_sentences, then pass their ids to clozemaster_clear_staged_cards. The first call from this page asks the user to allow it.",
      inputSchema: {
        type: "object",
        properties: {
          language: {
            type: "string",
            description: "Optional language code (e.g. 'sk') to return only cards in that language",
          },
        },
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (inputArguments) => {
        const response = await sendBridgeRequest<Record<string, never>, { success: boolean; cards?: StagedClozeCard[]; errorMessage?: string }>(
          "get-staged-cloze-cards",
          {}
        );
        if (!response?.success || !Array.isArray(response.cards)) return response;
        const languageFilter = inputArguments.language?.trim().toLowerCase();
        const cards = response.cards.filter(
          (card) => !languageFilter || (card.language ?? "").toLowerCase() === languageFilter
        );
        return {
          success: true,
          count: cards.length,
          cards: cards.map((card) => ({
            id: card.id,
            sentence: card.sentence,
            targetWord: card.targetWord,
            translation: card.translation,
            hint: card.hint,
            notes: card.notes,
            language: card.language ?? null,
            videoId: card.videoId,
            videoTitle: card.videoTitle,
            timestampSeconds: card.timestampSeconds,
            createdAt: card.createdAt,
          })),
        };
      },
    };

    const clozemasterClearStagedCardsTool: WebMcpToolDefinition<ClearStagedCardsInput, unknown> = {
      name: "clozemaster_clear_staged_cards",
      description:
        "Removes captured sentences from the capture queue after clozemaster_add_sentences has added them. Pass the ids from clozemaster_get_staged_cards; with no ids the whole queue is cleared. The user must approve this in a separate window before anything is removed.",
      inputSchema: CLEAR_STAGED_CARDS_INPUT_SCHEMA,
      annotations: { readOnlyHint: false, destructiveHint: true },
      execute: (inputArguments) => sendBridgeRequest("clear-staged-cloze-cards", { ids: inputArguments.ids }),
    };

    const mandalaGetStatusTool: WebMcpToolDefinition<Record<string, unknown>, unknown> = {
      name: "mandala_get_status",
      description:
        "Returns the user's Mandala Method pillars (index and title) and which of them already hold the current video on their shelf (savedPillarIndexes). Works from the extension's cache when no Mandala tab is open. Call it before mandala_save_video_to_shelf to pick a pillarIndex. The first call from this page asks the user to allow it.",
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: () => sendBridgeRequest("mandala-status", {}),
    };

    const mandalaSaveToShelfTool: WebMcpToolDefinition<{ pillarIndex: number; kind?: "repeat" | "once" }, unknown> = {
      name: "mandala_save_video_to_shelf",
      description:
        "Saves the current video to the shelf of one Mandala pillar, so watch time can be logged against that pillar's action. Pass pillarIndex from mandala_get_status. When no Mandala tab is open the link is queued and reaches Mandala the next time the user opens it. The user must approve this in a separate window.",
      inputSchema: {
        type: "object",
        properties: {
          pillarIndex: { type: "number", description: "Index of the pillar (0 to 7), from mandala_get_status" },
          kind: {
            type: "string",
            enum: ["repeat", "once"],
            description: '"repeat" (default) for a resource to come back to, "once" for a one-time item',
          },
        },
        required: ["pillarIndex"],
      },
      annotations: { readOnlyHint: false },
      execute: (inputArguments) =>
        sendBridgeRequest("mandala-save", { pillarIndex: inputArguments.pillarIndex, kind: inputArguments.kind }),
    };

    const mandalaLogWatchTimeTool: WebMcpToolDefinition<{ minutes?: number }, unknown> = {
      name: "mandala_log_watch_time",
      description:
        "Logs watch time for the current video against its Mandala pillar action. Without minutes it logs the time watched in this tab since the video opened, the same amount the in-player HUD shows. The video must already be on a pillar's shelf (see mandala_save_video_to_shelf). The user must approve this in a separate window.",
      inputSchema: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "Minutes to log. Omit to log the time watched in this tab.",
          },
        },
      },
      annotations: { readOnlyHint: false },
      execute: (inputArguments) => sendBridgeRequest("mandala-log", { minutes: inputArguments.minutes }),
    };

    await Promise.all([
      registerWebMcpTool(getActiveVideoDetailsTool, abortController.signal),
      registerWebMcpTool(getVideoTranscriptTool, abortController.signal),
      registerWebMcpTool(controlPlaybackTool, abortController.signal),
      registerWebMcpTool(getOpenTabsCatalogTool, abortController.signal),
      registerWebMcpTool(stageFocusedStudyQueueTool, abortController.signal),
      registerWebMcpTool(listSavedSessionsTool, abortController.signal),
      registerWebMcpTool(openSavedSessionTool, abortController.signal),
      registerWebMcpTool(clozemasterListCollectionsTool, abortController.signal),
      registerWebMcpTool(clozemasterAddSentencesTool, abortController.signal),
      registerWebMcpTool(clozemasterGetStagedCardsTool, abortController.signal),
      registerWebMcpTool(clozemasterClearStagedCardsTool, abortController.signal),
      registerWebMcpTool(mandalaGetStatusTool, abortController.signal),
      registerWebMcpTool(mandalaSaveToShelfTool, abortController.signal),
      registerWebMcpTool(mandalaLogWatchTimeTool, abortController.signal),
    ]);
  },
});
