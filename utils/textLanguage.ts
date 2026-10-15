import { normalizeLanguageCode, type DetectedLanguage } from "./captionLanguage";

const NOISE_PATTERN = /https?:\/\/\S+|www\.\S+|@\S+|[#*_|]/g;
const MIN_TEXT_LENGTH = 20;

/** Language of the title and description, via the browser's built-in CLD. Null when unsure. */
export async function detectTextLanguage(text: string): Promise<string | null> {
  const cleaned = text.replace(NOISE_PATTERN, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < MIN_TEXT_LENGTH || !browser.i18n?.detectLanguage) return null;
  try {
    const result = await browser.i18n.detectLanguage(cleaned);
    const top = result.languages[0];
    if (!result.isReliable || !top || top.language === "und") return null;
    return top.language;
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

/** Metadata from the uploader wins; text only replaces a guess from speech recognition. */
export async function refineLanguageWithText(
  detected: DetectedLanguage,
  text: string,
  displayLocale?: string | null
): Promise<DetectedLanguage> {
  if (detected.language && !detected.weak) return detected;
  const code = await detectTextLanguage(text);
  if (!code) return detected;
  if (detected.language && normalizeLanguageCode(detected.language) === normalizeLanguageCode(code)) {
    return { language: detected.language, languageName: detected.languageName };
  }
  return { language: code, languageName: languageDisplayName(code, displayLocale) };
}
