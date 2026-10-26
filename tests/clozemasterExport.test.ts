import { describe, expect, test } from "bun:test";
import {
  baseLanguageOf,
  clozemasterCard,
  clozemasterPairFor,
  clozeText,
  clozeWordFor,
  notInClozemaster,
  sentenceLanguageCode,
} from "../utils/clozemasterExport";
import { addToBank, editSentences, markInClozemaster, type NewBankSentence } from "../utils/sentenceBank";
import { at } from "./fixtures";

const input = (overrides: Partial<NewBankSentence> = {}): NewBankSentence => ({
  text: "Najprv sa pozrieme na hrad.",
  clozeWord: null,
  translation: "",
  language: "Slovak",
  videoId: "abc123def45",
  videoTitle: "Výlet do Bratislavy",
  channelName: "Lucia",
  startSeconds: 74.6,
  endSeconds: 78,
  source: "listening",
  ...overrides,
});

describe("language pairs", () => {
  test("a label or a caption code gives the same language", () => {
    expect(sentenceLanguageCode({ language: "Slovak", languageCode: null })).toBe("sk");
    expect(sentenceLanguageCode({ language: "Whatever", languageCode: "et" })).toBe("et");
    expect(sentenceLanguageCode({ language: "Klingon", languageCode: null })).toBeNull();
  });

  test("prefers the pair the person already studies in", () => {
    expect(clozemasterPairFor("sk", ["est-eng", "slk-deu"])).toBe("slk-deu");
    expect(clozemasterPairFor("sk", [])).toBe("slk-eng");
    expect(clozemasterPairFor(null, ["slk-eng"])).toBeNull();
  });

  test("the base language comes back as a two-letter code", () => {
    expect(baseLanguageOf("slk-eng")).toBe("en");
    expect(baseLanguageOf("est-deu")).toBe("de");
    expect(baseLanguageOf("est-xyz")).toBeNull();
  });
});

describe("cloze words", () => {
  test("keeps the word picked on YouTube", () => {
    expect(clozeWordFor("Najprv sa pozrieme na hrad.", "hrad", "sk")).toBe("hrad");
  });

  test("picks a long word when none was picked, or the picked one is gone", () => {
    expect(clozeWordFor("Najprv sa pozrieme na hrad.", null, "sk")).toBe("pozrieme");
    expect(clozeWordFor("Najprv sa pozrieme na hrad.", "kávu", "sk")).toBe("pozrieme");
  });

  test("blanks a whole word only, not part of a longer one", () => {
    expect(clozeText("Na hrade je hrad.", "hrad", "sk")).toBe("Na hrade je {{hrad}}.");
  });
});

describe("cards", () => {
  test("carry the blank, the translation and a link back to the moment", () => {
    const card = clozemasterCard(input(), "pozrieme", "  First we'll look at the castle. ", "sk");
    expect(card.sentence).toBe("Najprv sa {{pozrieme}} na hrad.");
    expect(card.translation).toBe("First we'll look at the castle.");
    expect(card.notes).toBe("Výlet do Bratislavy · Lucia, 1:14 https://youtu.be/abc123def45?t=74");
  });

  test("sent sentences drop out of the waiting list, edits are kept", () => {
    const { bank } = addToBank([], input(), at(25, 9));
    const id = bank[0].id;
    const edited = editSentences(bank, [{ id, clozeWord: "hrad", translation: "First we'll look at the castle." }]);
    expect(edited[0].clozeWord).toBe("hrad");
    expect(notInClozemaster(edited)).toHaveLength(1);
    const sent = markInClozemaster(edited, [id], "From YouTube", at(25, 10));
    expect(sent[0].clozemasterCollection).toBe("From YouTube");
    expect(notInClozemaster(sent)).toHaveLength(0);
  });
});
