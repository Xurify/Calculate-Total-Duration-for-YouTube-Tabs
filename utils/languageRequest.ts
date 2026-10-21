import type { DetectedLanguage } from "./captionLanguage";
import type { VideoChannel } from "./channelLanguage";

export const RESOLVE_LANGUAGE_ACTION = "resolve-video-language";

export interface ResolveLanguageMessage extends VideoChannel {
  action: typeof RESOLVE_LANGUAGE_ACTION;
  detected: DetectedLanguage;
  text: string;
  displayLocale?: string | null;
}

/** resolveVideoLanguage from a content script or page: the text model lives only in the background. */
export async function requestVideoLanguage(
  detected: DetectedLanguage,
  text: string,
  source: VideoChannel,
  displayLocale?: string | null
): Promise<DetectedLanguage> {
  try {
    const resolved = (await browser.runtime.sendMessage({
      action: RESOLVE_LANGUAGE_ACTION,
      detected,
      text,
      channelName: source.channelName,
      videoId: source.videoId,
      displayLocale,
    } satisfies ResolveLanguageMessage)) as DetectedLanguage | undefined;
    return resolved && "language" in resolved ? resolved : detected;
  } catch {
    return detected;
  }
}
