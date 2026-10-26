import { describe, expect, test } from "bun:test";
import { cleanWatchSample, recordWatchSample, summarizeWatch, type WatchEntry, type WatchSample } from "../utils/watchLog";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

function sample(overrides: Partial<WatchSample> = {}): WatchSample {
  const startedAt = overrides.startedAt ?? at(20, 9);
  return {
    videoId: "abc123def45",
    title: "Slovak for beginners",
    channelName: "Slovake.eu",
    channelAvatar: "https://yt3.ggpht.com/abc=s48-c-k-c0x00ffffff-no-rj",
    language: "sk",
    languageName: "Slovak",
    durationSeconds: 600,
    isLive: false,
    isShort: false,
    startedAt,
    endedAt: startedAt + 15_000,
    playedSeconds: 15,
    videoSeconds: 15,
    visibleSeconds: 15,
    captionSeconds: 0,
    adSeconds: 0,
    position: 15,
    ...overrides,
  };
}

describe("cleanWatchSample", () => {
  test("keeps a sound sample", () => {
    expect(cleanWatchSample(sample())).toEqual(sample());
  });

  test("drops what is not a sample, or holds less than a second", () => {
    expect(cleanWatchSample(null)).toBeNull();
    expect(cleanWatchSample({ ...sample(), videoId: "<script>" })).toBeNull();
    expect(cleanWatchSample(sample({ playedSeconds: 0.4, adSeconds: 0 }))).toBeNull();
    expect(cleanWatchSample(sample({ endedAt: at(20, 8) }))).toBeNull();
  });

  test("caps seconds at what the sample's span allows", () => {
    const cleaned = cleanWatchSample(sample({ playedSeconds: 5000, visibleSeconds: 9000, videoSeconds: 1e9 }))!;
    expect(cleaned.playedSeconds).toBe(20);
    expect(cleaned.visibleSeconds).toBe(20);
    expect(cleaned.videoSeconds).toBe(320);
  });

  test("keeps only avatars served by YouTube", () => {
    expect(cleanWatchSample(sample({ channelAvatar: "https://evil.example/a.png" }))!.channelAvatar).toBeNull();
    expect(cleanWatchSample(sample({ channelAvatar: "data:image/gif;base64,R0lGOD" }))!.channelAvatar).toBeNull();
  });
});

describe("recordWatchSample", () => {
  test("extends the sitting when the same video follows closely", () => {
    const log: WatchEntry[] = [];
    recordWatchSample(log, sample({ title: "", channelName: "", language: null, languageName: null }));
    recordWatchSample(log, sample({ startedAt: at(20, 9, 1), endedAt: at(20, 9, 1) + 15_000, position: 75 }));
    expect(log).toHaveLength(1);
    expect(log[0].playedSeconds).toBe(30);
    expect(log[0].title).toBe("Slovak for beginners");
    expect(log[0].languageName).toBe("Slovak");
    expect(log[0].lastPosition).toBe(75);
    expect(log[0].hours["9"]).toBe(30);
    expect(log[0].id.startsWith("watch_")).toBe(true);
    expect("channelAvatar" in log[0]).toBe(false);
  });

  test("starts a new sitting after a long gap, or on another day", () => {
    const log: WatchEntry[] = [];
    recordWatchSample(log, sample());
    recordWatchSample(log, sample({ startedAt: at(20, 11), endedAt: at(20, 11) + 15_000 }));
    recordWatchSample(log, sample({ startedAt: at(21, 0, 1), endedAt: at(21, 0, 1) + 15_000 }));
    expect(log).toHaveLength(3);
  });
});

describe("summarizeWatch", () => {
  const log: WatchEntry[] = [];
  recordWatchSample(log, sample({ startedAt: at(18, 21), endedAt: at(18, 21, 10), playedSeconds: 600, videoSeconds: 600, visibleSeconds: 600 }));
  recordWatchSample(
    log,
    sample({
      videoId: "zzz999yyy88",
      title: "Eesti uudised",
      channelName: "ERR",
      language: "et",
      languageName: "Estonian",
      durationSeconds: 1200,
      startedAt: at(19, 8),
      endedAt: at(19, 8, 10),
      playedSeconds: 400,
      videoSeconds: 600,
      visibleSeconds: 100,
      captionSeconds: 400,
      adSeconds: 30,
    })
  );
  recordWatchSample(log, sample({ startedAt: at(20, 21), endedAt: at(20, 21, 1), playedSeconds: 60, videoSeconds: 60, visibleSeconds: 60 }));

  test("adds up time, speed and finished videos for the range", () => {
    const summary = summarizeWatch(log, 7, at(20, 22));
    expect(summary.total.playedSeconds).toBe(1060);
    expect(summary.total.videoSeconds).toBe(1260);
    expect(summary.total.captionSeconds).toBe(400);
    expect(summary.total.adSeconds).toBe(30);
    expect(summary.total.videos).toBe(2);
    expect(summary.total.completed).toBe(1);
    expect(summary.total.activeDays).toBe(3);
    expect(summary.byHour[21]).toBe(660);
    expect(summary.byLanguage.map((row) => row.label)).toEqual(["Slovak", "Estonian"]);
    expect(summary.byChannel[0]).toMatchObject({ channelName: "Slovake.eu", videos: 1, language: "Slovak" });
    expect(summary.videos[0].videoId).toBe("abc123def45");
    expect(summary.videos.find((video) => video.videoId === "zzz999yyy88")?.coverage).toBe(0.5);
  });

  test("splits each day by language and the week by weekday and hour", () => {
    const summary = summarizeWatch(log, 7, at(20, 22));
    expect(summary.days.find((day) => day.key === "2026-10-19")?.languages).toEqual({ Estonian: 400 });
    expect(summary.days.find((day) => day.key === "2026-10-18")?.languages).toEqual({ Slovak: 600 });
    // 18 October 2026 is a Sunday, 20 October a Tuesday; rows start on Monday.
    expect(summary.byWeekdayHour[6][21]).toBe(600);
    expect(summary.byWeekdayHour[1][21]).toBe(60);
    expect(summary.byWeekdayHour.flat().reduce((sum, seconds) => sum + seconds, 0)).toBe(1060);
  });

  test("gives each channel its stored avatar", () => {
    const byChannel = summarizeWatch(log, 7, at(20, 22), null, { ERR: "https://yt3.ggpht.com/err" }).byChannel;
    expect(byChannel.find((row) => row.channelName === "ERR")?.avatarUrl).toBe("https://yt3.ggpht.com/err");
    expect(byChannel.find((row) => row.channelName === "Slovake.eu")?.avatarUrl).toBeNull();
  });

  test("leaves out what falls before the range", () => {
    expect(summarizeWatch(log, 1, at(20, 22)).total.playedSeconds).toBe(60);
  });

  test("uses the desk's language overrides", () => {
    const overrides = { videos: {}, channels: { ERR: { code: "fi", name: "Finnish" } } };
    expect(summarizeWatch(log, 7, at(20, 22), overrides).byLanguage.map((row) => row.label)).toContain("Finnish");
  });

  test("counts a streak that is still open today", () => {
    expect(summarizeWatch(log, 7, at(20, 22)).streak).toEqual({ current: 3, longest: 3 });
    expect(summarizeWatch(log, 7, at(21, 7)).streak.current).toBe(3);
    expect(summarizeWatch(log, 7, at(23, 7)).streak.current).toBe(0);
  });
});
