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
}

const NO_LANGUAGE: DetectedLanguage = { language: null, languageName: null };

/** Normalize BCP-47 codes for comparison (`en-US` → `en`). */
export function normalizeLanguageCode(code: string): string {
  return code.trim().toLowerCase().split("-")[0];
}

function trackDisplayName(track: CaptionTrack): string {
  return (track.name?.simpleText || track.languageCode || "").split("(")[0].trim();
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

/**
 * Pick the caption track that best reflects the video's spoken language.
 *
 * Priority:
 * 1. ASR track matching YouTube's default audio language (spoken language)
 * 2. Any caption track matching default audio language
 * 3. Sole ASR track (unambiguous auto-generated captions)
 * 4. First ASR track
 * 5. First caption track with a language code
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
    return toDetected(asrTracks[0]);
  }

  if (asrTracks.length > 1) {
    return toDetected(asrTracks[0]);
  }

  const first = captionTracks.find((track) => track.languageCode);
  return first ? toDetected(first) : NO_LANGUAGE;
}

export function extractLanguageHintsFromPlayerResponse(playerResponse: {
  videoDetails?: {
    defaultAudioLanguageCode?: string;
    defaultLanguage?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      defaultLanguage?: string;
      defaultAudioLanguage?: string;
    };
  };
} | null | undefined): LanguageDetectionHints {
  const micro = playerResponse?.microformat?.playerMicroformatRenderer;
  const details = playerResponse?.videoDetails;
  return {
    defaultAudioLanguageCode:
      details?.defaultAudioLanguageCode ?? micro?.defaultAudioLanguage ?? null,
    defaultLanguage: details?.defaultLanguage ?? micro?.defaultLanguage ?? null,
  };
}

export function detectLanguageFromPlayerResponse(playerResponse: {
  videoDetails?: {
    defaultAudioLanguageCode?: string;
    defaultLanguage?: string;
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
    };
  };
} | null | undefined): DetectedLanguage {
  if (!playerResponse) return NO_LANGUAGE;
  const hints = extractLanguageHintsFromPlayerResponse(playerResponse);
  return languageFromCaptionTracks(
    playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks,
    hints
  );
}
