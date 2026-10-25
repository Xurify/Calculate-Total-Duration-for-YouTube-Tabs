import { describe, expect, test } from "bun:test";
import { formatPlaybackRate, parsePlaybackRate } from "../utils/playbackRate";

describe("parsePlaybackRate", () => {
  test("keeps a speed YouTube can play at", () => {
    expect(parsePlaybackRate(1.5)).toBe(1.5);
    expect(parsePlaybackRate(0.25)).toBe(0.25);
  });

  test("falls back to normal speed for missing or broken values", () => {
    expect(parsePlaybackRate(undefined)).toBe(1);
    expect(parsePlaybackRate("2")).toBe(1);
    expect(parsePlaybackRate(0)).toBe(1);
    expect(parsePlaybackRate(Number.NaN)).toBe(1);
  });
});

describe("formatPlaybackRate", () => {
  test("drops trailing zeros", () => {
    expect(formatPlaybackRate(1.5)).toBe("1.5×");
    expect(formatPlaybackRate(2)).toBe("2×");
    expect(formatPlaybackRate(1.333333)).toBe("1.33×");
  });
});
