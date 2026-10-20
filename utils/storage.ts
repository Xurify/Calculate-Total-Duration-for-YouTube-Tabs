import { LANGUAGE_DETECTION_VERSION } from "./captionLanguage";
import { getVideoIdFromUrl } from "./format";

export interface VideoChapter {
  title: string;
  startSeconds: number;
  durationSeconds?: number;
}

export interface StagedClozeCard {
  id: string;
  sentence: string;
  targetWord: string;
  /** Empty when the user left it for an agent to fill in. */
  translation: string;
  hint?: string;
  notes?: string;
  language?: string | null;
  videoId: string | null;
  videoTitle: string;
  timestampSeconds: number;
  createdAt: number;
}

export interface CachedMandalaAction {
  id: string;
  text: string;
  kind?: string;
}

export interface CachedMandalaPillar {
  index: number;
  title: string;
  /** False when the pillar is still blank in Mandala and `title` is a placeholder. */
  named?: boolean;
  actionCount: number;
  /** The pillar's written lines, so a site rule can name one. */
  actions?: CachedMandalaAction[];
}

export interface CachedMandalaShelfLink {
  id: string;
  pillarIndex: number;
  title: string;
  url: string;
  kind?: string;
  action?: string;
}

export interface CachedMandalaSummary {
  activeChartId: string;
  activeChartTitle: string;
  pillars: CachedMandalaPillar[];
  shelfLinks: CachedMandalaShelfLink[];
  lastUpdatedAt: number;
}

/** Logged against the shelf link for `url` once a Mandala tab is open to resolve its action. */
export interface PendingMandalaTimeLog {
  id: string;
  url?: string;
  minutes: number;
  videoTitle: string;
  timestamp: number;
}

export interface MandalaStatus {
  connected: boolean;
  cached: boolean;
  /** True when a rule or a shelf link already sends this page's time to Mandala on its own. */
  autoLogged?: boolean;
  /** What the time tracker has counted on this page today, in either mode: the time Mandala will get. */
  trackedSeconds?: number;
  activeChartTitle?: string;
  /** Pillars the person has named, or all eight when none are named yet. */
  pillars: CachedMandalaPillar[];
  /** Every pillar whose shelf already holds this video. */
  savedPillarIndexes: number[];
}

export function shelfLinksForVideo(
  shelfLinks: CachedMandalaShelfLink[],
  rawUrl: string
): CachedMandalaShelfLink[] {
  const normalizedTargetUrl = normalizeYoutubeUrl(rawUrl);
  const targetVideoId = getVideoIdFromUrl(normalizedTargetUrl);
  return shelfLinks.filter((link) => {
    const normalizedLinkUrl = normalizeYoutubeUrl(link.url);
    if (normalizedLinkUrl === normalizedTargetUrl) return true;
    const linkVideoId = getVideoIdFromUrl(normalizedLinkUrl);
    return Boolean(targetVideoId && linkVideoId && targetVideoId === linkVideoId);
  });
}

export function mandalaStatusFor(
  summary: CachedMandalaSummary,
  rawUrl: string,
  source: { connected: boolean; cached: boolean }
): MandalaStatus {
  const namedPillars = summary.pillars.filter((pillar) => pillar.named);
  return {
    ...source,
    activeChartTitle: summary.activeChartTitle,
    pillars: namedPillars.length > 0 ? namedPillars : summary.pillars,
    savedPillarIndexes: [...new Set(shelfLinksForVideo(summary.shelfLinks, rawUrl).map((link) => link.pillarIndex))].sort(
      (first, second) => first - second
    ),
  };
}

export interface PendingMandalaShelfLink {
  id: string;
  pillarIndex: number;
  url: string;
  title: string;
  kind?: string;
  timestamp: number;
}

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
  chapters?: VideoChapter[];
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
  languageVersion?: number;
  audible?: boolean;
  paused?: boolean;
  volume?: number;
  muted?: boolean;
  chapters?: VideoChapter[];
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
  layoutMode: "list",
  groupingMode: "none",
  sortOption: "started-first",
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
    metadataCache: forgetOutdatedLanguages((data.metadataCache as Record<string, CachedMetadata>) || {}),
  };
}

/** An undefined language makes the Desk and background sync detect it again. */
function forgetOutdatedLanguages(cache: Record<string, CachedMetadata>): Record<string, CachedMetadata> {
  for (const entry of Object.values(cache)) {
    if (entry.language !== undefined && entry.languageVersion !== LANGUAGE_DETECTION_VERSION) {
      delete entry.language;
      delete entry.languageName;
      delete entry.languageVersion;
    }
  }
  return cache;
}

/** Merge partial prefs via background-owned store. */
export async function savePrefs(updates: Partial<UserPrefs>): Promise<void> {
  await browser.runtime.sendMessage({ action: "update-prefs", updates });
}

