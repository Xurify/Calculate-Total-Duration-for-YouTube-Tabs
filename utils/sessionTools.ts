/**
 * WebMCP tools over Study Harvester's saved sessions, registered on YouTube and Mandala pages.
 * Both pages reach the extension through the same bridge actions.
 */
import type { WebMcpToolDefinition } from "./webmcp";
import { sendBridgeRequest } from "./webmcpBridge";

export const listSavedSessionsTool: WebMcpToolDefinition<Record<string, unknown>, unknown> = {
  name: "youtube_list_saved_sessions",
  description:
    "Lists the sessions saved in Study Harvester, including the backlogs youtube_stage_study_queue stashed, with each session's id, name, video count, total duration, languages and videos. Use it to find a stashed video and reopen it with youtube_open_saved_session. The first call from this page opens an approval window, so the user must allow it.",
  annotations: {
    readOnlyHint: true,
    untrustedContentHint: true,
  },
  execute: () => sendBridgeRequest("get-saved-sessions", {}),
};

export const openSavedSessionTool: WebMcpToolDefinition<
  { sessionId: string; urls?: string[] } & Record<string, unknown>,
  unknown
> = {
  name: "youtube_open_saved_session",
  description:
    "Reopens the videos of a saved session as background tabs in this window. Pass the sessionId from youtube_list_saved_sessions, and optionally urls to reopen only some of its videos. Videos already open in a tab are skipped. The session stays saved. The user must approve this in a separate window before any tab opens.",
  inputSchema: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Id of the session, from youtube_list_saved_sessions",
      },
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Optional subset of the session's video URLs to open; omit to open the whole session",
      },
    },
    required: ["sessionId"],
  },
  annotations: {
    readOnlyHint: false,
  },
  execute: (inputArguments) =>
    sendBridgeRequest("open-saved-session", { sessionId: inputArguments.sessionId, urls: inputArguments.urls }),
};
