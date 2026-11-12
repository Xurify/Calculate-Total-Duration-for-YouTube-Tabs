import { describe, expect, test } from "bun:test";
// The extension loads eld through a Vite alias ("eld/core", typed in utils/eld.d.ts); the test reaches the same files directly.
// @ts-expect-error eld ships no types for its source files.
import { createEld as untypedCreateEld } from "../node_modules/eld/src/languageDetector.js";
// @ts-expect-error eld ships no types for its source files.
import { ngramsData } from "../node_modules/eld/src/ngrams/medium.js";
import { guessFromScores, settleTextGuess, type LanguagePriors } from "../utils/textLanguageGuess";

const createEld = untypedCreateEld as typeof import("eld/core").createEld;
const { instance: eld, loadData } = createEld();
loadData(ngramsData);
eld.enableTextCleanup(true);

function settle(title: string, priors: LanguagePriors = {}): string | null {
  const guess = guessFromScores(eld.detect(title).getScores());
  return guess ? settleTextGuess(guess, priors).code : null;
}

const LEARNER = { followed: ["ru", "sk", "en", "et", "cs"] };

describe("settleTextGuess", () => {
  test("an Estonian title full of words shared across languages goes to Estonian for someone who follows it", () => {
    expect(settle("Vlog - Miami, Halloween ja Shoppamine")).toBe("en");
    expect(settle("Vlog - Miami, Halloween ja Shoppamine", LEARNER)).toBe("et");
  });

  test("speech recognition that heard one of the close languages decides", () => {
    expect(settle("Vlog - Miami, Halloween ja Shoppamine", { ...LEARNER, heard: "en" })).toBe("en");
    expect(settle("Vlog - Miami, Halloween ja Shoppamine", { heard: "et-EE" })).toBe("et");
  });

  test("a heard language outside the close call is ignored, as Finnish for Estonian speech is", () => {
    expect(settle("Vlog - Miami, Halloween ja Shoppamine", { ...LEARNER, heard: "fi" })).toBe("et");
  });

  test("the channel's usual language decides before followed languages", () => {
    expect(settle("Vlog - Miami, Halloween ja Shoppamine", { ...LEARNER, channel: "en" })).toBe("en");
  });

  test("clear English titles stay English", () => {
    for (const title of [
      "Livestream with Steve Start 2021 off strong",
      "How To Reprogram Your Mind & Build Your Life",
      "Russia Used To Be Different",
      "Speak More Articulately Than 99% of People",
      "Learn These 1,000 Sentences to Speak ANY Language",
      "Day in my life in Tallinn",
    ]) {
      expect(settle(title, LEARNER)).toBe("en");
    }
  });

  test("clear titles in followed languages keep their language", () => {
    expect(settle("Vlog: Shopping ja kohvik Tartus", LEARNER)).toBe("et");
    expect(settle("Vlog z Bratislavy - shopping a kaviareň", LEARNER)).toBe("sk");
    expect(settle("Влог из Москвы: шоппинг и кафе", LEARNER)).toBe("ru");
  });

  test("a clear result is sure, a settled close call is not", () => {
    const clear = guessFromScores(eld.detect("How To Reprogram Your Mind & Build Your Life").getScores())!;
    expect(settleTextGuess(clear, LEARNER).sure).toBe(true);
    const close = guessFromScores(eld.detect("Vlog - Miami, Halloween ja Shoppamine").getScores())!;
    expect(close.rivals).toContain("et");
    expect(settleTextGuess(close, LEARNER).sure).toBe(false);
  });
});
