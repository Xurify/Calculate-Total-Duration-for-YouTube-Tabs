import { describe, expect, test } from "bun:test";
import { focusKeyOf, focusLabelOf, focusWatchSummary, OTHER_LANGUAGES, parseFocusLanguages } from "../utils/focusLanguages";
import { summarizeWatch } from "../utils/watchLog";
import { at, watchEntry } from "./fixtures";

const NOW = at(25, 20);

const entries = [
  watchEntry({ id: "1", videoId: "slovak00001", language: "sk", languageName: "Slovak", channelName: "Slovake.eu", startedAt: at(25, 9), playedSeconds: 1200 }),
  watchEntry({ id: "2", videoId: "eesti000001", language: "et", languageName: "eesti", channelName: "ERR", startedAt: at(24, 9), playedSeconds: 600 }),
  watchEntry({ id: "3", videoId: "english0001", language: "en", languageName: "English", channelName: "Vlog", startedAt: at(25, 10), playedSeconds: 900 }),
  watchEntry({ id: "4", videoId: "french00001", language: "fr", languageName: "French", channelName: "Vlog", startedAt: at(24, 10), playedSeconds: 300 }),
  watchEntry({ id: "5", videoId: "unknown0001", language: null, languageName: null, channelName: "Music", startedAt: at(25, 11), playedSeconds: 120 }),
];

describe("focus languages", () => {
  test("names and codes of one language meet on the code", () => {
    expect(focusKeyOf("Slovak")).toBe("sk");
    expect(focusKeyOf("slovaki")).toBe("sk");
    expect(focusKeyOf("SK")).toBe("sk");
    expect(parseFocusLanguages(["Slovak", "sk", "", 3, "Estonian"])).toEqual(["sk", "et"]);
  });

  test("an empty list follows every language", () => {
    const watch = summarizeWatch(entries, 7, NOW);
    expect(focusWatchSummary(watch, [])).toBe(watch);
    expect(focusLabelOf([], "French")).toBe("French");
  });

  test("folds the rest into one row without losing time", () => {
    const watch = summarizeWatch(entries, 7, NOW);
    const focused = focusWatchSummary(watch, ["sk", "et"]);
    expect(focused.byLanguage.map((row) => row.label)).toEqual(["Slovak", "Estonian", OTHER_LANGUAGES]);
    expect(focused.byLanguage.at(-1)).toEqual({ label: OTHER_LANGUAGES, seconds: 1320, videos: 3 });
    expect(focused.byLanguage.reduce((sum, row) => sum + row.seconds, 0)).toBe(focused.total.playedSeconds);
    const today = focused.days.at(-1)!;
    expect(today.languages).toEqual({ Slovak: 1200, [OTHER_LANGUAGES]: 1020 });
    expect(focused.byChannel.find((channel) => channel.channelName === "Vlog")?.language).toBe(OTHER_LANGUAGES);
    expect(focused.videos.find((video) => video.videoId === "french00001")?.language).toBe("French");
  });

  test("shows no Other row when everything watched is followed", () => {
    const watch = summarizeWatch(entries.slice(0, 2), 7, NOW);
    expect(focusWatchSummary(watch, ["sk", "et"]).byLanguage.map((row) => row.label)).toEqual(["Slovak", "Estonian"]);
  });
});
