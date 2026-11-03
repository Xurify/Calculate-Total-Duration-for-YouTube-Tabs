import { languageCodeOf } from "./languageFlags";

export const LANGUAGE_PALETTE = [
  "var(--section-coral)",
  "var(--section-amber)",
  "var(--section-lime)",
  "var(--section-teal)",
  "var(--section-sky)",
  "var(--section-indigo)",
  "var(--section-violet)",
  "var(--section-rose)",
] as const;

export const NO_LANGUAGE_COLOR = "var(--color-border-hover)";

/**
 * Keyed by language code, so a language keeps its colour on every page however YouTube names it.
 * Languages often studied together sit on different slots; anything else hashes onto the palette.
 */
const FIXED_SLOTS: Record<string, number> = {
  en: 0, sk: 1, et: 2, cs: 3, de: 4, es: 5, fr: 6, it: 7,
  ru: 3, pl: 4, pt: 5, ja: 6, ko: 7, zh: 2, uk: 1, fi: 4, hu: 6, nl: 7, sv: 5,
};

function hashSlot(text: string): number {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % LANGUAGE_PALETTE.length;
}

export function languageColor(label: string | null | undefined): string {
  const text = label?.trim();
  if (!text) return NO_LANGUAGE_COLOR;
  const code = languageCodeOf(text);
  if (code && FIXED_SLOTS[code] != null) return LANGUAGE_PALETTE[FIXED_SLOTS[code]];
  return LANGUAGE_PALETTE[hashSlot(code ?? text.toLowerCase())];
}