/** Read metadata cache only. */
export async function loadMetadataCache(): Promise<Record<string, CachedMetadata>> {
  if (!browser.storage?.local) return {};
  const data = await browser.storage.local.get("metadataCache");
  return forgetOutdatedLanguages((data.metadataCache as Record<string, CachedMetadata>) || {});
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
    languageVersion: metadata.language === undefined ? undefined : LANGUAGE_DETECTION_VERSION,
    volume: metadata.volume,
    muted: metadata.muted,
    paused: metadata.paused,
    chapters: metadata.chapters,
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
  chapters?: VideoChapter[];
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
  const byId = new Map(existing.map((section) => [section.id, section]));
  const merged = [...existing];
  for (const section of incoming) {
    if (!byId.has(section.id)) {
      merged.push(section);
      byId.set(section.id, section);
    }
  }
  return merged.sort((firstSection, secondSection) => firstSection.order - secondSection.order);
}

function mapSavedTab(savedTab: SavedSessionTab): SavedSessionTab {
  const url = normalizeYoutubeUrl(savedTab?.url ?? "");
  return {
    url,
    title: savedTab?.title,
    channelName: savedTab?.channelName,
    seconds: savedTab?.seconds,
    sectionId: typeof savedTab?.sectionId === "string" && savedTab.sectionId.length > 0 ? savedTab.sectionId : undefined,
    language: savedTab?.language,
    languageName: savedTab?.languageName,
    chapters: savedTab?.chapters,
  };
}

function trimSessionsForRetention(sessions: SavedSession[]): SavedSession[] {
  if (sessions.length <= MAX_SAVED_SESSIONS) return sessions;
  const pinned = sessions.filter((session) => session.pinned);
  const unpinned = sessions
    .filter((session) => !session.pinned)
    .sort((firstSession, secondSession) => secondSession.savedAt - firstSession.savedAt);
  const slots = Math.max(0, MAX_SAVED_SESSIONS - pinned.length);
  const keptUnpinned = unpinned.slice(0, slots);
  return [...pinned, ...keptUnpinned].sort((firstSession, secondSession) => {
    if (firstSession.pinned && !secondSession.pinned) return -1;
    if (!firstSession.pinned && secondSession.pinned) return 1;
    return secondSession.savedAt - firstSession.savedAt;
  });
}

