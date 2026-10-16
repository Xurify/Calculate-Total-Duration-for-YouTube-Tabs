import { describe, expect, test } from "bun:test";
import { HUD_CLEARANCE_PX, hudTopBelow, isControlSizedBox, type Box } from "../utils/hudLayout";

const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

const shortsPlayer = box(546, 64, 452, 804);

describe("isControlSizedBox", () => {
  test("accepts a button-sized box and rejects empty ones", () => {
    expect(isControlSizedBox(box(900, 80, 40, 40), shortsPlayer)).toBe(true);
    expect(isControlSizedBox(box(900, 80, 0, 40), shortsPlayer)).toBe(false);
  });

  test("rejects layers that cover most of the player", () => {
    expect(isControlSizedBox(box(546, 64, 452, 804), shortsPlayer)).toBe(false);
    expect(isControlSizedBox(box(546, 64, 452, 60), shortsPlayer)).toBe(false);
    expect(isControlSizedBox(box(900, 64, 40, 500), shortsPlayer)).toBe(false);
  });
});

describe("hudTopBelow", () => {
  test("is null when nothing is in the way", () => {
    expect(hudTopBelow([], shortsPlayer)).toBeNull();
  });

  test("sits under the lowest control row with a clearance gap", () => {
    const captions = box(880, 84, 40, 40);
    const menu = box(928, 84, 40, 48);
    expect(hudTopBelow([captions, menu], shortsPlayer)).toBe(132 - 64 + HUD_CLEARANCE_PX);
  });

  test("ignores whole-player layers when picking the row to clear", () => {
    const tapLayer = box(546, 64, 452, 804);
    const playButton = box(560, 80, 40, 40);
    expect(hudTopBelow([tapLayer, playButton], shortsPlayer)).toBe(120 - 64 + HUD_CLEARANCE_PX);
    expect(hudTopBelow([tapLayer], shortsPlayer)).toBeNull();
  });

  test("gives up rather than push the HUD into the lower half of the player", () => {
    const lowControl = box(900, 64 + 500, 40, 40);
    expect(hudTopBelow([lowControl], shortsPlayer)).toBeNull();
  });
});
