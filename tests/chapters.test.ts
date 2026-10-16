import { describe, expect, test } from "bun:test";
import {
  extractChaptersFromDescription,
  extractChaptersFromPlayerResponse,
  parseTimestampToSeconds,
} from "../utils/chapters";

function playerResponseWithMarkers(chapters: Array<{ title: string; startMillis: number }>) {
  return {
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                markersMap: [
                  {
                    key: "DESCRIPTION_CHAPTERS",
                    value: {
                      chapters: chapters.map((chapter) => ({
                        chapterRenderer: {
                          title: { simpleText: chapter.title },
                          timeRangeStartMillis: chapter.startMillis,
                        },
                      })),
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}

describe("parseTimestampToSeconds", () => {
  test("reads m:ss, mm:ss and h:mm:ss", () => {
    expect(parseTimestampToSeconds("0:05")).toBe(5);
    expect(parseTimestampToSeconds("12:30")).toBe(750);
    expect(parseTimestampToSeconds("1:02:03")).toBe(3723);
  });
});

describe("extractChaptersFromPlayerResponse", () => {
  test("reads the player's chapter markers and fills in durations", () => {
    const chapters = extractChaptersFromPlayerResponse(
      playerResponseWithMarkers([
        { title: "Intro", startMillis: 0 },
        { title: "Grammar", startMillis: 90_000 },
        { title: "Outro", startMillis: 600_000 },
      ]),
      720
    );

    expect(chapters).toEqual([
      { title: "Intro", startSeconds: 0, durationSeconds: 90 },
      { title: "Grammar", startSeconds: 90, durationSeconds: 510 },
      { title: "Outro", startSeconds: 600, durationSeconds: 120 },
    ]);
  });

  test("falls back to timestamps in the description", () => {
    const chapters = extractChaptersFromPlayerResponse(
      {
        videoDetails: {
          shortDescription: "Lesson notes\n0:00 Intro\n2:15 - Vocabulary\n10:00 Dialogue\nThanks for watching",
        },
      },
      900
    );

    expect(chapters.map((chapter) => chapter.title)).toEqual(["Intro", "Vocabulary", "Dialogue"]);
    expect(chapters.map((chapter) => chapter.startSeconds)).toEqual([0, 135, 600]);
    expect(chapters[2].durationSeconds).toBe(300);
  });

  test("returns nothing for a single marker, no description or a bad response", () => {
    expect(extractChaptersFromPlayerResponse(playerResponseWithMarkers([{ title: "Only", startMillis: 0 }]), 100)).toEqual([]);
    expect(extractChaptersFromPlayerResponse({ videoDetails: { shortDescription: "No chapters here" } }, 100)).toEqual([]);
    expect(extractChaptersFromPlayerResponse(null, 100)).toEqual([]);
    expect(extractChaptersFromPlayerResponse("text", 100)).toEqual([]);
  });
});

describe("extractChaptersFromDescription", () => {
  test("sorts out-of-order timestamps and leaves the last duration open when the total is unknown", () => {
    const chapters = extractChaptersFromDescription("5:00 Second\n0:00 First", 0);
    expect(chapters.map((chapter) => chapter.title)).toEqual(["First", "Second"]);
    expect(chapters[0].durationSeconds).toBe(300);
    expect(chapters[1].durationSeconds).toBeUndefined();
  });

  test("needs at least two timestamps", () => {
    expect(extractChaptersFromDescription("0:00 Just one", 60)).toEqual([]);
    expect(extractChaptersFromDescription("", 60)).toEqual([]);
  });
});