async function persistSavedSessions(sessions: SavedSession[]): Promise<void> {
  if (!browser.storage?.local) throw new Error("Storage not available");
  let trimmed = trimSessionsForRetention(sessions);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await browser.storage.local.set({ [SAVED_SESSIONS_KEY]: trimmed });
      return;
    } catch (error) {
      const unpinned = trimmed.filter((session) => !session.pinned);
      if (unpinned.length === 0) {
        throw new Error(
          error instanceof Error ? error.message : "Storage quota exceeded. Unpin or delete sessions to free space."
        );
      }
      const removeCount = Math.max(1, Math.ceil(unpinned.length * 0.2));
      const removeIds = new Set(unpinned.slice(-removeCount).map((session) => session.id));
      trimmed = trimmed.filter((session) => !removeIds.has(session.id));
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
  const normalized = raw.map((rawSession) => {
    const sectionsRaw = Array.isArray(rawSession.sections) ? rawSession.sections : [];
    const sections = sectionsRaw
      .map((section, sectionIndex) => normalizeSessionSection(section, sectionIndex))
      .sort((firstSection, secondSection) => firstSection.order - secondSection.order);
    const tabs = Array.isArray(rawSession.tabs)
      ? rawSession.tabs.map((savedTab) => mapSavedTab(savedTab))
      : [];
    return {
      id: rawSession.id,
      name: rawSession.name ?? "Untitled",
      savedAt: typeof rawSession.savedAt === "number" ? rawSession.savedAt : Date.now(),
      tabs,
      pinned: Boolean(rawSession.pinned),
      sections,
    };
  });
  return normalized.sort((firstSession, secondSession) => {
    if (firstSession.pinned && !secondSession.pinned) return -1;
    if (!firstSession.pinned && secondSession.pinned) return 1;
    return secondSession.savedAt - firstSession.savedAt;
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
  const normalizedSections = sectionList
    .map((section, sectionIndex) => normalizeSessionSection(section, sectionIndex))
    .sort((firstSection, secondSection) => firstSection.order - secondSection.order);
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
  const session = sessions.find((candidateSession) => candidateSession.id === id);
  if (!session) return null;
  const sectionList = Array.isArray(sections) ? sections : [];
  session.name = name.trim() || session.name;
  session.savedAt = Date.now();
  session.tabs = tabs.map(mapSavedTab);
  session.sections = sectionList
    .map((section, sectionIndex) => normalizeSessionSection(section, sectionIndex))
    .sort((firstSection, secondSection) => firstSection.order - secondSection.order);
  await persistSavedSessions(sessions);
  return session;
}

export async function mergeIntoSession(
  id: string,
  tabs: SavedSessionTab[],
  sections?: SessionSection[]
): Promise<SavedSession | null> {
  const sessions = await getSavedSessions();
  const session = sessions.find((candidateSession) => candidateSession.id === id);
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
  const source = sessions.find((candidateSession) => candidateSession.id === id);
  if (!source) return null;
  const copy: SavedSession = {
    id: crypto.randomUUID(),
    name: newName?.trim() || `Copy of ${source.name}`,
    savedAt: Date.now(),
    tabs: (source.tabs ?? []).map(mapSavedTab),
    pinned: false,
    sections: (source.sections ?? []).map((section, sectionIndex) => normalizeSessionSection(section, sectionIndex)),
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
    const importedSession = raw as SavedSession;
    const sectionsRaw = Array.isArray(importedSession.sections) ? importedSession.sections : [];
    const sections = sectionsRaw.map((section, sectionIndex) => normalizeSessionSection(section, sectionIndex));
    const tabs = Array.isArray(importedSession.tabs) ? importedSession.tabs.map(mapSavedTab) : [];
    return {
      id: crypto.randomUUID(),
      name: typeof importedSession.name === "string" && importedSession.name.trim() ? importedSession.name.trim() : "Imported session",
      savedAt: typeof importedSession.savedAt === "number" ? importedSession.savedAt : Date.now(),
      tabs,
      pinned: Boolean(importedSession.pinned),
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
  const session = sessions.find((candidateSession) => candidateSession.id === id);
  if (!session) return;
  session.pinned = pinned;
  await persistSavedSessions(sessions);
}

export async function renameSession(id: string, name: string): Promise<void> {
  if (!browser.storage?.local) return;
  const trimmed = name.trim();
  const nextName = trimmed.length > 0 ? trimmed : "Untitled";
  const sessions = await getSavedSessions();
  const session = sessions.find((candidateSession) => candidateSession.id === id);
  if (!session) return;
  session.name = nextName;
  session.savedAt = Date.now();
  await persistSavedSessions(sessions);
}

export async function deleteSession(id: string): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = (await getSavedSessions()).filter((candidateSession) => candidateSession.id !== id);
  await persistSavedSessions(sessions);
}

export async function updateSessionTabs(sessionId: string, tabs: SavedSessionTab[]): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = await getSavedSessions();
  const session = sessions.find((candidateSession) => candidateSession.id === sessionId);
  if (!session) return;
  session.tabs = tabs.map(mapSavedTab);
  session.savedAt = Date.now();
  await persistSavedSessions(sessions);
}

export async function updateSessionSections(sessionId: string, sections: SessionSection[]): Promise<void> {
  if (!browser.storage?.local) return;
  const sessions = await getSavedSessions();
  const session = sessions.find((candidateSession) => candidateSession.id === sessionId);
  if (!session) return;
  session.sections = sections
    .map((section, sectionIndex) => normalizeSessionSection(section, sectionIndex))
    .sort((firstSection, secondSection) => firstSection.order - secondSection.order);
  const validIds = new Set(session.sections.map((section) => section.id));
  session.tabs = session.tabs.map((tab) => {
    const sectionIdentifier = tab.sectionId;
    if (typeof sectionIdentifier === "string" && validIds.has(sectionIdentifier)) return tab;
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

export const STAGED_CLOZE_CARDS_KEY = "stagedClozeCards";
export const CACHED_MANDALA_SUMMARY_KEY = "cachedMandalaSummary";
export const PENDING_MANDALA_LOGS_KEY = "pendingMandalaTimeLogs";
export const PENDING_MANDALA_SHELF_LINKS_KEY = "pendingMandalaShelfLinks";

export async function loadStagedClozeCards(): Promise<StagedClozeCard[]> {
  if (!browser.storage?.local) return [];
  const storedData = await browser.storage.local.get(STAGED_CLOZE_CARDS_KEY);
  const cards = storedData[STAGED_CLOZE_CARDS_KEY] as StagedClozeCard[] | undefined;
  return Array.isArray(cards) ? cards : [];
}

export async function saveStagedClozeCard(card: StagedClozeCard): Promise<void> {
  if (!browser.storage?.local) return;
  const existingCards = await loadStagedClozeCards();
  const updatedCards = [card, ...existingCards.filter((existingCard) => existingCard.id !== card.id)].slice(0, 500);
  await browser.storage.local.set({ [STAGED_CLOZE_CARDS_KEY]: updatedCards });
}

export async function clearStagedClozeCards(): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [STAGED_CLOZE_CARDS_KEY]: [] });
}

/** Removes the cards with these ids and returns the ones still staged. */
export async function removeStagedClozeCards(ids: string[]): Promise<StagedClozeCard[]> {
  if (!browser.storage?.local) return [];
  const idSet = new Set(ids);
  const remainingCards = (await loadStagedClozeCards()).filter((card) => !idSet.has(card.id));
  await browser.storage.local.set({ [STAGED_CLOZE_CARDS_KEY]: remainingCards });
  return remainingCards;
}

export async function loadCachedMandalaSummary(): Promise<CachedMandalaSummary | null> {
  if (!browser.storage?.local) return null;
  const storedData = await browser.storage.local.get(CACHED_MANDALA_SUMMARY_KEY);
  const summary = storedData[CACHED_MANDALA_SUMMARY_KEY] as CachedMandalaSummary | undefined;
  if (!summary || typeof summary !== "object") return null;
  return summary;
}

export async function saveCachedMandalaSummary(summary: CachedMandalaSummary): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [CACHED_MANDALA_SUMMARY_KEY]: summary });
}

