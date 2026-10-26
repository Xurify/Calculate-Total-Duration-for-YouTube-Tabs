import type { PublicPath } from "wxt/browser";

/**
 * Flags for language labels. A language has no flag of its own, so each maps to the country most
 * learners picture; English shows the UK flag unless the code names a region (en-US → US).
 */

const LANGUAGE_COUNTRIES: Record<string, string> = {
  af: "za", am: "et", ar: "sa", az: "az", be: "by", bg: "bg", bn: "bd", bs: "ba", ca: "es-ct", cs: "cz",
  cy: "gb-wls", da: "dk", de: "de", el: "gr", en: "gb", es: "es", et: "ee", eu: "es-pv", fa: "ir", fi: "fi",
  fil: "ph", fr: "fr", ga: "ie", gl: "es-ga", he: "il", hi: "in", hr: "hr", hu: "hu", hy: "am", id: "id",
  is: "is", it: "it", ja: "jp", ka: "ge", kk: "kz", km: "kh", ko: "kr", lo: "la", lt: "lt", lv: "lv",
  mk: "mk", mn: "mn", ms: "my", mt: "mt", my: "mm", nb: "no", ne: "np", nl: "nl", nn: "no", no: "no",
  pl: "pl", pt: "pt", ro: "ro", ru: "ru", si: "lk", sk: "sk", sl: "si", sq: "al", sr: "rs", sv: "se",
  sw: "tz", th: "th", tl: "ph", tr: "tr", uk: "ua", ur: "pk", uz: "uz", vi: "vn", zh: "cn",
};

/** Regions a code can name (pt-BR, zh-TW) whose flag differs from the language's usual one. */
const REGION_FLAGS = ["ar", "at", "au", "be", "br", "ca", "ch", "hk", "ie", "in", "mx", "nz", "tw", "us"];

export const FLAG_FILES: readonly string[] = [...new Set([...Object.values(LANGUAGE_COUNTRIES), ...REGION_FLAGS])].sort();

const shipped = new Set(FLAG_FILES);
let namedCodes: Map<string, string> | null = null;

function codesByName(): Map<string, string> {
  if (namedCodes) return namedCodes;
  namedCodes = new Map();
  const locales = [...new Set(["en", typeof navigator === "undefined" ? "en" : navigator.language])];
  for (const locale of locales) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      continue;
    }
    for (const code of Object.keys(LANGUAGE_COUNTRIES)) {
      const name = names.of(code);
      if (name && name !== code && !namedCodes.has(name.toLowerCase())) namedCodes.set(name.toLowerCase(), code);
    }
  }
  return namedCodes;
}

/** The two-letter code for a label or tag, such as "Slovak" or "sk-SK"; null when unknown. */
export function languageCodeOf(language: string | null | undefined): string | null {
  const text = language?.trim();
  if (!text) return null;
  const tag = /^([a-z]{2,3})(?:[-_][a-z0-9]+)*$/i.exec(text);
  if (tag && LANGUAGE_COUNTRIES[tag[1].toLowerCase()]) return tag[1].toLowerCase();
  return codesByName().get(text.split("(")[0].trim().toLowerCase()) ?? null;
}

export function languageFlagId(language: string | null | undefined): string | null {
  const text = language?.trim();
  if (!text) return null;
  const tag = /^([a-z]{2,3})(?:[-_]([a-z]{2}))?$/i.exec(text);
  if (tag) {
    const region = tag[2]?.toLowerCase();
    if (region && shipped.has(region)) return region;
    const country = LANGUAGE_COUNTRIES[tag[1].toLowerCase()];
    if (country) return country;
  }
  const code = codesByName().get(text.split("(")[0].trim().toLowerCase());
  return code ? LANGUAGE_COUNTRIES[code] : null;
}

export function languageFlagHtml(language: string | null | undefined, className = "lang-flag"): string {
  const id = languageFlagId(language);
  if (!id) return "";
  const url = browser.runtime.getURL(`/flags/${id}.svg` as PublicPath);
  return `<img src="${url}" alt="" width="16" height="12" class="${className}" draggable="false">`;
}
