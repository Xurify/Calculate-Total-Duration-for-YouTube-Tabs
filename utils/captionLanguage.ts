export interface CaptionTrack {
  kind?: string;
  languageCode?: string;
  name?: { simpleText?: string };
}

export interface LanguageDetectionHints {
  defaultAudioLanguageCode?: string | null;
  defaultLanguage?: string | null;
}

export interface DetectedLanguage {
  language: string | null;
  languageName: string | null;
  /** Only YouTube's speech recognition backs this; it mislabels languages it lacks (Estonian → Finnish). */
  weak?: boolean;
}

interface AudioTrackLabel {
  id?: string;
  displayName?: string;
  audioIsDefault?: boolean;
  isAutoDubbed?: boolean;
}

interface CaptionAudioTrackRef {
  audioTrackId?: string;
  defaultCaptionTrackIndex?: number;
}

interface StreamingFormat {
  audioTrack?: AudioTrackLabel;
}

export interface PlayerResponseForLanguage {
  videoDetails?: {
    videoId?: string;
    author?: string;
    defaultAudioLanguageCode?: string;
    defaultLanguage?: string;
    title?: string;
    shortDescription?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      defaultLanguage?: string;
      defaultAudioLanguage?: string;
    };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: CaptionAudioTrackRef[];
      defaultAudioTrackIndex?: number;
    };
  };
  streamingData?: {
    formats?: StreamingFormat[];
    adaptiveFormats?: StreamingFormat[];
  };
}

/** Bump when detection changes so languages cached by older logic are detected again. */
export const LANGUAGE_DETECTION_VERSION = 5;

const NO_LANGUAGE: DetectedLanguage = { language: null, languageName: null };

const NAMEABLE_LANGUAGE_CODES = [
  "ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "he", "hi", "hr", "hu", "id", "is", "it",
  "ja", "ko", "lt", "lv", "nl", "no", "pl", "pt", "ro", "ru", "sk", "sl", "sr", "sv", "th", "tr", "uk", "vi", "zh",
];

let languageNamePattern: { regex: RegExp; codes: Map<string, string> } | null = null;

function titleLanguagePattern() {
  if (languageNamePattern) return languageNamePattern;
  const english = new Intl.DisplayNames(["en"], { type: "language" });
  const codes = new Map<string, string>();
  for (const code of NAMEABLE_LANGUAGE_CODES) {
    const name = english.of(code);
    if (name && name !== code) codes.set(name.toLowerCase(), code);
  }
  const names = [...codes.keys()].join("|");
  const regex = new RegExp(
    `\\b(?:in|learn|learning|speak|speaking)\\s+(${names})\\b|\\b(${names})\\s+(?:lessons?|vocabulary|phrases|words|for beginners)\\b`,
    "i"
  );
  languageNamePattern = { regex, codes };
  return languageNamePattern;
}

/**
 * The language a learning video's title names, as in "Parts of the City in Slovak". Such shorts
 * often carry no captions and an English title, so text detection alone calls them English.
 */
export function languageNamedInTitle(title: string): string | null {
  const { regex, codes } = titleLanguagePattern();
  const match = regex.exec(title);
  const name = match?.[1] ?? match?.[2];
  return name ? codes.get(name.toLowerCase()) ?? null : null;
}

/** Normalize BCP-47 codes for comparison (`en-US` → `en`). */
export function normalizeLanguageCode(code: string): string {
  return code.trim().toLowerCase().split("-")[0];
}

function trackDisplayName(track: CaptionTrack): string {
  return (track.name?.simpleText || track.languageCode || "").split("(")[0].trim();
}

function audioDisplayName(displayName: string | undefined, fallback: string): string {
  const stripped = (displayName || "").split("(")[0].split(",")[0].trim();
  return stripped || fallback;
}

function trackMatchesCode(track: CaptionTrack, code: string): boolean {
  if (!track.languageCode) return false;
  return normalizeLanguageCode(track.languageCode) === normalizeLanguageCode(code);
}

function toDetected(track: CaptionTrack): DetectedLanguage {
  if (!track.languageCode) return NO_LANGUAGE;
  return {
    language: track.languageCode,
    languageName: trackDisplayName(track) || track.languageCode,
  };
}

function languageCodeFromAudioTrackId(id: string | undefined): string | null {
  const code = id?.split(".")[0]?.trim();
  return code || null;
}

function matchCaption(captionTracks: CaptionTrack[], code: string): CaptionTrack | undefined {
  return (
    captionTracks.find((track) => track.kind === "asr" && trackMatchesCode(track, code)) ||
    captionTracks.find((track) => trackMatchesCode(track, code))
  );
}

function detectedFromCode(
  captionTracks: CaptionTrack[],
  code: string,
  fallbackName?: string
): DetectedLanguage {
  const track = matchCaption(captionTracks, code);
  if (track) return toDetected(track);
  return {
    language: code,
    languageName: audioDisplayName(fallbackName, code),
  };
}

function collectAudioLabels(playerResponse: PlayerResponseForLanguage): AudioTrackLabel[] {
  const formats = [
    ...(playerResponse.streamingData?.formats ?? []),
    ...(playerResponse.streamingData?.adaptiveFormats ?? []),
  ];
  const seen = new Set<string>();
  const labels: AudioTrackLabel[] = [];
  for (const format of formats) {
    const track = format.audioTrack;
    if (!track?.id || seen.has(track.id)) continue;
    seen.add(track.id);
    labels.push(track);
  }
  return labels;
}

