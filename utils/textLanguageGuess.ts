import { normalizeLanguageCode } from "./captionLanguage";

/**
 * A runner-up scoring at least this share of the winner makes the text a close call. eld's own
 * `isReliable()` means to catch these but compares the winner's score with the runner-up's language
 * index, so it never does.
 */
const CLOSE_CALL_RATIO = 0.9;

export interface TextLanguageGuess {
  code: string;
  /** Languages scoring close enough to the winner that the text alone cannot choose. */
  rivals: string[];
}

export interface LanguagePriors {
  /** What YouTube's speech recognition heard, when it heard anything. */
  heard?: string | null;
  /** The language most of the channel's videos turned out to be in. */
  channel?: string | null;
  /** Language codes picked in Settings. */
  followed?: readonly string[];
}

export function guessFromScores(scores: Record<string, number>): TextLanguageGuess | null {
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0 || ranked[0][1] <= 0) return null;
  const [code, top] = ranked[0];
  return { code, rivals: ranked.slice(1).filter(([, score]) => score >= top * CLOSE_CALL_RATIO).map(([rival]) => rival) };
}

/**
 * Weighs the title's language against what speech recognition heard.
 *
 * Titles are often English while the speech is not: creators write for a wider audience, and lessons announce
 * "(English subtitles)". Speech recognition rarely hears English where none is spoken, so a title read as English
 * never overrules a non-English language it heard, the Estonian captions under "Vlog #23 - Miami, Halloween ja
 * Shoppamine" included. A title clearly in another language still wins: recognition files languages it lacks
 * under one it has, as a Croatian song under French.
 *
 * Words shared across languages (vlog, Halloween, place and brand names) score as English because eld learned
 * them mostly from English text, so a near tie goes to what was heard, then to the channel's usual language,
 * then to a followed language over English. `sure` is false unless the text was clear or the speech agrees with it.
 */
export function settleTextGuess(guess: TextLanguageGuess, priors: LanguagePriors): { code: string; sure: boolean } {
  const candidates = [guess.code, ...guess.rivals];
  const heard = priors.heard ? normalizeLanguageCode(priors.heard) : null;
  if (heard && candidates.includes(heard)) return { code: heard, sure: true };
  const followedOverEnglish = guess.code === "en" ? guess.rivals.find((rival) => priors.followed?.includes(rival)) : undefined;
  // Non-English speech under an English-looking title: a followed language in the near tie is likelier than
  // the one heard (Estonian filed under Finnish), otherwise trust the speech.
  if (heard && heard !== "en" && guess.code === "en") return { code: followedOverEnglish ?? heard, sure: false };
  if (guess.rivals.length === 0) return { code: guess.code, sure: true };
  const channel = priors.channel ? normalizeLanguageCode(priors.channel) : null;
  if (channel && candidates.includes(channel)) return { code: channel, sure: false };
  return { code: followedOverEnglish ?? guess.code, sure: false };
}
