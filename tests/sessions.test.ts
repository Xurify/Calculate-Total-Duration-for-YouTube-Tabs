import { describe, expect, test } from "bun:test";
import {
  dedupeTabsByVideoId,
  findOpenTabFor,
  findSimilarSession,
  formatSavedAgo,
  linkStartSeconds,
  sessionTotalSeconds,
  sessionsOverlapScore,
  suggestSessionName,
} from "../utils/sessions";
import type { SavedSession, SavedSessionTab } from "../utils/storage";

function tab(videoId: string, extra: Partial<SavedSessionTab> = {}): SavedSessionTab {
  return { url: `https://www.youtube.com/watch?v=${videoId}`, title: videoId, seconds: 60, ...extra };
}

function session(id: string, tabs: SavedSessionTab[]): SavedSession {
  return { id, name: id, savedAt: 0, tabs };
}

describe("sessionsOverlapScore", () => {
  test("is the share of videos the two lists have in common", () => {
    expect(sessionsOverlapScore([tab("a"), tab("b")], [tab("b"), tab("c")])).toBeCloseTo(1 / 3);
    expect(sessionsOverlapScore([tab("a")], [tab("a")])).toBe(1);
    expect(sessionsOverlapScore([tab("a")], [tab("b")])).toBe(0);
    expect(sessionsOverlapScore([], [])).toBe(1);
  });
});

describe("findSimilarSession", () => {
  const sessions = [session("one", [tab("a"), tab("b"), tab("c")]), session("two", [tab("x"), tab("y")])];

  test("returns the session that nearly matches", () => {
    expect(findSimilarSession(sessions, [tab("a"), tab("b"), tab("c")])?.id).toBe("one");
  });

  test("returns null when nothing is close enough", () => {
    expect(findSimilarSession(sessions, [tab("a"), tab("q"), tab("r")])).toBeNull();
  });
});

describe("dedupeTabsByVideoId and sessionTotalSeconds", () => {
  test("keeps one tab per video and sums their seconds", () => {
    const tabs = dedupeTabsByVideoId([tab("a"), tab("a", { url: "https://youtu.be/a" }), tab("b", { seconds: 30 })]);
    expect(tabs).toHaveLength(2);
    expect(sessionTotalSeconds(tabs)).toBe(90);
  });
});

describe("suggestSessionName", () => {
  test("names the session after a channel that dominates it", () => {
    const tabs = [tab("a", { channelName: "Slovak Lessons" }), tab("b", { channelName: "Slovak Lessons" }), tab("c", { channelName: "Slovak Lessons" }), tab("d", { channelName: "Other" })];
    expect(suggestSessionName(tabs)).toBe("Slovak Lessons — 4 videos");
  });

  test("prefers the window label and a dominant section", () => {
    const tabs = [tab("a", { sectionId: "s1" }), tab("b", { sectionId: "s1" }), tab("c", { sectionId: "s1" })];
    const sections = [{ id: "s1", name: "Grammar", emoji: "📚", order: 0 }];
    expect(suggestSessionName(tabs, "Window 2")).toBe("Window 2 — 3 videos");
    expect(suggestSessionName(tabs, undefined, sections)).toBe("📚 Grammar — 3 videos");
  });

  test("handles an empty list", () => {
    expect(suggestSessionName([])).toBe("Untitled session");
  });
});

describe("formatSavedAgo", () => {
  const now = 1_700_000_000_000;

  test("rounds to the nearest unit", () => {
    expect(formatSavedAgo(now, now)).toBe("just now");
    expect(formatSavedAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatSavedAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatSavedAgo(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("findOpenTabFor", () => {
  const tabs = [
    { id: 1, windowId: 10, url: "https://www.youtube.com/watch?v=abc123&t=42s", active: false },
    { id: 2, windowId: 20, url: "https://www.youtube.com/watch?v=abc123&list=PL1", active: true },
    { id: 3, windowId: 10, url: "https://example.com/article" },
  ];

  test("matches the same video whatever the link looks like", () => {
    expect(findOpenTabFor(tabs, "https://youtu.be/abc123", 10)?.id).toBe(1);
    expect(findOpenTabFor(tabs, "https://www.youtube.com/watch?v=abc123&t=90", 10)?.id).toBe(1);
  });

  test("prefers the current window, then the tab already in front", () => {
    expect(findOpenTabFor(tabs, "https://youtu.be/abc123", 20)?.id).toBe(2);
    expect(findOpenTabFor(tabs, "https://youtu.be/abc123", 99)?.id).toBe(2);
  });

  test("matches other pages by address and finds nothing for unopened videos", () => {
    expect(findOpenTabFor(tabs, "https://example.com/article", 10)?.id).toBe(3);
    expect(findOpenTabFor(tabs, "https://youtu.be/zzz999", 10)).toBeNull();
  });
});

describe("linkStartSeconds", () => {
  test("reads every form YouTube uses", () => {
    expect(linkStartSeconds("https://www.youtube.com/watch?v=a&t=90")).toBe(90);
    expect(linkStartSeconds("https://www.youtube.com/watch?v=a&t=90s")).toBe(90);
    expect(linkStartSeconds("https://youtu.be/a?t=1m30s")).toBe(90);
    expect(linkStartSeconds("https://www.youtube.com/watch?v=a&t=1h2m3s")).toBe(3723);
  });

  test("is null without a usable time", () => {
    expect(linkStartSeconds("https://www.youtube.com/watch?v=a")).toBeNull();
    expect(linkStartSeconds("https://www.youtube.com/watch?v=a&t=soon")).toBeNull();
  });
});
