import { describe, expect, test } from "bun:test";
import { closeStaleEntries, MERGE_GAP_MS, pendingForMandala, recordStretch, wholeMinutes, type RuleMatch, type TimeEntry, type TimeMode } from "../utils/timeLog";

const url = "https://www.youtube.com/watch?v=live123";
const match: RuleMatch = { source: "host", pillarIndex: 2, actionId: "listening", ruleId: "rule_1" };
const minute = 60_000;

function stretch(entries: TimeEntry[], mode: TimeMode, fromMinute: number, toMinute: number, page = url): void {
  recordStretch(entries, { url: page, title: "Livestream", startedAt: fromMinute * minute, endedAt: toMinute * minute, mode, match });
}

describe("recordStretch", () => {
  test("keeps one active and one passive entry while the page flips between the two", () => {
    const entries: TimeEntry[] = [];
    stretch(entries, "active", 0, 3);
    stretch(entries, "passive", 3, 12);
    stretch(entries, "active", 12, 15);
    stretch(entries, "passive", 15, 29);
    stretch(entries, "active", 29, 29.5);
    stretch(entries, "passive", 29.5, 40);

    expect(entries).toHaveLength(2);
    const [active, passive] = entries;
    expect(active.mode).toBe("active");
    expect(active.seconds).toBe(6.5 * 60);
    expect(passive.mode).toBe("passive");
    expect(passive.seconds).toBe(33.5 * 60);
  });

  test("starts new entries once the page has gone uncounted for longer than the merge gap", () => {
    const entries: TimeEntry[] = [];
    stretch(entries, "active", 0, 3);
    stretch(entries, "passive", 3, 10);
    stretch(entries, "active", 10 + MERGE_GAP_MS / minute + 1, 20);

    expect(entries).toHaveLength(3);
    expect(entries[0].open).toBe(false);
    expect(entries[2].open).toBe(true);
  });

  test("does not let another page's time hold a session open", () => {
    const entries: TimeEntry[] = [];
    stretch(entries, "active", 0, 3);
    stretch(entries, "active", 3, 20, "https://example.com/other");
    stretch(entries, "active", 20, 22);

    expect(entries.filter((entry) => entry.url === url)).toHaveLength(2);
  });
});

describe("closeStaleEntries", () => {
  test("leaves a quiet mode open while the same page is still counted in the other", () => {
    const entries: TimeEntry[] = [];
    stretch(entries, "active", 0, 2);
    stretch(entries, "passive", 2, 30);

    expect(closeStaleEntries(entries, 31 * minute)).toBe(false);
    expect(entries.every((entry) => entry.open)).toBe(true);

    expect(closeStaleEntries(entries, 30 * minute + MERGE_GAP_MS + 1)).toBe(true);
    expect(pendingForMandala(entries).map(wholeMinutes)).toEqual([2, 28]);
  });
});
