import { describe, expect, test } from "bun:test";
import { formatDurationInput, parseDurationMinutes, stepDurationMinutes } from "../utils/languageLimits";

describe("parseDurationMinutes", () => {
  test("reads the ways people type a daily amount", () => {
    expect(parseDurationMinutes("45")).toBe(45);
    expect(parseDurationMinutes("45 min")).toBe(45);
    expect(parseDurationMinutes("3h")).toBe(180);
    expect(parseDurationMinutes("3 h")).toBe(180);
    expect(parseDurationMinutes("3 hours")).toBe(180);
    expect(parseDurationMinutes("2.5h")).toBe(150);
    expect(parseDurationMinutes("2,5 h")).toBe(150);
    expect(parseDurationMinutes("1h30")).toBe(90);
    expect(parseDurationMinutes("1 h 30 min")).toBe(90);
    expect(parseDurationMinutes("1:30")).toBe(90);
  });

  test("rejects text that is not a time", () => {
    expect(parseDurationMinutes("")).toBeNull();
    expect(parseDurationMinutes("abc")).toBeNull();
    expect(parseDurationMinutes("3 days")).toBeNull();
    expect(parseDurationMinutes("30 min 5")).toBeNull();
  });
});

describe("formatDurationInput", () => {
  test("reads back the way it is typed", () => {
    expect(formatDurationInput(30)).toBe("30 min");
    expect(formatDurationInput(180)).toBe("3 h");
    expect(formatDurationInput(90)).toBe("1 h 30 min");
    for (const minutes of [5, 60, 95, 600]) expect(parseDurationMinutes(formatDurationInput(minutes))).toBe(minutes);
  });
});

describe("stepDurationMinutes", () => {
  test("takes bigger steps as the amount grows", () => {
    expect(stepDurationMinutes(30, 1)).toBe(35);
    expect(stepDurationMinutes(55, 1)).toBe(60);
    expect(stepDurationMinutes(60, 1)).toBe(75);
    expect(stepDurationMinutes(180, 1)).toBe(210);
    expect(stepDurationMinutes(60, -1)).toBe(55);
    expect(stepDurationMinutes(180, -1)).toBe(165);
    expect(stepDurationMinutes(47, 1)).toBe(50);
    expect(stepDurationMinutes(5, -1)).toBe(1);
  });
});

describe("parseDurationMinutes with hours as the bare unit", () => {
  test("a bare number is hours, units still win", () => {
    expect(parseDurationMinutes("3", "h")).toBe(180);
    expect(parseDurationMinutes("1.5", "h")).toBe(90);
    expect(parseDurationMinutes("45 min", "h")).toBe(45);
    expect(parseDurationMinutes("1h30", "h")).toBe(90);
    expect(parseDurationMinutes("1:30", "h")).toBe(90);
  });
});
