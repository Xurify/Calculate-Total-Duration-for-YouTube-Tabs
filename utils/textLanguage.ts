import { createEld } from "eld/core";
import type { PublicPath } from "wxt/browser";
import { normalizeLanguageCode, type DetectedLanguage } from "./captionLanguage";

const NOISE_PATTERN = /https?:\/\/\S+|www\.\S+|@\S+|#\S+|[*_|]/g;
const MIN_TEXT_LENGTH = 20;

let detector: Promise<ReturnType<typeof createEld>["instance"]> | null = null;

/**
 * ELD (github.com/nitotm/efficient-language-detector-js) instead of the browser's CLD: on short
 * Tatoeba sentences it was right 98% of the time against CLD3's 88%, and it keeps Slovak from Czech
 * and Estonian from Finnish, the pairs CLD mixes up most. Background only: the model takes ~35 MB.
 */
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
 * descriptions often end in English sponsor and link boilerplate. Null when unsure.
 */
export async function detectTextLanguage(text: string): Promise<string | null> {
  const title = cleanText(text.split("\n", 1)[0]);
  const whole = cleanText(text);
  if (whole.length < MIN_TEXT_LENGTH) return null;
  try {
    const eld = await loadDetector();
    for (const candidate of title.length >= MIN_TEXT_LENGTH && title !== whole ? [title, whole] : [whole]) {
      const result = eld.detect(candidate);
      if (result.language && result.isReliable()) return result.language;
    }
    return null;
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
