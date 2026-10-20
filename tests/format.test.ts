import { describe, expect, test } from "bun:test";
import {
  formatDurationWords,
  formatOffset,
  formatShortDuration,
  formatTime,
  getVideoIdFromUrl,
  isYoutubeWatchOrShortsUrl,
  parseTimeParam,
} from "../utils/format";

describe("getVideoIdFromUrl", () => {
  test("reads watch, shorts and youtu.be links", () => {
    expect(getVideoIdFromUrl("https://www.youtube.com/watch?v=abc123&t=10s")).toBe("abc123");
    expect(getVideoIdFromUrl("https://www.youtube.com/shorts/xyz789?feature=share")).toBe("xyz789");
    expect(getVideoIdFromUrl("https://youtu.be/def456?t=5")).toBe("def456");
  });

  test("is null for other pages and broken input", () => {
    expect(getVideoIdFromUrl("https://www.youtube.com/feed/subscriptions")).toBeNull();
    expect(getVideoIdFromUrl("not a url")).toBeNull();
  });
});

describe("isYoutubeWatchOrShortsUrl", () => {
  test("accepts watch and shorts pages on YouTube hosts", () => {
    expect(isYoutubeWatchOrShortsUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isYoutubeWatchOrShortsUrl("https://m.youtube.com/shorts/abc")).toBe(true);
    expect(isYoutubeWatchOrShortsUrl("https://youtu.be/abc")).toBe(true);
  });

  test("rejects the home feed, other sites and empty input", () => {
    expect(isYoutubeWatchOrShortsUrl("https://www.youtube.com/")).toBe(false);
    expect(isYoutubeWatchOrShortsUrl("https://example.com/watch?v=abc")).toBe(false);
    expect(isYoutubeWatchOrShortsUrl("")).toBe(false);
  });
});

describe("parseTimeParam", () => {
  test("reads seconds and h/m/s forms", () => {
    expect(parseTimeParam("https://www.youtube.com/watch?v=abc&t=90")).toBe(90);
    expect(parseTimeParam("https://www.youtube.com/watch?v=abc&t=1h2m3s")).toBe(3723);
    expect(parseTimeParam("https://www.youtube.com/watch?v=abc&time_continue=42")).toBe(42);
    expect(parseTimeParam("https://www.youtube.com/watch?v=abc")).toBe(0);
  });
});

describe("time formatting", () => {
  test("formatTime", () => {
    expect(formatTime(59)).toBe("0:59");
    expect(formatTime(754)).toBe("12:34");
    expect(formatTime(3723)).toBe("1:02:03");
  });

  test("formatDurationWords", () => {
    expect(formatDurationWords(45)).toBe("45 s");
    expect(formatDurationWords(840)).toBe("14 min");
    expect(formatDurationWords(8040)).toBe("2 h 14 min");
    expect(formatDurationWords(7200)).toBe("2 h");
  });

  test("formatOffset", () => {
    expect(formatOffset(30)).toBe("next");
    expect(formatOffset(600)).toBe("+10 min");
    expect(formatOffset(5580)).toBe("+1 h 33");
  });
});

describe("formatShortDuration", () => {
  test("keeps the two biggest units, short", () => {
    expect(formatShortDuration(3 * 3600 + 58 * 60 + 20)).toBe("3h 58m");
    expect(formatShortDuration(9 * 3600)).toBe("9h");
    expect(formatShortDuration(38 * 60 + 59)).toBe("38m");
    expect(formatShortDuration(53.7)).toBe("53s");
    expect(formatShortDuration(-4)).toBe("0s");
  });
});
