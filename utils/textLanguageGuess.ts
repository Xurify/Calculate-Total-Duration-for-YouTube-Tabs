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
 * Settles a close call. Words shared across languages (vlog, Halloween, place and brand names) score as English
 * because eld learned them mostly from English text, so "Vlog #23 - Miami, Halloween ja Shoppamine" comes out
 * English 0.63, Estonian 0.58. English edging ahead on such a title says little,
 * so a near tie goes to what speech recognition heard, then to the channel's usual language, then to a followed
 * language over English. `sure` is false unless the text was clear or the speech agrees with it.
 */
export function settleTextGuess(guess: TextLanguageGuess, priors: LanguagePriors): { code: string; sure: boolean } {
  if (guess.rivals.length === 0) return { code: guess.code, sure: true };
  const candidates = [guess.code, ...guess.rivals];
  const heard = priors.heard ? normalizeLanguageCode(priors.heard) : null;
  if (heard && candidates.includes(heard)) return { code: heard, sure: true };
  const channel = priors.channel ? normalizeLanguageCode(priors.channel) : null;
  if (channel && candidates.includes(channel)) return { code: channel, sure: false };
  if (guess.code === "en") {
    const followed = guess.rivals.find((rival) => priors.followed?.includes(rival));
    if (followed) return { code: followed, sure: false };
  }
  return { code: guess.code, sure: false };
}
