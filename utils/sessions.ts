import { getVideoIdFromUrl } from "./format";
import { normalizeYoutubeUrl, type SavedSession, type SavedSessionTab, type SessionSection, type VideoData } from "./storage";

export function videoIdFromTabUrl(url: string): string | null {
  return getVideoIdFromUrl(normalizeYoutubeUrl(url));
}

export function normalizeSavedSessionTab(tab: SavedSessionTab): SavedSessionTab {
  const url = normalizeYoutubeUrl(tab.url ?? "");
  return {
    url,
    title: tab.title,
    channelName: tab.channelName,
    seconds: tab.seconds,
    sectionId: typeof tab.sectionId === "string" && tab.sectionId.length > 0 ? tab.sectionId : undefined,
    language: tab.language ?? undefined,
    languageName: tab.languageName ?? undefined,
  };
}

export function videoDataToSavedTab(video: VideoData, sectionId?: string): SavedSessionTab {
  const videoId = video.videoId ?? getVideoIdFromUrl(video.url);
  return normalizeSavedSessionTab({
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : video.url,
    title: video.title,
    channelName: video.channelName,
    seconds: video.seconds,
    sectionId,
    language: video.language ?? undefined,
    languageName: video.languageName ?? undefined,
  });
}

export function dedupeTabsByVideoId(tabs: SavedSessionTab[]): SavedSessionTab[] {
  const seen = new Set<string>();
  const result: SavedSessionTab[] = [];
  for (const tab of tabs) {
    const id = videoIdFromTabUrl(tab.url) ?? tab.url;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(normalizeSavedSessionTab(tab));
  }
  return result;
}

export function sessionVideoIds(tabs: SavedSessionTab[]): Set<string> {
  const ids = new Set<string>();
  for (const tab of tabs) {
    const id = videoIdFromTabUrl(tab.url);
    if (id) ids.add(id);
    else if (tab.url) ids.add(tab.url);
  }
  return ids;
}

export function sessionTotalSeconds(tabs: SavedSessionTab[]): number {
  return tabs.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0);
}

/** Jaccard similarity on video IDs (0–1). */
export function sessionsOverlapScore(a: SavedSessionTab[], b: SavedSessionTab[]): number {
  const setA = sessionVideoIds(a);
  const setB = sessionVideoIds(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const id of setA) {
    if (setB.has(id)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function findSimilarSession(
  sessions: SavedSession[],
  tabs: SavedSessionTab[],
  threshold = 0.85
): SavedSession | null {
  let best: SavedSession | null = null;
  let bestScore = threshold;
  for (const session of sessions) {
    const score = sessionsOverlapScore(tabs, session.tabs ?? []);
    if (score >= bestScore) {
      bestScore = score;
      best = session;
    }
  }
  return best;
}

export function mergeSessionTabs(existing: SavedSessionTab[], incoming: SavedSessionTab[]): SavedSessionTab[] {
  const merged = [...existing.map(normalizeSavedSessionTab)];
  const existingIds = sessionVideoIds(merged);
  for (const tab of incoming.map(normalizeSavedSessionTab)) {
    const id = videoIdFromTabUrl(tab.url) ?? tab.url;
    if (existingIds.has(id)) continue;
    existingIds.add(id);
    merged.push(tab);
  }
  return merged;
}

export function mergeSessionSectionLists(
  existing: SessionSection[],
  incoming: SessionSection[]
): SessionSection[] {
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

export function buildTabsFromVideos(
  videos: VideoData[],
  assignments: Record<string, string>,
  sections: SessionSection[],
  options?: { excludeHidden?: boolean }
): { tabs: SavedSessionTab[]; sections: SessionSection[] } {
  const valid = new Set(sections.map((s) => s.id));
  const filtered = options?.excludeHidden ? videos.filter((v) => !v.excluded) : videos;
  const tabs = dedupeTabsByVideoId(
    filtered.map((video) => {
      const key = normalizeYoutubeUrl(video.url);
      const sid = assignments[key];
      return videoDataToSavedTab(video, sid && valid.has(sid) ? sid : undefined);
    })
  );
  const referenced = new Set(
    tabs.map((t) => t.sectionId).filter((x): x is string => typeof x === "string" && x.length > 0)
  );
  const secsToSave = sections.filter((s) => referenced.has(s.id));
  return { tabs, sections: secsToSave };
}

export function suggestSessionName(
  tabs: SavedSessionTab[],
  windowLabel?: string,
  sectionList?: SessionSection[]
): string {
  const count = tabs.length;
  if (count === 0) return "Untitled session";

  const sectionById = new Map((sectionList ?? []).map((s) => [s.id, s]));
  const sectionCounts = new Map<string, number>();
  for (const tab of tabs) {
    const sid = tab.sectionId;
    if (typeof sid === "string" && sid.length > 0 && sectionById.has(sid)) {
      sectionCounts.set(sid, (sectionCounts.get(sid) ?? 0) + 1);
    }
  }

  let dominantSectionId = "";
  let dominantCount = 0;
  for (const [id, n] of sectionCounts) {
    if (n > dominantCount) {
      dominantCount = n;
      dominantSectionId = id;
    }
  }
  // Name after a section only when it clearly represents this save (not 1 tab in Music + 249 unsorted).
  const minTabsForSectionName = Math.max(3, Math.ceil(count * 0.4));
  if (dominantSectionId && dominantCount >= minTabsForSectionName) {
    const sec = sectionById.get(dominantSectionId);
    if (sec) {
      const label = sec.emoji ? `${sec.emoji} ${sec.name}` : sec.name;
      return `${label} — ${count} videos`;
    }
  }

  if (windowLabel) {
    return `${windowLabel} — ${count} videos`;
  }

  const channelCounts = new Map<string, number>();
  for (const tab of tabs) {
    const ch = tab.channelName?.trim() || "Unknown";
    channelCounts.set(ch, (channelCounts.get(ch) ?? 0) + 1);
  }
  let topChannel = "";
  let topCount = 0;
  for (const [ch, n] of channelCounts) {
    if (n > topCount) {
      topChannel = ch;
      topCount = n;
    }
  }
  if (topChannel && topChannel !== "Unknown" && topCount >= Math.max(3, Math.ceil(count * 0.4))) {
    return `${topChannel} — ${count} videos`;
  }

  return `Session ${new Date().toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
}

export function formatSavedAgo(savedAt: number, now = Date.now()): string {
  const diffMs = Math.max(0, now - savedAt);
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(savedAt).toLocaleDateString(undefined, { dateStyle: "short" });
}

export type SaveSessionMode = "new" | "replace" | "merge";

export interface SaveSessionPayload {
  name: string;
  mode: SaveSessionMode;
  targetSessionId?: string;
}
