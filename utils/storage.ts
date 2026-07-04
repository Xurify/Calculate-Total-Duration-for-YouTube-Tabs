import { getVideoIdFromUrl } from "./format";

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
  language?: string | null;
  languageName?: string | null;
  videoId?: string | null;
  audible?: boolean;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
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
  videoId?: string | null;
  language?: string | null;
  languageName?: string | null;
  audible?: boolean;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
}

export function isCacheEntryUsable(cached: CachedMetadata | undefined): cached is CachedMetadata {
  if (!cached) return false;
  return cached.timestamp != null && Date.now() - cached.timestamp < MAX_CACHE_AGE_MS;
}

export interface UserPrefs {
  sortByDuration: boolean;
  excludedUrls: string[];
  thumbnailQuality: "standard" | "high";
  layoutMode: "list" | "grid";
  groupingMode: "none" | "channel" | "language";
  sortOption: string;
}

const DEFAULT_PREFS: UserPrefs = {
  sortByDuration: false,
  excludedUrls: [],
  thumbnailQuality: "high",
  layoutMode: "grid",
  groupingMode: "none",
  sortOption: "duration-desc",
};

const PREFS_STORAGE_KEYS = [
  "sortByDuration",
  "excludedUrls",
  "thumbnailQuality",
  "layoutMode",
  "groupingMode",
  "sortOption",
] as const;

function parsePrefs(data: Record<string, unknown>): UserPrefs {
  return {
    sortByDuration: Boolean(data.sortByDuration),
    excludedUrls: (data.excludedUrls as string[]) || [],
    thumbnailQuality: (data.thumbnailQuality as UserPrefs["thumbnailQuality"]) || DEFAULT_PREFS.thumbnailQuality,
    layoutMode: (data.layoutMode as UserPrefs["layoutMode"]) || DEFAULT_PREFS.layoutMode,
    groupingMode: (data.groupingMode as UserPrefs["groupingMode"]) || DEFAULT_PREFS.groupingMode,
    sortOption: (data.sortOption as string) || DEFAULT_PREFS.sortOption,
  };
}

/** Fast read — small prefs blob only, no metadata cache. */
export async function loadPrefs(): Promise<UserPrefs> {
  if (!browser.storage?.local) {
    console.warn("Storage API not available.");
    return { ...DEFAULT_PREFS };
  }
  const data = await browser.storage.local.get([...PREFS_STORAGE_KEYS]);
  return parsePrefs(data);
}

/** Single storage round-trip for tab bootstrap (prefs + metadata cache). */
export async function loadPrefsAndMetadataCache(): Promise<{
  prefs: UserPrefs;
  metadataCache: Record<string, CachedMetadata>;
}> {
  if (!browser.storage?.local) {
    return { prefs: { ...DEFAULT_PREFS }, metadataCache: {} };
  }
  const data = await browser.storage.local.get([...PREFS_STORAGE_KEYS, "metadataCache"]);
  return {
    prefs: parsePrefs(data),
    metadataCache: (data.metadataCache as Record<string, CachedMetadata>) || {},
  };
}

/** Merge partial prefs via background-owned store. */
export async function savePrefs(updates: Partial<UserPrefs>): Promise<void> {
  await browser.runtime.sendMessage({ action: "update-prefs", updates });
}

/** Read metadata cache only. */
export async function loadMetadataCache(): Promise<Record<string, CachedMetadata>> {
  if (!browser.storage?.local) return {};
  const data = await browser.storage.local.get("metadataCache");
  return (data.metadataCache as Record<string, CachedMetadata>) || {};
}

/** Resolve cache entry by normalized URL or matching videoId. */
export function lookupCachedMetadata(
  cache: Record<string, CachedMetadata>,
  url: string
): CachedMetadata | undefined {
  const normalizedUrl = normalizeYoutubeUrl(url);
  const expectedVideoId = getVideoIdFromUrl(url);
  const byUrl = cache[normalizedUrl];
  if (
    byUrl &&
    byUrl.videoId !== undefined &&
    byUrl.videoId === expectedVideoId &&
    isCacheEntryUsable(byUrl)
  ) {
    return byUrl;
  }
  if (expectedVideoId) {
    for (const entry of Object.values(cache)) {
      if (entry.videoId === expectedVideoId && isCacheEntryUsable(entry)) {
        return entry;
      }
    }
  }
  return undefined;
}

/** Strip playback state before persisting durable metadata. */
export function toDurableMetadata(metadata: Omit<CachedMetadata, "timestamp">): Omit<CachedMetadata, "timestamp"> {
  return {
    seconds: metadata.seconds,
    title: metadata.title,
    channelName: metadata.channelName,
    currentTime: metadata.currentTime,
    isLive: metadata.isLive,
    videoId: metadata.videoId,
    language: metadata.language,
    languageName: metadata.languageName,
    volume: metadata.volume,
    muted: metadata.muted,
    paused: metadata.paused,
  };
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
    metadata: toDurableMetadata(metadata),
  }).catch(() => {});
}

