/**
 * Turns caption cues into whole sentences and picks cloze words.
 * Cues break wherever the caption line wraps, so one sentence often spans several cues
 * and one cue often ends one sentence and starts the next.
 */

export interface TranscriptSegment {
  startSeconds: number;
  durationSeconds: number;
  text: string;
}

export interface TranscriptSentence {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface SentenceTranscript {
  sentences: TranscriptSentence[];
  /** False for auto-generated captions without punctuation: sentence edges are then a guess. */
  punctuated: boolean;
}

export interface WordToken {
  text: string;
  index: number;
  isWord: boolean;
}

const SENTENCE_END = /[.!?…。！？]/;
const UNSPACED_SENTENCE_END = /[。！？]/;
const CLOSING_MARKS = /["'“”’»)\]]/;
const CLAUSE_BREAK = /[,;:–—、，]/;
const MAX_SENTENCE_WORDS = 28;
const MIN_CLAUSE_WORDS = 6;

function cleanCaptionText(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/♪+/g, " ")
    .replace(/(^|\s)(>>|-)\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function segmentWords(text: string, languageCode?: string | null): WordToken[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(languageCode || undefined, { granularity: "word" });
    return [...segmenter.segment(text)].map((part) => ({
      text: part.segment,
      index: part.index,
      isWord: Boolean(part.isWordLike),
    }));
  }
  const tokens: WordToken[] = [];
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}'’-]+/gu)) {
    tokens.push({ text: match[0], index: match.index ?? 0, isWord: true });
  }
  return tokens;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Splits a run-on sentence at commas so cards stay short enough to read at a glance. */
function splitLongSentence(text: string, start: number, end: number): Array<{ start: number; end: number }> {
  if (countWords(text.slice(start, end)) <= MAX_SENTENCE_WORDS) return [{ start, end }];

  const pieces: Array<{ start: number; end: number }> = [];
  let pieceStart = start;
  for (let position = start; position < end; position++) {
    if (!CLAUSE_BREAK.test(text[position]) || text[position + 1] !== " ") continue;
    const before = countWords(text.slice(pieceStart, position + 1));
    const after = countWords(text.slice(position + 1, end));
    if (before >= MIN_CLAUSE_WORDS && after >= MIN_CLAUSE_WORDS && before >= MAX_SENTENCE_WORDS / 2) {
      pieces.push({ start: pieceStart, end: position + 1 });
      pieceStart = position + 2;
    }
  }
  pieces.push({ start: pieceStart, end });
  return pieces;
}

function findSentenceRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let sentenceStart = 0;

  for (let position = 0; position < text.length; position++) {
    if (!SENTENCE_END.test(text[position])) continue;

    let boundary = position + 1;
    while (boundary < text.length && (SENTENCE_END.test(text[boundary]) || CLOSING_MARKS.test(text[boundary]))) {
      boundary++;
    }
    position = boundary - 1;

    if (!UNSPACED_SENTENCE_END.test(text[boundary - 1]) && boundary < text.length) {
      if (text[boundary] !== " ") continue;
      // "napr. tak" or "... and then": a lowercase word after the stop means the sentence goes on.
      const nextCharacter = text[boundary + 1] ?? "";
      if (/\p{Ll}/u.test(nextCharacter)) continue;
    }

    ranges.push(...splitLongSentence(text, sentenceStart, boundary));
    sentenceStart = boundary;
  }

  if (sentenceStart < text.length) ranges.push(...splitLongSentence(text, sentenceStart, text.length));
  return ranges;
}

