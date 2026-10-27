import { normalizeYoutubeUrl, saveSession, type SavedSessionTab } from "../../utils/storage";
import { getVideoIdFromUrl, isYoutubeWatchOrShortsUrl } from "../../utils/format";
import { buildApprovalRequest, isExtensionPageSender, requestApproval } from "../../utils/approvals";
import { storeMetadataCache, storeReady } from "./store";

export interface StageQueuePayload {
  orderedTabIds: number[];
  stashDistractionTabs?: boolean;
  sessionName?: string;
  playbackSpeed?: number;
}

export async function getOpenTabsCatalog() {
  await storeReady;
  const tabs = await browser.tabs.query({});
  const videoTabs = tabs.filter(
    (tab) => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url))
  );

  return videoTabs.map((tab) => {
    const rawUrl = tab.url || "";
    const normalizedUrl = normalizeYoutubeUrl(rawUrl);
    const cached = storeMetadataCache[normalizedUrl];
    const durationSeconds = cached?.seconds || 0;
    const currentTimeSeconds = cached?.currentTime || 0;
    const remainingSeconds = Math.max(0, durationSeconds - currentTimeSeconds);

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      videoId: cached?.videoId ?? getVideoIdFromUrl(rawUrl),
      title: cached?.title || tab.title || "YouTube Video",
      channelName: cached?.channelName || "",
      durationSeconds,
      currentTimeSeconds,
      remainingSeconds,
      url: rawUrl,
      isLive: cached?.isLive || false,
      language: cached?.language ?? null,
      languageName: cached?.languageName ?? null,
      chapters: cached?.chapters ?? [],
      active: tab.active ?? false,
    };
  });
}

const MAX_SESSION_NAME_LENGTH = 80;

export async function stageFocusedStudyQueue(payload: StageQueuePayload, sender: Browser.runtime.MessageSender) {
  const senderTabId = sender.tab?.id;
  await storeReady;

  if (!payload || !Array.isArray(payload.orderedTabIds) || payload.orderedTabIds.length === 0) {
    throw new Error("orderedTabIds must be a non-empty array of valid YouTube tab IDs.");
  }

  const hasInvalidType = payload.orderedTabIds.some(
    (tabId) => typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0
  );
  if (hasInvalidType) {
    throw new Error("All entries in orderedTabIds must be positive numeric tab IDs.");
  }

  const allTabs = await browser.tabs.query({});
  const videoTabs = allTabs.filter(
    (tab) => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url))
  );

  const videoTabIdSet = new Set(
    videoTabs.map((tab) => tab.id).filter((tabId): tabId is number => typeof tabId === "number")
  );

  const missingIds = payload.orderedTabIds.filter((tabId) => !videoTabIdSet.has(tabId));
  if (missingIds.length > 0) {
    throw new Error(
      `Invalid tab ID(s): ${missingIds.join(", ")}. Every ID in orderedTabIds must correspond to an open YouTube watch or shorts tab.`
    );
  }

  const orderedTabIds = payload.orderedTabIds;
  const orderedSet = new Set(orderedTabIds);

  let stashedCount = 0;
  if (payload.stashDistractionTabs) {
    const unselectedTabs = videoTabs.filter(
      (tab) => tab.id !== undefined && !orderedSet.has(tab.id)
    );

    if (unselectedTabs.length > 0) {
      const tabsToStash: SavedSessionTab[] = unselectedTabs.map((tab) => {
        const rawUrl = tab.url || "";
        const normalizedUrl = normalizeYoutubeUrl(rawUrl);
        const cached = storeMetadataCache[normalizedUrl];
        return {
          url: normalizedUrl,
          title: cached?.title || tab.title || "YouTube Video",
          channelName: cached?.channelName || "",
          seconds: cached?.seconds || 0,
          language: cached?.language ?? undefined,
          languageName: cached?.languageName ?? undefined,
        };
      });

      if (!isExtensionPageSender(sender)) {
        const approved = await requestApproval(
          buildApprovalRequest(sender, {
            title: `Close ${tabsToStash.length} YouTube ${tabsToStash.length === 1 ? "tab" : "tabs"}?`,
            summary:
              "This page wants to save these tabs as a session in Study Harvester and then close them. You can reopen them from Saved Sessions.",
            items: tabsToStash.map((tab) => tab.title || tab.url),
            confirmLabel: "Stash and close",
            destructive: true,
          })
        );
        if (!approved) throw new Error("The user declined to stash and close the other tabs.");
      }

      const sessionName =
        (typeof payload.sessionName === "string" ? payload.sessionName.trim() : "").slice(
          0,
          MAX_SESSION_NAME_LENGTH
        ) || "Stashed Backlog";
      await saveSession(sessionName, tabsToStash);
      stashedCount = tabsToStash.length;

      const tabIdsToRemove = unselectedTabs
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => typeof tabId === "number");

      if (tabIdsToRemove.length > 0) {
        // One call with all IDs fails as a whole if the user closed any tab while the
        // approval window was open, so close them one by one.
        const removeTabs = () =>
          Promise.allSettled(tabIdsToRemove.map((tabId) => browser.tabs.remove(tabId)));
        const callerIsTargeted = senderTabId !== undefined && tabIdsToRemove.includes(senderTabId);
        if (callerIsTargeted) {
          setTimeout(() => void removeTabs(), 150);
        } else {
          await removeTabs();
        }
      }
    }
  }

  const firstTabId = orderedTabIds[0];
  if (firstTabId !== undefined) {
    await browser.tabs.update(firstTabId, { active: true });

    if (typeof payload.playbackSpeed === "number" && payload.playbackSpeed > 0) {
      try {
        await browser.scripting.executeScript({
          target: { tabId: firstTabId },
          // movie_player.setPlaybackRate is a page-side method, invisible from the isolated world.
          world: "MAIN",
          func: (speed: number) => {
            const video = document.querySelector("video");
            if (video) video.playbackRate = speed;
            const moviePlayer = document.getElementById("movie_player") as unknown as {
              setPlaybackRate?: (rate: number) => void;
            };
            if (typeof moviePlayer?.setPlaybackRate === "function") {
              moviePlayer.setPlaybackRate(speed);
            }
          },
          args: [payload.playbackSpeed],
        });
      } catch {
        // Tab scripting may not be permitted if tab is discarded or restricted
      }
    }
  }

  return {
    success: true,
    stashedCount,
    focusedTabId: firstTabId ?? null,
  };
}
