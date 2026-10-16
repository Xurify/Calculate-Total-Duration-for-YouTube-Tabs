import { describe, expect, test } from "bun:test";
import { buildSentences, maskSentence, segmentWords, sentenceIndexAt, type TranscriptSegment } from "../utils/transcript";

function cue(startSeconds: number, durationSeconds: number, text: string): TranscriptSegment {
  return { startSeconds, durationSeconds, text };
}

describe("buildSentences", () => {
  test("joins punctuated cues into whole sentences with interpolated times", () => {
    const { sentences, punctuated } = buildSentences([
      cue(0, 2, "Dobrý deň. Ako sa"),
      cue(2, 2, "máte? Ja som"),
      cue(4, 2, "Peter."),
    ]);

    expect(punctuated).toBe(true);
    expect(sentences.map((sentence) => sentence.text)).toEqual(["Dobrý deň.", "Ako sa máte?", "Ja som Peter."]);
    expect(sentences[0].startSeconds).toBe(0);
    expect(sentences[1].startSeconds).toBeGreaterThan(0);
    expect(sentences[1].startSeconds).toBeLessThan(2);
    expect(sentences[2].endSeconds).toBeCloseTo(6, 5);
  });

  test("groups unpunctuated cues into chunks of at least five words", () => {
    const { sentences, punctuated } = buildSentences([
      cue(0, 1, "one two"),
      cue(1, 1, "three four five"),
      cue(2, 1, "six seven"),
    ]);

    expect(punctuated).toBe(false);
    expect(sentences.map((sentence) => sentence.text)).toEqual(["one two three four five", "six seven"]);
    expect(sentences[0]).toMatchObject({ startSeconds: 0, endSeconds: 2 });
  });

  test("drops empty cues and keeps cues in time order", () => {
    const { sentences } = buildSentences([cue(5, 1, "Second one."), cue(0, 1, "First one."), cue(1, 1, "   ")]);
    expect(sentences.map((sentence) => sentence.text)).toEqual(["First one.", "Second one."]);
  });

  test("returns nothing for no cues", () => {
    expect(buildSentences([])).toEqual({ sentences: [], punctuated: false });
  });
});

describe("sentenceIndexAt", () => {
  const sentences = [
    { text: "A", startSeconds: 0, endSeconds: 2 },
    { text: "B", startSeconds: 2, endSeconds: 4 },
    { text: "C", startSeconds: 4, endSeconds: 6 },
  ];

  test("picks the sentence that is playing", () => {
    expect(sentenceIndexAt(sentences, 0)).toBe(0);
    expect(sentenceIndexAt(sentences, 3.5)).toBe(1);
    expect(sentenceIndexAt(sentences, 10)).toBe(2);
  });

  test("keeps the sentence that just ended for a moment after the next one starts", () => {
    expect(sentenceIndexAt(sentences, 2.5)).toBe(0);
    expect(sentenceIndexAt(sentences, 3.2)).toBe(1);
  });

  test("is -1 without sentences", () => {
    expect(sentenceIndexAt([], 1)).toBe(-1);
  });
});

describe("segmentWords and maskSentence", () => {
  test("masks exactly the chosen word", () => {
    const sentence = "Včera som ochutnal bryndzové halušky.";
    const token = segmentWords(sentence, "sk").find((word) => word.text === "ochutnal");
    expect(token).toBeDefined();
    expect(maskSentence(sentence, token!)).toBe("Včera som {{ochutnal}} bryndzové halušky.");
  });
});
