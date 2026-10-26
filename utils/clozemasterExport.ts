import type { ClozeCardInput } from "./clozemasterApi";
import { languageCodeOf } from "./languageFlags";
import type { BankSentence } from "./sentenceBank";
import { maskSentence, pickClozeToken, segmentWords } from "./transcript";

/**
 * Turns saved sentences into Clozemaster cards: a {{word}} to blank, the language pair the
 * collection lives under, and a note pointing back to the moment in the video.
 */

/** Clozemaster names languages by ISO 639-3 in its URLs (/l/slk-eng). */
const ISO_639_3: Record<string, string> = {
  af: "afr", ar: "ara", az: "aze", be: "bel", bg: "bul", bn: "ben", bs: "bos", ca: "cat", cs: "ces", cy: "cym",
  da: "dan", de: "deu", el: "ell", en: "eng", es: "spa", et: "est", eu: "eus", fa: "fas", fi: "fin", fr: "fra",
  ga: "gle", gl: "glg", he: "heb", hi: "hin", hr: "hrv", hu: "hun", hy: "hye", id: "ind", is: "isl", it: "ita",
  ja: "jpn", ka: "kat", kk: "kaz", ko: "kor", lt: "lit", lv: "lav", mk: "mkd", ms: "msa", mt: "mlt", nb: "nob",
  nl: "nld", nn: "nno", no: "nob", pl: "pol", pt: "por", ro: "ron", ru: "rus", sk: "slk", sl: "slv", sq: "sqi",
  sr: "srp", sv: "swe", sw: "swa", th: "tha", tl: "tgl", tr: "tur", uk: "ukr", ur: "urd", uz: "uzb", vi: "vie",
  zh: "cmn",
};

const ISO_639_1 = Object.fromEntries(Object.entries(ISO_639_3).map(([two, three]) => [three, two]));

export const DEFAULT_COLLECTION_NAME = "From YouTube";

export function sentenceLanguageCode(sentence: Pick<BankSentence, "language" | "languageCode">): string | null {
  return languageCodeOf(sentence.languageCode) ?? languageCodeOf(sentence.language);
}

/**
 * The pair the person already studies this language in, when their history shows one;
 * otherwise the language from English, Clozemaster's most common base.
 */
export function clozemasterPairFor(code: string | null, visitedPairs: readonly string[]): string | null {
  const target = code ? ISO_639_3[code] : undefined;
  if (!target) return null;
  return visitedPairs.find((pair) => pair.startsWith(`${target}-`)) ?? `${target}-eng`;
}

/** The base half of a pair as a two-letter code, for a translator. */
export function baseLanguageOf(pair: string): string | null {
  return ISO_639_1[pair.split("-")[1] ?? ""] ?? null;
}

function wordPattern(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
}

/**
 * The word to blank: the one picked on YouTube when it is still in the text, otherwise the
 * one a cloze card would pick, a long word that isn't a name.
 */
export function clozeWordFor(text: string, preferred: string | null, code: string | null): string | null {
  if (preferred && wordPattern(preferred).test(text)) return preferred;
  return pickClozeToken(segmentWords(text, code), new Map())?.text ?? null;
}

export function clozeText(text: string, word: string, code: string | null): string {
  const token = segmentWords(text, code).find((candidate) => candidate.isWord && candidate.text.toLocaleLowerCase() === word.toLocaleLowerCase());
  if (token) return maskSentence(text, token);
  const match = wordPattern(word).exec(text);
  return match ? `${text.slice(0, match.index)}{{${match[0]}}}${text.slice(match.index + match[0].length)}` : text;
}

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Shown after answering in Clozemaster, so the card can lead back to the voice it came from. */
export function clozemasterNotes(sentence: Pick<BankSentence, "videoId" | "videoTitle" | "channelName" | "startSeconds">): string {
  const where = [sentence.videoTitle, sentence.channelName].filter(Boolean).join(" · ");
  const link = `https://youtu.be/${sentence.videoId}?t=${Math.floor(sentence.startSeconds)}`;
  return `${where ? `${where}, ` : ""}${formatClock(sentence.startSeconds)} ${link}`;
}

export function clozemasterCard(
  sentence: Pick<BankSentence, "text" | "videoId" | "videoTitle" | "channelName" | "startSeconds">,
  word: string,
  translation: string,
  code: string | null
): ClozeCardInput {
  return { sentence: clozeText(sentence.text, word, code), translation: translation.trim(), notes: clozemasterNotes(sentence) };
}

export function notInClozemaster(bank: readonly BankSentence[]): BankSentence[] {
  return bank.filter((sentence) => !sentence.clozemasterAt);
}