export async function saveStorage(
  videoData: VideoData[],
  sortByDuration: boolean,
  thumbnailQuality?: UserPrefs["thumbnailQuality"],
  layoutMode?: UserPrefs["layoutMode"],
  groupingMode?: UserPrefs["groupingMode"],
  sortOption?: string
): Promise<void> {
  const updates: Partial<UserPrefs> = { sortByDuration };
  if (videoData.length > 0) {
    updates.excludedUrls = videoData
      .filter((video) => video.excluded)
      .map((video) => normalizeYoutubeUrl(video.url));
  }
  if (thumbnailQuality) updates.thumbnailQuality = thumbnailQuality;
  if (layoutMode) updates.layoutMode = layoutMode;
  if (groupingMode) updates.groupingMode = groupingMode;
  if (sortOption) updates.sortOption = sortOption;
  await savePrefs(updates);
}

/** Full load from background-owned store. */
export async function loadStorage(): Promise<UserPrefs & { metadataCache: Record<string, CachedMetadata> }> {
  const response = await browser.runtime.sendMessage({ action: "get-store-state" });
  if (!response?.prefs || !response.metadataCache) {
    throw new Error("Failed to load store state from background");
  }
  return {
    ...(response.prefs as UserPrefs),
    metadataCache: response.metadataCache as Record<string, CachedMetadata>,
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
  await browser.runtime.sendMessage({ action: "clear-metadata-cache" });
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
  language?: string;
  languageName?: string;
}

/** Max saved sessions before oldest unpinned entries are trimmed. */
export const MAX_SAVED_SESSIONS = 50;

export const SESSIONS_EXPORT_VERSION = 1;

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

function sessionTabVideoId(tab: SavedSessionTab): string {
  const id = getVideoIdFromUrl(normalizeYoutubeUrl(tab.url ?? ""));
  return id ?? tab.url ?? "";
}

function mergeSessionTabsInline(existing: SavedSessionTab[], incoming: SavedSessionTab[]): SavedSessionTab[] {
  const merged = existing.map(mapSavedTab);
  const seen = new Set(merged.map(sessionTabVideoId));
  for (const tab of incoming.map(mapSavedTab)) {
    const id = sessionTabVideoId(tab);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(tab);
  }
  return merged;
}

function mergeSessionSectionsInline(existing: SessionSection[], incoming: SessionSection[]): SessionSection[] {
  const byId = new Map(existing.map((s) => [s.id, s]));
  const merged = [...existing];
  for (const sec of incoming) {
    if (!byId.has(sec.id)) {
      merged.push(sec);
      byId.set(sec.id, sec);
    }
  }
  return merged.sort((a, b) => a.order - b.order);
}

function mapSavedTab(t: SavedSessionTab): SavedSessionTab {
  const url = normalizeYoutubeUrl(t?.url ?? "");
  return {
    url,
    title: t?.title,
    channelName: t?.channelName,
    seconds: t?.seconds,
    sectionId: typeof t?.sectionId === "string" && t.sectionId.length > 0 ? t.sectionId : undefined,
    language: t?.language,
    languageName: t?.languageName,
  };
}

function trimSessionsForRetention(sessions: SavedSession[]): SavedSession[] {
  if (sessions.length <= MAX_SAVED_SESSIONS) return sessions;
  const pinned = sessions.filter((s) => s.pinned);
  const unpinned = sessions
    .filter((s) => !s.pinned)
    .sort((a, b) => b.savedAt - a.savedAt);
  const slots = Math.max(0, MAX_SAVED_SESSIONS - pinned.length);
  const keptUnpinned = unpinned.slice(0, slots);
  return [...pinned, ...keptUnpinned].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.savedAt - a.savedAt;
  });
}

async function persistSavedSessions(sessions: SavedSession[]): Promise<void> {
  if (!browser.storage?.local) throw new Error("Storage not available");
  let trimmed = trimSessionsForRetention(sessions);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: trimmed });
      return;
    } catch (err) {
      const unpinned = trimmed.filter((s) => !s.pinned);
      if (unpinned.length === 0) {
        throw new Error(
          err instanceof Error ? err.message : "Storage quota exceeded. Unpin or delete sessions to free space."
        );
      }
      const removeCount = Math.max(1, Math.ceil(unpinned.length * 0.2));
      const removeIds = new Set(unpinned.slice(-removeCount).map((s) => s.id));
      trimmed = trimmed.filter((s) => !removeIds.has(s.id));
    }
  }
  throw new Error("Could not save sessions: storage quota exceeded.");
}

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
      ? s.tabs.map((t) => mapSavedTab(t))
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
  const tabList = Array.isArray(tabs) ? tabs : [];
  const sectionList = Array.isArray(sections) ? sections : [];
  const sessions = await getSavedSessions();
  const normalizedSections = sectionList.map((sec, i) => normalizeSessionSection(sec, i)).sort((a, b) => a.order - b.order);
  const session: SavedSession = {
    id: crypto.randomUUID(),
    name,
    savedAt: Date.now(),
    tabs: tabList.map(mapSavedTab),
    pinned: false,
    sections: normalizedSections.length > 0 ? normalizedSections : [],
  };
  sessions.unshift(session);
  await persistSavedSessions(sessions);
  return session;
}

