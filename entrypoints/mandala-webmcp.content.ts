/**
 * Mandala WebMCP Content Script (runs in MAIN world).
 * Injects Study Harvester tools onto mandalamethod.vercel.app so that browser AI
 * agents can query open YouTube tabs, stage study queues, and inspect Chrome's Reading
 * List directly alongside Mandala's chart tools (PR #12).
 */
import {
  isWebMcpSupported,
  registerWebMcpTool,
  type WebMcpToolDefinition,
} from "../utils/webmcp";
import { sendBridgeRequest } from "../utils/webmcpBridge";

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
    backgroundColor: "#0f172a",
    color: "#f8fafc",
    padding: "12px 18px",
    borderRadius: "10px",
    boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3)",
    fontSize: "14px",
    fontWeight: "500",
    fontFamily: "system-ui, -apple-system, sans-serif",
    zIndex: "999999",
    border: "1px solid rgba(255, 255, 255, 0.12)",
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

export default defineContentScript({
  matches: [
    "https://mandalamethod.vercel.app/*",
    "http://localhost:3000/*",
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
        "Returns the complete catalog of all open YouTube tabs across all browser windows, including their titles, channel names, durations, remaining times, and detected languages. Use this while viewing your Mandala chart to align open videos with active learning pillars.",
      annotations: {
        readOnlyHint: true,
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
        "Stages a curated list of YouTube tabs for a focused study session based on your Mandala priorities. Can automatically stash unselected/distraction tabs into extension storage ('Saved Sessions') and close them guilt-free.",
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
        consequentialHint: true,
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

    const getReadingListCatalogTool: WebMcpToolDefinition<Record<string, unknown>, unknown> = {
      name: "get_reading_list_catalog",
      description:
        "Retrieves all unread articles saved in Chrome's Reading List. Enables the agent to match saved articles with Mandala pillars and prepare them for your reading shelf.",
      annotations: {
        readOnlyHint: true,
      },
      execute: async () => {
        return await sendBridgeRequest("get-reading-list-catalog", {});
      },
    };

    const shelveAndClearReadingItemTool: WebMcpToolDefinition<
      { url: string },
      unknown
    > = {
      name: "shelve_and_clear_reading_item",
      description:
        "Removes an item from Chrome's Reading List after it has been reviewed or saved to a Mandala Method pillar shelf using add_link.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL of the reading list item to remove",
          },
        },
        required: ["url"],
      },
      annotations: {
        readOnlyHint: false,
        consequentialHint: true,
      },
      execute: async (inputArguments) => {
        return await sendBridgeRequest("shelve-and-clear-reading-item", inputArguments);
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
