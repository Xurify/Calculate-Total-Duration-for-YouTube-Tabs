export interface VideoData {
  id: number;
  title: string;
  channelName: string;
  seconds: number;
  currentTime: number;
  excluded: boolean;
  index: number;
  url: string;
  suspended: boolean;
  active: boolean;
  isLive: boolean;
  windowId?: number;
}

export interface CachedMetadata {
  seconds: number;
  title: string;
  channelName: string;
  currentTime: number;
  isLive: boolean;
  timestamp: number;
}

export function normalizeYoutubeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes("youtube.com") && !urlObj.hostname.includes("youtu.be")) return url;

    // Handle youtu.be shortlinks
    if (urlObj.hostname.includes("youtu.be")) {
      const videoId = urlObj.pathname.slice(1);
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
    }

    // Handle standard watch URLs
    const videoId = urlObj.searchParams.get("v");
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;

    // Handle shorts (convert to watch URL for unified cache)
    if (urlObj.pathname.startsWith("/shorts/")) {
      const shortId = urlObj.pathname.split("/")[2];
      if (shortId) return `https://www.youtube.com/watch?v=${shortId}`;
    }

    return url;
  } catch {
    return url;
  }
}

export async function requestMetadataUpdate(
  url: string,
  metadata: Omit<CachedMetadata, "timestamp">
): Promise<void> {
  await browser.runtime.sendMessage({
    action: "update-cache",
    url,
    metadata,
  }).catch(() => {});
}

export async function saveStorage(
  videoData: VideoData[],
  sortByDuration: boolean,
  thumbnailQuality?: 'standard' | 'high',
  layoutMode?: 'list' | 'grid',
  groupingMode?: 'none' | 'channel',
  sortOption?: string
): Promise<void> {
  if (!browser.storage?.local) return;
  
  const current = await browser.storage.local.get(["excludedUrls"]);
  let excludedUrls = (current.excludedUrls as string[]) || [];
  
  if (videoData.length > 0) {
    excludedUrls = videoData.filter((video) => video.excluded).map((video) => video.url);
  }

  const data: any = {
    sortByDuration,
    excludedUrls,
  };
  if (thumbnailQuality) data.thumbnailQuality = thumbnailQuality;
  if (layoutMode) data.layoutMode = layoutMode;
  if (groupingMode) data.groupingMode = groupingMode;
  if (sortOption) data.sortOption = sortOption;
  
  await browser.storage.local.set(data);
}

export async function loadStorage(): Promise<{
  sortByDuration: boolean;
  excludedUrls: string[];
  thumbnailQuality: 'standard' | 'high';
  layoutMode: 'list' | 'grid';
  groupingMode: 'none' | 'channel';
  sortOption: string;
  metadataCache: Record<string, CachedMetadata>;
}> {
  if (!browser.storage?.local) {
    console.warn("Storage API not available.");
    return { 
      sortByDuration: false, 
      excludedUrls: [], 
      thumbnailQuality: 'high', 
      layoutMode: 'grid', 
      groupingMode: 'none', 
      sortOption: 'duration-desc', 
      metadataCache: {} 
    };
  }
  const data = await browser.storage.local.get([
    "sortByDuration", 
    "excludedUrls", 
    "thumbnailQuality", 
    "layoutMode", 
    "groupingMode", 
    "sortOption", 
    "metadataCache"
  ]);
  return {
    sortByDuration: Boolean(data.sortByDuration),
    excludedUrls: (data.excludedUrls as string[]) || [],
    thumbnailQuality: (data.thumbnailQuality as 'standard' | 'high') || 'high',
    layoutMode: (data.layoutMode as 'list' | 'grid') || 'grid',
    groupingMode: (data.groupingMode as 'none' | 'channel') || 'none',
    sortOption: (data.sortOption as string) || 'duration-desc',
    metadataCache: (data.metadataCache as Record<string, CachedMetadata>) || {},
  };
}



export async function updateMetadataCache(
  url: string,
  metadata: Omit<CachedMetadata, "timestamp">
) {
  const normalizedUrl = normalizeYoutubeUrl(url);
  const data = await browser.storage.local.get("metadataCache");
  const cache = (data.metadataCache as Record<string, CachedMetadata>) || {};

  cache[normalizedUrl] = {
    ...metadata,
    timestamp: Date.now(),
  };

  // Keep cache size reasonable (last 200 videos)
  const keys = Object.keys(cache);
  if (keys.length > 200) {
    const sortedKeys = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
    delete cache[sortedKeys[0]];
  }

  await browser.storage.local.set({ metadataCache: cache });
}

export async function clearCache(): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ metadataCache: {} });
}

export interface SavedSessionTab {
  url: string;
  title?: string;
  channelName?: string;
  seconds?: number;
}

export interface SavedSession {
  id: string;
  name: string;
  savedAt: number;
  tabs: SavedSessionTab[];
  pinned?: boolean;
}

const SAVED_SESSIONS_KEY = "savedSessions";

export async function getSavedSessions(): Promise<SavedSession[]> {
  if (!browser.storage?.local) return [];
  const data = await browser.storage.local.get(SAVED_SESSIONS_KEY);
  const raw = data[SAVED_SESSIONS_KEY] as SavedSession[] | undefined;
  if (!Array.isArray(raw)) return [];
  const normalized = raw.map((s) => ({
    id: s.id,
    name: s.name ?? "Untitled",
    savedAt: typeof s.savedAt === "number" ? s.savedAt : Date.now(),
    tabs: Array.isArray(s.tabs) ? s.tabs : [],
    pinned: Boolean(s.pinned),
  }));
  return normalized.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.savedAt - a.savedAt;
  });
}

export async function saveSession(name: string, tabs: SavedSessionTab[]): Promise<SavedSession> {
  if (!browser.storage?.local) throw new Error("Storage not available");
  const tabList = Array.isArray(tabs) ? tabs : [];
  const sessions = await getSavedSessions();
  const session: SavedSession = {
    id: crypto.randomUUID(),
    name,
    savedAt: Date.now(),
    tabs: tabList.map((t) => ({
      url: t?.url ?? "",
      title: t?.title,
      channelName: t?.channelName,
      seconds: t?.seconds,
    })),
    pinned: false,
  };
  sessions.unshift(session);
  await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: sessions });
  return session;
}

export async function setSessionPinned(id: string, pinned: boolean): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  session.pinned = pinned;
  await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: sessions });
}

export async function deleteSession(id: string): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = (await getSavedSessions()).filter((s) => s.id !== id);
  await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: sessions });
}

export async function updateSessionTabs(sessionId: string, tabs: SavedSessionTab[]): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.tabs = tabs;
  await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: sessions });
}