export function buildSentences(segments: TranscriptSegment[]): SentenceTranscript {
  const cues = segments
    .map((segment) => ({ ...segment, text: cleanCaptionText(segment.text) }))
    .filter((segment) => segment.text)
    .sort((first, second) => first.startSeconds - second.startSeconds);

  let fullText = "";
  const pieces: Array<{ offset: number; length: number; start: number; end: number }> = [];
  cues.forEach((cue, index) => {
    const next = cues[index + 1];
    const end =
      cue.durationSeconds > 0
        ? cue.startSeconds + cue.durationSeconds
        : next
          ? next.startSeconds
          : cue.startSeconds + 3;
    if (fullText) fullText += " ";
    pieces.push({ offset: fullText.length, length: cue.text.length, start: cue.startSeconds, end });
    fullText += cue.text;
  });

  if (pieces.length === 0) return { sentences: [], punctuated: false };

  const stopCount = (fullText.match(/[.!?…。！？]/g) ?? []).length;
  const punctuated = stopCount >= Math.max(1, countWords(fullText) / 60);

  if (!punctuated) {
    const sentences: TranscriptSentence[] = [];
    let pending: TranscriptSentence | null = null;
    for (const [index, cue] of cues.entries()) {
      const piece = pieces[index];
      pending = pending
        ? { text: `${pending.text} ${cue.text}`, startSeconds: pending.startSeconds, endSeconds: piece.end }
        : { text: cue.text, startSeconds: piece.start, endSeconds: piece.end };
      if (countWords(pending.text) >= 5) {
        sentences.push(pending);
        pending = null;
      }
    }
    if (pending) sentences.push(pending);
    return { sentences, punctuated };
  }

  // Cue timestamps only mark where a cue starts, so a sentence that starts mid-cue gets a
  // time interpolated by its character position within that cue.
  const timeAtOffset = (offset: number): number => {
    let pieceIndex = pieces.length - 1;
    while (pieceIndex > 0 && pieces[pieceIndex].offset > offset) pieceIndex--;
    const piece = pieces[pieceIndex];
    const progress = Math.min(1, Math.max(0, (offset - piece.offset) / Math.max(1, piece.length)));
    return piece.start + progress * (piece.end - piece.start);
  };

  const sentences: TranscriptSentence[] = [];
  for (const range of findSentenceRanges(fullText)) {
    const raw = fullText.slice(range.start, range.end);
    const leading = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    const startOffset = range.start + leading;
    sentences.push({
      text,
      startSeconds: timeAtOffset(startOffset),
      endSeconds: timeAtOffset(startOffset + text.length),
    });
  }
  return { sentences, punctuated };
}

/**
 * The sentence the user most likely meant: the one playing, or the one that just ended
 * when they reacted within the first moment of the next.
 */
export function sentenceIndexAt(sentences: TranscriptSentence[], currentSeconds: number): number {
  if (sentences.length === 0) return -1;
  let index = 0;
  while (index + 1 < sentences.length && sentences[index + 1].startSeconds <= currentSeconds) index++;
  if (index > 0 && currentSeconds - sentences[index].startSeconds < 1.2) index--;
  return index;
}

export function countWordFrequencies(sentences: TranscriptSentence[], languageCode?: string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sentence of sentences) {
    for (const token of segmentWords(sentence.text, languageCode)) {
      if (!token.isWord) continue;
      const key = token.text.toLocaleLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Favors long words that are rare in this video: short frequent words are grammar the
 * learner already sees everywhere. Capitalised words mid-sentence are usually names.
 */
export function pickClozeToken(
  tokens: WordToken[],
  frequencies: Map<string, number>
): WordToken | null {
  let best: WordToken | null = null;
  let bestScore = -1;
  let isFirstWord = true;

  for (const token of tokens) {
    if (!token.isWord) continue;
    const firstWord = isFirstWord;
    isFirstWord = false;
    if (!/\p{L}/u.test(token.text)) continue;

    const length = [...token.text].length;
    let score = Math.min(length, 12) / Math.sqrt(frequencies.get(token.text.toLocaleLowerCase()) ?? 1);
    if (length < 3 && /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(token.text)) score *= 0.2;
    if (!firstWord && /^\p{Lu}/u.test(token.text)) score *= 0.4;

    if (score > bestScore) {
      best = token;
      bestScore = score;
    }
  }
  return best;
}

export function maskSentence(sentence: string, token: WordToken): string {
  return `${sentence.slice(0, token.index)}{{${token.text}}}${sentence.slice(token.index + token.text.length)}`;
}
