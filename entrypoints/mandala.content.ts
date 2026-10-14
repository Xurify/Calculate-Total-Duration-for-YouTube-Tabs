/**
 * Content script running in ISOLATED world on Mandala Method web app.
 * Bridges WebMCP requests from the page's MAIN world to the extension's background service worker.
 */
import { registerBridgeListener } from "../utils/webmcpBridge";

export default defineContentScript({
  matches: [
    "https://mandalamethod.vercel.app/*",
    "http://localhost:5173/*",
  ],
  main() {
    registerBridgeListener({
      "get-open-tabs-catalog": () => browser.runtime.sendMessage({ action: "get-open-tabs-catalog" }),
      "stage-focused-study-queue": (payload) =>
        browser.runtime.sendMessage({ action: "stage-focused-study-queue", payload }),
      "get-reading-list-catalog": () =>
        browser.runtime.sendMessage({ action: "get-reading-list-catalog" }),
      "shelve-and-clear-reading-item": (payload) =>
        browser.runtime.sendMessage({
          action: "shelve-and-clear-reading-item",
          url: (payload as { url: string })?.url,
        }),
    });
  },
});
