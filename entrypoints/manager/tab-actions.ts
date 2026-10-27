import { VideoData, updateSessionTabs, type SavedSessionTab } from "../../utils/storage";
import { videoIdFromTabUrl } from "../../utils/sessions";
import { app } from "./state";
import { render } from "./render";
import { refreshSavedSessionsSidebar } from "./sessions-sidebar";
import { scheduleFetchTabsFromEvents } from "./tabs";
import { plural } from "./time/html";
import { showToast } from "./toast";
import { sleep } from "./util";

const TAB_CREATE_BATCH = 8;
const TAB_CREATE_DELAY_MS = 40;

export async function getOpenVideoIds(): Promise<Set<string>> {
  const tabs = await browser.tabs.query({});
  const ids = new Set<string>();
  for (const tab of tabs) {
    if (!tab.url) continue;
    const id = videoIdFromTabUrl(tab.url);
    if (id) ids.add(id);
  }
  return ids;
}

export async function createTabsBatched(urls: string[], windowId?: number): Promise<number> {
  let opened = 0;
  for (let i = 0; i < urls.length; i += TAB_CREATE_BATCH) {
    const batch = urls.slice(i, i + TAB_CREATE_BATCH);
    await Promise.all(
      batch.map((url) =>
        windowId != null ? browser.tabs.create({ windowId, url }) : browser.tabs.create({ url })
      )
    );
    opened += batch.length;
    if (i + TAB_CREATE_BATCH < urls.length) await sleep(TAB_CREATE_DELAY_MS);
  }
  return opened;
}

export function filterUrlsMissingOnly(urls: string[], openIds: Set<string>): string[] {
  return urls.filter((url) => {
    const id = videoIdFromTabUrl(url);
    return id ? !openIds.has(id) : true;
  });
}

function urlAtPosition(video: VideoData): string {
  const seconds = Math.floor(video.currentTime);
  if (video.isLive || seconds < 5) return video.url;
  try {
    const url = new URL(video.url);
    url.searchParams.set("t", `${seconds}s`);
    return url.toString();
  } catch {
    return video.url;
  }
}

interface ClosedVideo {
  video: VideoData;
  windowId?: number;
  tabIndex?: number;
}

async function reopenClosedVideos(closed: ClosedVideo[]): Promise<void> {
  // Lowest index first, so each reopened tab lands where it was before the next one goes in.
  for (const { video, windowId, tabIndex } of [...closed].sort((first, second) => (first.tabIndex ?? 0) - (second.tabIndex ?? 0))) {
    try {
      await browser.tabs.create({ url: urlAtPosition(video), windowId, index: tabIndex, active: false });
    } catch {
      await browser.tabs.create({ url: urlAtPosition(video), active: false });
    }
  }
  scheduleFetchTabsFromEvents();
}

export async function closeVideoTabs(videos: VideoData[]): Promise<void> {
  if (videos.length === 0) return;
  const closed: ClosedVideo[] = await Promise.all(
    videos.map(async (video) => {
      const tab = await browser.tabs.get(video.id).catch(() => null);
      return { video, windowId: tab?.windowId ?? video.windowId, tabIndex: tab?.index };
    })
  );
  await browser.tabs.remove(videos.map((video) => video.id));
  const message = videos.length === 1 ? `Closed "${videos[0].title || "1 tab"}"` : `Closed ${plural(videos.length, "tab")}`;
  showToast(message, { label: "Undo", run: () => reopenClosedVideos(closed) });
}

export async function restoreSessionTabs(sessionId: string, tabs: SavedSessionTab[]): Promise<void> {
  await updateSessionTabs(sessionId, tabs);
  if (app.selectedSession?.id === sessionId) app.selectedSession.tabs = tabs;
  refreshSavedSessionsSidebar();
  render();
}
