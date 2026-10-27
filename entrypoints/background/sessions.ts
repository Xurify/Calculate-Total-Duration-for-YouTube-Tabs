import { normalizeYoutubeUrl, getSavedSessions } from "../../utils/storage";
import { getVideoIdFromUrl } from "../../utils/format";
import { buildApprovalRequest, isExtensionPageSender, requestApproval } from "../../utils/approvals";

export async function getSavedSessionsCatalog() {
  const sessions = await getSavedSessions();
  return sessions.map((session) => {
    const languages = new Map<string, string>();
    for (const tab of session.tabs) {
      if (tab.language) languages.set(tab.language, tab.languageName ?? tab.language);
    }
    return {
      id: session.id,
      name: session.name,
      savedAt: session.savedAt,
      pinned: Boolean(session.pinned),
      videoCount: session.tabs.length,
      totalSeconds: session.tabs.reduce((total, tab) => total + (tab.seconds || 0), 0),
      languages: [...languages.entries()].map(([code, name]) => ({ code, name })),
      videos: session.tabs.map((tab) => ({
        url: tab.url,
        videoId: getVideoIdFromUrl(tab.url),
        title: tab.title ?? "",
        channelName: tab.channelName ?? "",
        durationSeconds: tab.seconds ?? 0,
        language: tab.language ?? null,
        languageName: tab.languageName ?? null,
      })),
    };
  });
}

export interface OpenSessionPayload {
  sessionId?: unknown;
  urls?: unknown;
}

const OPEN_TABS_BATCH = 8;

export async function openSavedSession(payload: OpenSessionPayload, sender: Browser.runtime.MessageSender) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!sessionId) throw new Error("sessionId is required. Call youtube_list_saved_sessions and pass an id from it.");
  if (payload.urls !== undefined && (!Array.isArray(payload.urls) || payload.urls.some((url) => typeof url !== "string"))) {
    throw new Error("urls must be an array of the session's video URLs.");
  }

  const session = (await getSavedSessions()).find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("No saved session has that id. Call youtube_list_saved_sessions for the current ids.");

  const requestedIds = Array.isArray(payload.urls)
    ? new Set((payload.urls as string[]).map((url) => getVideoIdFromUrl(url) ?? normalizeYoutubeUrl(url)))
    : null;
  const selectedTabs = session.tabs.filter((tab) => {
    if (!tab.url) return false;
    if (!requestedIds) return true;
    return requestedIds.has(getVideoIdFromUrl(tab.url) ?? tab.url);
  });
  if (selectedTabs.length === 0) {
    throw new Error(
      requestedIds ? "None of those urls belong to this session." : "This session has no videos to open."
    );
  }

  const openTabs = await browser.tabs.query({});
  const openVideoIds = new Set(
    openTabs.map((tab) => (tab.url ? getVideoIdFromUrl(tab.url) : null)).filter((id): id is string => Boolean(id))
  );
  const tabsToOpen = selectedTabs.filter((tab) => {
    const videoId = getVideoIdFromUrl(tab.url);
    return !videoId || !openVideoIds.has(videoId);
  });
  if (tabsToOpen.length === 0) {
    return { success: true, sessionId, name: session.name, openedCount: 0, alreadyOpenCount: selectedTabs.length };
  }

  if (!isExtensionPageSender(sender)) {
    const approved = await requestApproval(
      buildApprovalRequest(sender, {
        title: `Open ${tabsToOpen.length} ${tabsToOpen.length === 1 ? "tab" : "tabs"} from “${session.name}”?`,
        summary: "This page wants to reopen these saved videos as background tabs in this window.",
        items: tabsToOpen.map((tab) => tab.title || tab.url),
        confirmLabel: "Open tabs",
        destructive: false,
      })
    );
    if (!approved) throw new Error("The user declined to open the saved session.");
  }

  const windowId = sender.tab?.windowId;
  let openedCount = 0;
  for (let index = 0; index < tabsToOpen.length; index += OPEN_TABS_BATCH) {
    const batch = tabsToOpen.slice(index, index + OPEN_TABS_BATCH);
    const results = await Promise.allSettled(
      batch.map((tab) => browser.tabs.create({ url: tab.url, active: false, ...(windowId != null ? { windowId } : {}) }))
    );
    openedCount += results.filter((result) => result.status === "fulfilled").length;
  }

  return {
    success: true,
    sessionId,
    name: session.name,
    openedCount,
    alreadyOpenCount: selectedTabs.length - tabsToOpen.length,
  };
}
