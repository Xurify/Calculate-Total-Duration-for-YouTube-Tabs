import { describe, expect, test } from "bun:test";
import {
  dedupeTabsByVideoId,
  findSimilarSession,
  formatSavedAgo,
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
