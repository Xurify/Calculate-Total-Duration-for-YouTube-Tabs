import { createEld } from "eld/core";
import type { PublicPath } from "wxt/browser";
import { languageNamedInTitle, normalizeLanguageCode, type DetectedLanguage } from "./captionLanguage";
import { guessFromScores, settleTextGuess, type LanguagePriors, type TextLanguageGuess } from "./textLanguageGuess";

const NOISE_PATTERN = /https?:\/\/\S+|www\.\S+|@\S+|#\S+|[*_|]/g;
const MIN_TEXT_LENGTH = 20;

let detector: Promise<ReturnType<typeof createEld>["instance"]> | null = null;

/** Background only: the model takes ~35 MB. */
function loadDetector() {
  detector ??= fetch(browser.runtime.getURL("/eld/medium.json" as PublicPath))
    .then((response) => response.json())
    .then((data) => {
      const { instance, loadData } = createEld();
      if (!loadData(data)) throw new Error("eld: no language data");
      instance.enableTextCleanup(true);
      return instance;
    })
    .catch((error) => {
      detector = null;
      throw error;
    });
  return detector;
}

function cleanText(text: string): string {
  return text.replace(NOISE_PATTERN, " ").replace(/\s+/g, " ").trim();
}

/**
 * Language of a title (first line) and description. The title wins when it is clear on its own:
 * descriptions often end in English sponsor and link boilerplate. Null when it cannot tell; a close call
 * comes back with its rivals.
 */
export async function detectTextLanguage(text: string): Promise<TextLanguageGuess | null> {
  const title = cleanText(text.split("\n", 1)[0]);
  const whole = cleanText(text);
  if (whole.length < MIN_TEXT_LENGTH) return null;
  try {
    const eld = await loadDetector();
    let closeCall: TextLanguageGuess | null = null;
    for (const candidate of title.length >= MIN_TEXT_LENGTH && title !== whole ? [title, whole] : [whole]) {
      const result = eld.detect(candidate);
      if (!result.language || !result.isReliable()) continue;
      const guess = guessFromScores(result.getScores());
      if (guess && guess.rivals.length === 0) return guess;
      closeCall ??= guess;
    }
    return closeCall;
  } catch {
    return null;
  }
}

/**
 * The page's `lang` is the viewer's YouTube interface language, so names match
 * the ones YouTube gives caption tracks and "By language" groups stay merged.
 */
export function languageDisplayName(code: string, displayLocale?: string | null): string {
  try {
    const locale = displayLocale || browser.i18n?.getUILanguage?.() || "en";
    return new Intl.DisplayNames([locale], { type: "language" }).of(code) || code;
  } catch {
    return code;
  }
}

/**
 * A title that names the language being taught wins, since lessons are often uploaded with English
 * metadata. Otherwise metadata from the uploader wins; text only replaces a guess from speech recognition.
 */
export async function refineLanguageWithText(
  detected: DetectedLanguage,
  text: string,
  displayLocale?: string | null,
  priors: Omit<LanguagePriors, "heard"> = {}
): Promise<DetectedLanguage> {
  const named = languageNamedInTitle(text.split("\n", 1)[0]);
  if (named) {
    if (detected.language && normalizeLanguageCode(detected.language) === named) {
      return { language: detected.language, languageName: detected.languageName };
    }
    return { language: named, languageName: languageDisplayName(named, displayLocale) };
  }
  if (detected.language && !detected.weak) return detected;
  const guess = await detectTextLanguage(text);
  if (!guess) return detected;
  const { code, sure } = settleTextGuess(guess, { ...priors, heard: detected.language });
  const weak = sure ? {} : { weak: true };
  if (detected.language && normalizeLanguageCode(detected.language) === normalizeLanguageCode(code)) {
    return { language: detected.language, languageName: detected.languageName, ...weak };
  }
  return { language: code, languageName: languageDisplayName(code, displayLocale), ...weak };
}
