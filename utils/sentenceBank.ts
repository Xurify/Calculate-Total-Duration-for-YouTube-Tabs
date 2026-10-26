import { newTypeId } from "./typeId";

/**
 * Sentences kept with the moment they were spoken, so a review plays the speaker's own voice rather than a
 * text-to-speech voice. They come from cloze cards and from listen-first checks that were missed.
 */

export type BankSource = "cloze" | "listening";
export type ReviewGrade = "again" | "good";

export interface BankSentence {
  id: string;
  text: string;
  /** The word blanked on a cloze card, shown highlighted. */
  clozeWord: string | null;
  translation: string;
  language: string;
  /** The caption track's code, such as "sk"; older saves only have the label. */
  languageCode?: string | null;
  videoId: string;
  videoTitle: string;
  channelName: string;
  startSeconds: number;
  endSeconds: number;
  source: BankSource;
  createdAt: number;
  /** Index into REVIEW_STEPS_DAYS; past the end means learned. */
  step: number;
  dueAt: number;
  reviews: number;
  lastReviewedAt: number | null;
  /** When it was added to a Clozemaster collection, and which one. */
  clozemasterAt?: number | null;
  clozemasterCollection?: string | null;
}

export type NewBankSentence = Pick<
  BankSentence,
  "text" | "clozeWord" | "translation" | "language" | "videoId" | "videoTitle" | "channelName" | "startSeconds" | "endSeconds" | "source"
> & { languageCode?: string | null };

export const SENTENCE_BANK_KEY = "sentenceBank";
/** Days until the next review after each "Got it"; the gaps roughly double, as in most spaced-repetition schedules. */
export const REVIEW_STEPS_DAYS = [1, 3, 7, 16, 35] as const;
export const MAX_BANK_SENTENCES = 2000;
/** Two saves this close in the same video are the same sentence. */
const SAME_SENTENCE_SECONDS = 1;
const DAY_MS = 86_400_000;

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Reviews come due at the start of a day, so a whole day's pile is ready in the morning. */
function dueAfterDays(days: number, now: number): number {
  const date = new Date(startOfDay(now));
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function isLearned(sentence: Pick<BankSentence, "step">): boolean {
  return sentence.step >= REVIEW_STEPS_DAYS.length;
}

export function addToBank(bank: readonly BankSentence[], input: NewBankSentence, now: number = Date.now()): { bank: BankSentence[]; sentence: BankSentence; added: boolean } {
  const existing = bank.find(
    (sentence) => sentence.videoId === input.videoId && Math.abs(sentence.startSeconds - input.startSeconds) < SAME_SENTENCE_SECONDS
  );
  if (existing) {
    const merged: BankSentence = {
      ...existing,
      text: input.text.length > existing.text.length ? input.text : existing.text,
      clozeWord: input.clozeWord ?? existing.clozeWord,
      translation: input.translation || existing.translation,
      languageCode: input.languageCode || existing.languageCode,
      endSeconds: Math.max(existing.endSeconds, input.endSeconds),
      source: existing.source === "cloze" || input.source === "cloze" ? "cloze" : "listening",
      // Saving a sentence again says it is still a problem.
      step: 0,
      dueAt: Math.min(existing.dueAt, now),
    };
    return { bank: bank.map((sentence) => (sentence.id === existing.id ? merged : sentence)), sentence: merged, added: false };
  }
  const sentence: BankSentence = {
    ...input,
    id: newTypeId("sent", now),
    createdAt: now,
    step: 0,
    dueAt: now,
    reviews: 0,
    lastReviewedAt: null,
  };
  const next = [...bank, sentence];
  return { bank: next.length > MAX_BANK_SENTENCES ? next.slice(next.length - MAX_BANK_SENTENCES) : next, sentence, added: true };
}

export function reviewSentence(bank: readonly BankSentence[], id: string, grade: ReviewGrade, now: number = Date.now()): BankSentence[] {
  return bank.map((sentence) => {
    if (sentence.id !== id) return sentence;
    const step = grade === "good" ? sentence.step + 1 : 0;
    const dueAt = grade === "good" ? dueAfterDays(REVIEW_STEPS_DAYS[Math.min(sentence.step, REVIEW_STEPS_DAYS.length - 1)], now) : dueAfterDays(1, now);
    return { ...sentence, step, dueAt, reviews: sentence.reviews + 1, lastReviewedAt: now };
  });
}

export interface SentenceEdit {
  id: string;
  clozeWord?: string;
  translation?: string;
}

export function editSentences(bank: readonly BankSentence[], edits: readonly SentenceEdit[]): BankSentence[] {
  const byId = new Map(edits.map((edit) => [edit.id, edit]));
  return bank.map((sentence) => {
    const edit = byId.get(sentence.id);
    if (!edit) return sentence;
    return {
      ...sentence,
      clozeWord: edit.clozeWord?.trim() || sentence.clozeWord,
      translation: edit.translation !== undefined ? edit.translation.trim() : sentence.translation,
    };
  });
}

export function markInClozemaster(bank: readonly BankSentence[], ids: readonly string[], collection: string, now: number = Date.now()): BankSentence[] {
  const sent = new Set(ids);
  return bank.map((sentence) => (sent.has(sentence.id) ? { ...sentence, clozemasterAt: now, clozemasterCollection: collection } : sentence));
}

export function dueSentences(bank: readonly BankSentence[], now: number = Date.now()): BankSentence[] {
  return bank.filter((sentence) => !isLearned(sentence) && sentence.dueAt <= now).sort((first, second) => first.dueAt - second.dueAt || first.createdAt - second.createdAt);
}

export function nextDueAt(bank: readonly BankSentence[], now: number = Date.now()): number | null {
  const later = bank.filter((sentence) => !isLearned(sentence) && sentence.dueAt > now).map((sentence) => sentence.dueAt);
  return later.length > 0 ? Math.min(...later) : null;
}

export function daysUntil(timestamp: number, now: number = Date.now()): number {
  return Math.round((startOfDay(timestamp) - startOfDay(now)) / DAY_MS);
}

/** Splits text around the cloze word, so the page can mark it without building HTML from user text. */
export function splitAtWord(text: string, word: string | null): { before: string; word: string; after: string } | null {
  if (!word) return null;
  const index = text.toLocaleLowerCase().indexOf(word.toLocaleLowerCase());
  if (index === -1) return null;
  return { before: text.slice(0, index), word: text.slice(index, index + word.length), after: text.slice(index + word.length) };
}

export function cleanBank(raw: unknown): BankSentence[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is BankSentence =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof item.id === "string" &&
      typeof item.text === "string" &&
      typeof item.videoId === "string" &&
      typeof item.startSeconds === "number" &&
      typeof item.endSeconds === "number"
  );
}

export async function loadSentenceBank(): Promise<BankSentence[]> {
  if (!browser.storage?.local) return [];
  const data = await browser.storage.local.get(SENTENCE_BANK_KEY);
  return cleanBank(data[SENTENCE_BANK_KEY]);
}

export async function saveSentenceBank(bank: readonly BankSentence[]): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [SENTENCE_BANK_KEY]: bank });
}
