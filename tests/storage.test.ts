import { describe, expect, test } from "bun:test";
import { applyMetadataBatchToCache, applyStorePatch, type StoreState } from "../utils/store";
import {
  lookupCachedMetadata,
  mandalaStatusFor,
  normalizeYoutubeUrl,
  shelfLinksForVideo,
  type CachedMandalaSummary,
  type CachedMetadata,
} from "../utils/storage";

const URL_A = "https://www.youtube.com/watch?v=abc123";

function cachedEntry(overrides: Partial<CachedMetadata> = {}): CachedMetadata {
  return {
    seconds: 600,
    title: "Výlet do Bratislavy",
    channelName: "Slovak with Lucia",
    currentTime: 0,
    isLive: false,
    videoId: "abc123",
    language: "sk",
    languageName: "Slovak",
    languageVersion: 4,
    chapters: [{ title: "Intro", startSeconds: 0 }],
    timestamp: 1,
    ...overrides,
  };
}

describe("applyMetadataBatchToCache", () => {
  test("a playback update keeps the language and chapters it doesn't carry", () => {
    const cache = { [URL_A]: cachedEntry() };
    const delta = applyMetadataBatchToCache(
      cache,
      new Map([[URL_A, { url: URL_A, metadata: { seconds: 600, title: "Výlet do Bratislavy", channelName: "Slovak with Lucia", currentTime: 120, isLive: false, videoId: "abc123" } }]])
    );
    expect(cache[URL_A].language).toBe("sk");
    expect(cache[URL_A].chapters).toEqual([{ title: "Intro", startSeconds: 0 }]);
    expect(cache[URL_A].currentTime).toBe(120);
    expect(Object.keys(delta.changed)).toEqual([URL_A]);
  });

  test("reports nothing when only the timestamp moved", () => {
    const cache = { [URL_A]: cachedEntry() };
    const { language, languageName, chapters, ...metadata } = cachedEntry();
    const delta = applyMetadataBatchToCache(cache, new Map([[URL_A, { url: URL_A, metadata: { ...metadata, language, languageName, chapters } }]]));
    expect(delta).toEqual({ changed: {}, removed: [] });
    expect(cache[URL_A].timestamp).toBeGreaterThan(1);
  });
});

describe("applyStorePatch", () => {
  test("merges a patch into the cache and drops evicted entries", () => {
    const state: StoreState = { prefs: {} as StoreState["prefs"], metadataCache: { old: cachedEntry(), [URL_A]: cachedEntry() } };
    applyStorePatch(state, { metadataPatch: { changed: { [URL_A]: cachedEntry({ currentTime: 30 }) }, removed: ["old"] } });
    expect(Object.keys(state.metadataCache)).toEqual([URL_A]);
    expect(state.metadataCache[URL_A].currentTime).toBe(30);
  });
});

describe("lookupCachedMetadata", () => {
  test("still finds a video saved days ago", () => {
    const cache = { [URL_A]: cachedEntry({ timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 }) };
    expect(lookupCachedMetadata(cache, `${URL_A}&t=10s`)?.seconds).toBe(600);
  });
});

describe("normalizeYoutubeUrl", () => {
  test("reduces watch, shorts and youtu.be links to one watch URL", () => {
    expect(normalizeYoutubeUrl("https://www.youtube.com/watch?v=abc123&t=10s&list=PL1")).toBe(
      "https://www.youtube.com/watch?v=abc123"
    );
    expect(normalizeYoutubeUrl("https://www.youtube.com/shorts/abc123")).toBe("https://www.youtube.com/watch?v=abc123");
    expect(normalizeYoutubeUrl("https://youtu.be/abc123?t=5")).toBe("https://www.youtube.com/watch?v=abc123");
  });

  test("leaves other addresses alone", () => {
    expect(normalizeYoutubeUrl("https://example.com/watch?v=abc123")).toBe("https://example.com/watch?v=abc123");
    expect(normalizeYoutubeUrl("not a url")).toBe("not a url");
  });
});

const summary: CachedMandalaSummary = {
  activeChartId: "chart_1",
  activeChartTitle: "Learn Slovak",
  pillars: [
    { index: 0, title: "Listening", named: true, actionCount: 3 },
    { index: 1, title: "Pillar 2", named: false, actionCount: 0 },
    { index: 2, title: "Grammar", named: true, actionCount: 1 },
  ],
  shelfLinks: [
    { id: "tool_a", pillarIndex: 0, title: "Podcast", url: "https://youtu.be/abc123" },
    { id: "tool_b", pillarIndex: 2, title: "Podcast again", url: "https://www.youtube.com/watch?v=abc123&t=30" },
    { id: "tool_c", pillarIndex: 2, title: "Other", url: "https://www.youtube.com/watch?v=zzz" },
  ],
  lastUpdatedAt: 0,
};

describe("shelfLinksForVideo", () => {
  test("matches the same video across link forms", () => {
    const links = shelfLinksForVideo(summary.shelfLinks, "https://www.youtube.com/shorts/abc123");
    expect(links.map((link) => link.id)).toEqual(["tool_a", "tool_b"]);
  });

  test("finds nothing for a video that is not shelved", () => {
    expect(shelfLinksForVideo(summary.shelfLinks, "https://www.youtube.com/watch?v=nope")).toEqual([]);
  });
});

describe("mandalaStatusFor", () => {
  test("lists named pillars and the pillars holding the video, without duplicates", () => {
    const status = mandalaStatusFor(summary, "https://www.youtube.com/watch?v=abc123", { connected: true, cached: false });
    expect(status.connected).toBe(true);
    expect(status.activeChartTitle).toBe("Learn Slovak");
    expect(status.pillars.map((pillar) => pillar.index)).toEqual([0, 2]);
    expect(status.savedPillarIndexes).toEqual([0, 2]);
  });

  test("falls back to every pillar when none is named yet", () => {
    const blank: CachedMandalaSummary = {
      ...summary,
      pillars: summary.pillars.map((pillar) => ({ ...pillar, named: false })),
    };
    const status = mandalaStatusFor(blank, "https://www.youtube.com/watch?v=none", { connected: false, cached: true });
    expect(status.pillars).toHaveLength(3);
    expect(status.savedPillarIndexes).toEqual([]);
  });
});
