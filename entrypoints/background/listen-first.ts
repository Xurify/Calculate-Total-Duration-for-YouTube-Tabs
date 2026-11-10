import { LISTEN_FIRST_KEY } from "../../utils/listening";

/**
 * YouTube tabs learn about the Listen First switch from a message, not from storage.onChanged.
 * Chrome sends every storage.local change, old and new value both, to each tab that listens,
 * so with many tabs open one watch log save froze the whole browser window.
 */
export function relayListenFirstToTabs(): void {
  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes[LISTEN_FIRST_KEY];
    if (area !== "local" || !change) return;
    const enabled = change.newValue === true;
    void browser.tabs.query({ url: "*://*.youtube.com/*" }).then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        void browser.tabs.sendMessage(tab.id, { action: "listen-first-changed", enabled }).catch(() => {});
      }
    });
  });
}
