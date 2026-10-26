import { describe, expect, test } from "bun:test";
import { csvCell, watchCsv, watchEntriesSince } from "../utils/watchCsv";
import { at, watchEntry } from "./fixtures";

describe("csvCell", () => {
  test("quotes commas and quotes, and defuses formulas", () => {
    expect(csvCell('Say "hi", then')).toBe('"Say ""hi"", then"');
    expect(csvCell("=HYPERLINK()")).toBe("'=HYPERLINK()");
    expect(csvCell(4.5)).toBe("4.5");
  });
});

describe("watchCsv", () => {
  test("writes the chosen columns in a fixed order, newest first", () => {
    const csv = watchCsv(
      [
        watchEntry({ startedAt: at(24, 9, 5), title: "Older", playedSeconds: 90, videoSeconds: 135 }),
        watchEntry({ startedAt: at(25, 18), title: "Newer, with comma" }),
      ],
      ["speed", "title", "date", "time"]
    );
    expect(csv.split("\r\n")).toEqual(["date,start_time,title,speed", '2026-10-25,18:00,"Newer, with comma",1', "2026-10-24,09:05,Older,1.5", ""]);
  });
});

describe("watchEntriesSince", () => {
  test("keeps whole days back from today", () => {
    const entries = [watchEntry({ startedAt: at(19, 23) }), watchEntry({ startedAt: at(20, 0, 30) })];
    expect(watchEntriesSince(entries, 7, at(26, 12))).toHaveLength(1);
    expect(watchEntriesSince(entries, null, at(26, 12))).toHaveLength(2);
  });
});
