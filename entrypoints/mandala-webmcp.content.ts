/**
 * Mandala WebMCP Content Script (runs in MAIN world).
 * Injects Study Harvester tools onto mandalamethod.vercel.app so that browser AI
 * agents can query open YouTube tabs, stage study queues, and inspect Chrome's Reading
 * List directly alongside Mandala's chart tools (PR #12 / PR #15).
 */
import {
  isWebMcpSupported,
  registerWebMcpTool,
  type WebMcpToolDefinition,
} from "../utils/webmcp";
import { sendBridgeRequest } from "../utils/webmcpBridge";

export default defineContentScript({
  matches: [
    "https://mandalamethod.vercel.app/*",
    ...(import.meta.env.DEV ? ["http://localhost:5173/*"] : []),
  ],
  world: "MAIN",
  runAt: "document_idle",
  async main() {
    if (!isWebMcpSupported()) {
      return;
    }

    const abortController = new AbortController();

    const getOpenTabsCatalogTool: WebMcpToolDefinition<Record<string, unknown>, unknown> = {
      name: "get_open_tabs_catalog",
      description:
        "Returns the complete catalog of all open YouTube tabs across all browser windows, including their titles, channel names, durations, remaining times, and detected languages. Use this while viewing your Mandala chart to align open videos with active learning pillars. The first call from this page opens an approval window, so the user must allow it.",
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
        "Stages a curated list of YouTube tabs for a focused study session based on your Mandala priorities. Can automatically stash unselected/distraction tabs into extension storage ('Saved Sessions') and close them guilt-free. The user must approve this in a separate window before anything is closed or removed.",
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
        return await sendBridgeRequest("stage-focused-study-queue", inputArguments);
      },
    };

    const getReadingListCatalogTool: WebMcpToolDefinition<Record<string, unknown>, unknown> = {
      name: "get_reading_list_catalog",
      description:
        "Retrieves unread Chrome Reading List articles, each with an id. Pass that id to shelve_and_clear_reading_item. To save one onto a pillar, pass its address as path to add_shelf_link. The first call from this page opens an approval window, so the user must allow it.",
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: true,
      },
      execute: async () => {
        return await sendBridgeRequest("get-reading-list-catalog", {});
      },
    };

    const shelveAndClearReadingItemTool: WebMcpToolDefinition<
      { id: string },
      unknown
    > = {
      name: "shelve_and_clear_reading_item",
      description:
        "Removes one unread Reading List item after it has been saved to a pillar with add_shelf_link. Pass the id from get_reading_list_catalog. The extension resolves that id to the saved address. The user must approve this in a separate window before anything is removed.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Id from get_reading_list_catalog, such as rl_1a2b3c4d. Not a web address.",
          },
        },
        required: ["id"],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
      execute: async (inputArguments) => {
        const id = typeof inputArguments.id === "string" ? inputArguments.id.trim() : "";
        if (!id || id.includes("://") || id.includes("/")) {
          return {
            success: false,
            errorMessage: "Pass the id from get_reading_list_catalog, not a web address.",
          };
        }
        return await sendBridgeRequest("shelve-and-clear-reading-item", { id });
      },
    };

    await Promise.all([
      registerWebMcpTool(getOpenTabsCatalogTool, abortController.signal),
      registerWebMcpTool(stageFocusedStudyQueueTool, abortController.signal),
      registerWebMcpTool(getReadingListCatalogTool, abortController.signal),
      registerWebMcpTool(shelveAndClearReadingItemTool, abortController.signal),
    ]);
  },
});
