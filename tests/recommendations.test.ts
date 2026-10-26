import { describe, expect, test } from "bun:test";
import { recommendInstead } from "../utils/recommendations";
import { at, watchEntry } from "./fixtures";

describe("recommendInstead", () => {
  const log = [
    watchEntry({ videoId: "english0001", startedAt: at(25, 8) }),
    watchEntry({ videoId: "slovak00001", language: "sk", languageName: "Slovak", startedAt: at(24, 8), lastPosition: 720, videoSeconds: 720 }),
    watchEntry({ videoId: "estonian001", language: "et", languageName: "Estonian", startedAt: at(23, 8), lastPosition: 10, videoSeconds: 10 }),
    watchEntry({ videoId: "estonian002", language: "et", languageName: "Estonian", startedAt: at(22, 8), lastPosition: 3590, videoSeconds: 3590 }),
    watchEntry({ videoId: "shortvideo1", language: "sk", languageName: "Slovak", isShort: true, startedAt: at(25, 7) }),
    watchEntry({ videoId: "unknownlang", language: null, languageName: null, startedAt: at(25, 6) }),
  ];

  test("offers unfinished videos in other languages, goal languages first", () => {
    const picks = recommendInstead(log, [{ language: "Estonian", minutes: 20, kind: "goal" }], "English", at(25, 12));
    expect(picks.map((pick) => pick.videoId)).toEqual(["estonian001", "slovak00001"]);
    expect(picks[0]).toMatchObject({ forGoal: true, resumeSeconds: 0 });
    expect(picks[1]).toMatchObject({ forGoal: false, resumeSeconds: 720, language: "Slovak" });
  });

  test("skips languages that are over their own limit today", () => {
    const busy = [...log, watchEntry({ videoId: "slovak00002", language: "sk", languageName: "Slovak", startedAt: at(25, 9), playedSeconds: 3600 })];
    const picks = recommendInstead(busy, [{ language: "Slovak", minutes: 30 }], "English", at(25, 12));
    expect(picks.every((pick) => pick.language !== "Slovak")).toBe(true);
  });
});

describe("recommendInstead variety", () => {
  test("offers one video per language before a second from the same one", () => {
    const log = [
      watchEntry({ videoId: "slovak00001", language: "sk", languageName: "Slovak", startedAt: at(25, 9) }),
      watchEntry({ videoId: "slovak00002", language: "sk", languageName: "Slovak", startedAt: at(25, 8) }),
      watchEntry({ videoId: "slovak00003", language: "sk", languageName: "Slovak", startedAt: at(25, 7) }),
      watchEntry({ videoId: "czech000001", language: "cs", languageName: "Czech", startedAt: at(20, 7) }),
    ];
    expect(recommendInstead(log, [], "English", at(25, 12)).map((pick) => pick.videoId)).toEqual(["slovak00001", "slovak00002", "czech000001"]);
  });
});
