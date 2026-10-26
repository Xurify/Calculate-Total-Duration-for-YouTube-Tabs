import { describe, expect, test } from "bun:test";
import { addToBank, dueSentences, isLearned, nextDueAt, reviewSentence, splitAtWord, type NewBankSentence } from "../utils/sentenceBank";
import { at } from "./fixtures";

const input = (overrides: Partial<NewBankSentence> = {}): NewBankSentence => ({
  text: "Dnes ideme spolu do Bratislavy.",
  clozeWord: null,
  translation: "",
  language: "Slovak",
  videoId: "abc123def45",
  videoTitle: "Výlet",
  channelName: "Lucia",
  startSeconds: 4,
  endSeconds: 8,
  source: "listening",
  ...overrides,
});

describe("addToBank", () => {
  test("adds a new sentence due now", () => {
    const { bank, added } = addToBank([], input(), at(25, 9));
    expect(added).toBe(true);
    expect(dueSentences(bank, at(25, 9))).toHaveLength(1);
  });

  test("the same moment saved twice is merged, keeping the cloze word", () => {
    const first = addToBank([], input(), at(25, 9)).bank;
    const { bank, added } = addToBank(first, input({ startSeconds: 4.4, clozeWord: "spolu", source: "cloze" }), at(25, 10));
    expect(added).toBe(false);
    expect(bank).toHaveLength(1);
    expect(bank[0].clozeWord).toBe("spolu");
    expect(bank[0].source).toBe("cloze");
  });
});

describe("reviewSentence", () => {
  test("got it moves to the next step and away until tomorrow", () => {
    const { bank, sentence } = addToBank([], input(), at(25, 9));
    const reviewed = reviewSentence(bank, sentence.id, "good", at(25, 9));
    expect(reviewed[0].step).toBe(1);
    expect(reviewed[0].dueAt).toBe(new Date(2026, 9, 26).getTime());
    expect(dueSentences(reviewed, at(25, 20))).toHaveLength(0);
    expect(nextDueAt(reviewed, at(25, 20))).toBe(new Date(2026, 9, 26).getTime());
  });

  test("again starts over", () => {
    const { bank, sentence } = addToBank([], input(), at(25, 9));
    let reviewed = reviewSentence(bank, sentence.id, "good", at(25, 9));
    reviewed = reviewSentence(reviewed, sentence.id, "again", at(26, 9));
    expect(reviewed[0].step).toBe(0);
    expect(reviewed[0].reviews).toBe(2);
  });

  test("five good reviews in a row and the sentence is learned", () => {
    let { bank, sentence } = addToBank([], input(), at(1, 9));
    for (let review = 0; review < 5; review++) bank = reviewSentence(bank, sentence.id, "good", at(1, 9));
    expect(isLearned(bank[0])).toBe(true);
    expect(dueSentences(bank, at(30, 9))).toHaveLength(0);
  });
});

describe("splitAtWord", () => {
  test("finds the word whatever its case", () => {
    expect(splitAtWord("Dnes ideme Spolu.", "spolu")).toEqual({ before: "Dnes ideme ", word: "Spolu", after: "." });
    expect(splitAtWord("Dnes.", null)).toBeNull();
  });
});