export async function replaceSession(
  id: string,
  name: string,
  tabs: SavedSessionTab[],
  sections?: SessionSection[]
): Promise<SavedSession | null> {
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return null;
  const sectionList = Array.isArray(sections) ? sections : [];
  session.name = name.trim() || session.name;
  session.savedAt = Date.now();
  session.tabs = tabs.map(mapSavedTab);
  session.sections = sectionList.map((sec, i) => normalizeSessionSection(sec, i)).sort((a, b) => a.order - b.order);
  await persistSavedSessions(sessions);
  return session;
}

export async function mergeIntoSession(
  id: string,
  tabs: SavedSessionTab[],
  sections?: SessionSection[]
): Promise<SavedSession | null> {
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return null;
  session.tabs = mergeSessionTabsInline(session.tabs ?? [], tabs);
  if (sections && sections.length > 0) {
    session.sections = mergeSessionSectionsInline(session.sections ?? [], sections);
  }
  session.savedAt = Date.now();
  await persistSavedSessions(sessions);
  return session;
}

export async function duplicateSession(id: string, newName?: string): Promise<SavedSession | null> {
  const sessions = await getSavedSessions();
  const source = sessions.find((s) => s.id === id);
  if (!source) return null;
  const copy: SavedSession = {
    id: crypto.randomUUID(),
    name: newName?.trim() || `Copy of ${source.name}`,
    savedAt: Date.now(),
    tabs: (source.tabs ?? []).map(mapSavedTab),
    pinned: false,
    sections: (source.sections ?? []).map((sec, i) => normalizeSessionSection(sec, i)),
  };
  sessions.unshift(copy);
  await persistSavedSessions(sessions);
  return copy;
}

export async function exportSessionsJson(): Promise<string> {
  const sessions = await getSavedSessions();
  return JSON.stringify(
    { version: SESSIONS_EXPORT_VERSION, exportedAt: Date.now(), sessions },
    null,
    2
  );
}

export async function importSessionsJson(
  json: string,
  mode: "merge" | "replace" = "merge"
): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON file.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid export format.");
  const root = parsed as { sessions?: unknown; version?: number };
  if (!Array.isArray(root.sessions)) throw new Error("Export must contain a sessions array.");

  const imported: SavedSession[] = root.sessions.map((raw) => {
    const s = raw as SavedSession;
    const sectionsRaw = Array.isArray(s.sections) ? s.sections : [];
    const sections = sectionsRaw.map((sec, i) => normalizeSessionSection(sec, i));
    const tabs = Array.isArray(s.tabs) ? s.tabs.map(mapSavedTab) : [];
    return {
      id: crypto.randomUUID(),
      name: typeof s.name === "string" && s.name.trim() ? s.name.trim() : "Imported session",
      savedAt: typeof s.savedAt === "number" ? s.savedAt : Date.now(),
      tabs,
      pinned: Boolean(s.pinned),
      sections,
    };
  });

  if (mode === "replace") {
    await persistSavedSessions(imported);
    return imported.length;
  }

  const existing = await getSavedSessions();
  await persistSavedSessions([...imported, ...existing]);
  return imported.length;
}

export async function setSessionPinned(id: string, pinned: boolean): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  session.pinned = pinned;
  await persistSavedSessions(sessions);
}

export async function renameSession(id: string, name: string): Promise<void> {
  if (!browser.storage?.local) return;
  const trimmed = name.trim();
  const nextName = trimmed.length > 0 ? trimmed : "Untitled";
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === id);
  if (!session) return;
  session.name = nextName;
  session.savedAt = Date.now();
  await persistSavedSessions(sessions);
}

export async function deleteSession(id: string): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = (await getSavedSessions()).filter((s) => s.id !== id);
  await persistSavedSessions(sessions);
}

export async function updateSessionTabs(sessionId: string, tabs: SavedSessionTab[]): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = await getSavedSessions();
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return;
  session.tabs = tabs.map(mapSavedTab);
  session.savedAt = Date.now();
  await persistSavedSessions(sessions);
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
    return mapSavedTab({
      url: tab.url,
      title: tab.title,
      channelName: tab.channelName,
      seconds: tab.seconds,
      language: tab.language,
      languageName: tab.languageName,
    });
  });
  session.savedAt = Date.now();
  await persistSavedSessions(sessions);
}
