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

export const MAX_CACHE_AGE_MS = 48 * 60 * 60 * 1000;

export interface CachedMetadata {
  seconds: number;
  title: string;
  channelName: string;
  currentTime: number;
  isLive: boolean;
  timestamp: number;
  /** When set, cache is only used when this matches the tab's video ID (avoids stale SPA metadata). */
  videoId?: string;
}

export function isCacheEntryUsable(cached: CachedMetadata | undefined): cached is CachedMetadata {
  if (!cached) return false;
  return cached.timestamp != null && Date.now() - cached.timestamp < MAX_CACHE_AGE_MS;
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

export interface SessionSection {
  id: string;
  name: string;
  emoji?: string;
  /** 0–7, maps to theme accent rails in the manager UI */
  colorIndex?: number;
  order: number;
}

export interface SavedSessionTab {
  url: string;
  title?: string;
  channelName?: string;
  seconds?: number;
  /** When set, tab belongs to this section within the saved session */
  sectionId?: string | null;
}

export interface SavedSession {
  id: string;
  name: string;
  savedAt: number;
  tabs: SavedSessionTab[];
  pinned?: boolean;
  /** User-defined groups inside this session (live view uses separate storage) */
  sections?: SessionSection[];
}

const SAVED_SESSIONS_KEY = "savedSessions";
const LIVE_TAB_SECTIONS_KEY = "liveTabSections";

export interface LiveTabSectionsState {
  sections: SessionSection[];
  /** normalized YouTube URL → section id */
  assignments: Record<string, string>;
}

const defaultLiveTabSections = (): LiveTabSectionsState => ({
  sections: [],
  assignments: {},
});

function normalizeSessionSection(raw: unknown, index: number): SessionSection {
  if (!raw || typeof raw !== "object") {
    return { id: crypto.randomUUID(), name: "Section", order: index, colorIndex: index % 8 };
  }
  const o = raw as SessionSection;
  const id = typeof o.id === "string" && o.id.length > 0 ? o.id : crypto.randomUUID();
  const name = typeof o.name === "string" && o.name.trim().length > 0 ? o.name.trim() : "Section";
  const order = typeof o.order === "number" ? o.order : index;
  const emoji = typeof o.emoji === "string" ? o.emoji : undefined;
  const colorIndex = typeof o.colorIndex === "number" && o.colorIndex >= 0 ? Math.floor(o.colorIndex) % 8 : index % 8;
  return { id, name, emoji, colorIndex, order };
}

export async function getLiveTabSections(): Promise<LiveTabSectionsState> {
  if (!browser.storage?.local) return defaultLiveTabSections();
  const data = await browser.storage.local.get(LIVE_TAB_SECTIONS_KEY);
  const raw = data[LIVE_TAB_SECTIONS_KEY] as LiveTabSectionsState | undefined;
  if (!raw || typeof raw !== "object") return defaultLiveTabSections();
  const sections = Array.isArray(raw.sections)
    ? raw.sections.map((s, i) => normalizeSessionSection(s, i)).sort((a, b) => a.order - b.order)
    : [];
  const assignments =
    raw.assignments && typeof raw.assignments === "object" && !Array.isArray(raw.assignments)
      ? { ...raw.assignments }
      : {};
  return { sections, assignments };
}

export async function setLiveTabSections(state: LiveTabSectionsState): Promise<void> {
  if (!browser.storage?.local) return;
  const sections = [...state.sections].sort((a, b) => a.order - b.order);
  await browser.storage.local.set({
    [LIVE_TAB_SECTIONS_KEY]: { sections, assignments: { ...state.assignments } },
  });
}

export async function getSavedSessions(): Promise<SavedSession[]> {
  if (!browser.storage?.local) return [];
  const data = await browser.storage.local.get(SAVED_SESSIONS_KEY);
  const raw = data[SAVED_SESSIONS_KEY] as SavedSession[] | undefined;
  if (!Array.isArray(raw)) return [];
  const normalized = raw.map((s) => {
    const sectionsRaw = Array.isArray(s.sections) ? s.sections : [];
    const sections = sectionsRaw.map((sec, i) => normalizeSessionSection(sec, i)).sort((a, b) => a.order - b.order);
    const tabs = Array.isArray(s.tabs)
      ? s.tabs.map((t) => ({
          url: t?.url ?? "",
          title: t?.title,
          channelName: t?.channelName,
          seconds: t?.seconds,
          sectionId: typeof t?.sectionId === "string" && t.sectionId.length > 0 ? t.sectionId : undefined,
        }))
      : [];
    return {
      id: s.id,
      name: s.name ?? "Untitled",
      savedAt: typeof s.savedAt === "number" ? s.savedAt : Date.now(),
      tabs,
      pinned: Boolean(s.pinned),
      sections,
    };
  });
  return normalized.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.savedAt - a.savedAt;
  });
}

export async function saveSession(
  name: string,
  tabs: SavedSessionTab[],
  sections?: SessionSection[]
): Promise<SavedSession> {
  if (!browser.storage?.local) throw new Error("Storage not available");
  const tabList = Array.isArray(tabs) ? tabs : [];
  const sectionList = Array.isArray(sections) ? sections : [];
  const sessions = await getSavedSessions();
  const normalizedSections = sectionList.map((sec, i) => normalizeSessionSection(sec, i)).sort((a, b) => a.order - b.order);
  const session: SavedSession = {
    id: crypto.randomUUID(),
    name,
    savedAt: Date.now(),
    tabs: tabList.map((t) => ({
      url: t?.url ?? "",
      title: t?.title,
      channelName: t?.channelName,
      seconds: t?.seconds,
      sectionId: typeof t?.sectionId === "string" && t.sectionId.length > 0 ? t.sectionId : undefined,
    })),
    pinned: false,
    sections: normalizedSections.length > 0 ? normalizedSections : [],
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

export async function renameSession(id: string, name: string): Promise<void> {
  if (!browser.storage?.local) return;
  const trimmed = name.trim();
  const nextName = trimmed.length > 0 ? trimmed : "Untitled";
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  session.name = nextName;
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
  session.tabs = tabs.map((t) => ({
    url: t?.url ?? "",
    title: t?.title,
    channelName: t?.channelName,
    seconds: t?.seconds,
    sectionId: typeof t?.sectionId === "string" && t.sectionId.length > 0 ? t.sectionId : undefined,
  }));
  await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: sessions });
}

export async function updateSessionSections(sessionId: string, sections: SessionSection[]): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.sections = sections.map((sec, i) => normalizeSessionSection(sec, i)).sort((a, b) => a.order - b.order);
  const validIds = new Set(session.sections.map((sec) => sec.id));
  session.tabs = session.tabs.map((tab) => {
    const sid = tab.sectionId;
    if (typeof sid === "string" && validIds.has(sid)) return tab;
    return { url: tab.url, title: tab.title, channelName: tab.channelName, seconds: tab.seconds };
  });
  await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: sessions });
}