/** Uploaded audio, not an auto-dub. Auto-dubs are a separate track (`isAutoDubbed`). */
function pickOriginalAudio(labels: AudioTrackLabel[]): AudioTrackLabel | null {
  const markedDefault = labels.find((track) => track.audioIsDefault);
  if (markedDefault) return markedDefault;
  if (!labels.some((track) => track.isAutoDubbed)) return null;
  const originals = labels.filter((track) => !track.isAutoDubbed);
  return originals.length === 1 ? originals[0] : null;
}

function languageFromOriginalAudio(
  playerResponse: PlayerResponseForLanguage,
  captionTracks: CaptionTrack[]
): DetectedLanguage | null {
  const original = pickOriginalAudio(collectAudioLabels(playerResponse));
  const code = languageCodeFromAudioTrackId(original?.id);
  if (!code) return null;
  return detectedFromCode(captionTracks, code, original?.displayName);
}

function languageFromDefaultAudioTrack(
  playerResponse: PlayerResponseForLanguage,
  captionTracks: CaptionTrack[]
): DetectedLanguage | null {
  const renderer = playerResponse.captions?.playerCaptionsTracklistRenderer;
  const audioTracks = renderer?.audioTracks;
  const index = renderer?.defaultAudioTrackIndex;
  if (!audioTracks || typeof index !== "number") return null;
  const audio = audioTracks[index];
  if (!audio) return null;

  const code = languageCodeFromAudioTrackId(audio.audioTrackId);
  if (code) return detectedFromCode(captionTracks, code);

  const captionIndex = audio.defaultCaptionTrackIndex;
  if (typeof captionIndex === "number") {
    const track = captionTracks[captionIndex];
    // YouTube points this at its own speech-recognition track too, which hears singing in a
    // language it lacks as some other one (a Croatian song as French).
    if (track?.languageCode) return track.kind === "asr" ? { ...toDetected(track), weak: true } : toDetected(track);
  }
  return null;
}

/**
 * Pick the caption track that best reflects the video's spoken language.
 *
 * Priority:
 * 1. ASR track matching YouTube's default audio language
 * 2. Any caption track matching default audio language
 * 3. Sole ASR track
 * 4. First caption track with a language code, when there is not a pile of auto-generated tracks
 *
 * Several ASR tracks and no audio hint means YouTube listed auto-dubs alphabetically.
 * The first of those is not the spoken language, so this returns no language.
 */
export function languageFromCaptionTracks(
  captionTracks: CaptionTrack[] | undefined,
  hints?: LanguageDetectionHints
): DetectedLanguage {
  if (!captionTracks?.length) return NO_LANGUAGE;

  const preferredCode =
    hints?.defaultAudioLanguageCode?.trim() ||
    hints?.defaultLanguage?.trim() ||
    null;

  const asrTracks = captionTracks.filter((track) => track.kind === "asr" && track.languageCode);

  if (preferredCode) {
    const preferredAsr = asrTracks.find((track) => trackMatchesCode(track, preferredCode));
    if (preferredAsr) return toDetected(preferredAsr);

    const preferredAny = captionTracks.find((track) => trackMatchesCode(track, preferredCode));
    if (preferredAny) return toDetected(preferredAny);
  }

  if (asrTracks.length === 1) {
    return { ...toDetected(asrTracks[0]), weak: true };
  }

  if (asrTracks.length > 1) {
    return NO_LANGUAGE;
  }

  const first = captionTracks.find((track) => track.languageCode);
  return first ? { ...toDetected(first), weak: true } : NO_LANGUAGE;
}

export function extractLanguageHintsFromPlayerResponse(
  playerResponse: PlayerResponseForLanguage | null | undefined
): LanguageDetectionHints {
  const micro = playerResponse?.microformat?.playerMicroformatRenderer;
  const details = playerResponse?.videoDetails;
  return {
    defaultAudioLanguageCode:
      details?.defaultAudioLanguageCode ?? micro?.defaultAudioLanguage ?? null,
    defaultLanguage: details?.defaultLanguage ?? micro?.defaultLanguage ?? null,
  };
}

export function detectLanguageFromPlayerResponse(
  playerResponse: PlayerResponseForLanguage | null | undefined
): DetectedLanguage {
  if (!playerResponse) return NO_LANGUAGE;

  const captionTracks =
    playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  const fromOriginalAudio = languageFromOriginalAudio(playerResponse, captionTracks);
  if (fromOriginalAudio) return fromOriginalAudio;

  const fromDefaultAudioTrack = languageFromDefaultAudioTrack(playerResponse, captionTracks);
  if (fromDefaultAudioTrack && !fromDefaultAudioTrack.weak) return fromDefaultAudioTrack;

  const fromCaptionTracks = languageFromCaptionTracks(captionTracks, extractLanguageHintsFromPlayerResponse(playerResponse));
  if (fromCaptionTracks.language && !fromCaptionTracks.weak) return fromCaptionTracks;
  return fromDefaultAudioTrack ?? fromCaptionTracks;
}

export function languageTextFromPlayerResponse(
  playerResponse: PlayerResponseForLanguage | null | undefined
): string {
  const details = playerResponse?.videoDetails;
  return [details?.title, details?.shortDescription].filter(Boolean).join("\n");
}
