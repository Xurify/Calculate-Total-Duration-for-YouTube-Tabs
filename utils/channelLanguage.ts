import { normalizeLanguageCode, type DetectedLanguage } from "./captionLanguage";
import { languageDisplayName, refineLanguageWithText } from "./textLanguage";

const STORAGE_KEY = "channelLanguages";
const MIN_CONFIRMED_VIDEOS = 3;
const MIN_MAJORITY_SHARE = 0.8;
const MAX_VIDEOS_PER_CHANNEL = 50;

/** channelName → videoId → language. Keyed by video so re-syncing one video counts it once. */
type ChannelLanguageMemory = Record<string, Record<string, string>>;

export interface VideoChannel {
  channelName?: string | null;
  videoId?: string | null;
}

async function readMemory(): Promise<ChannelLanguageMemory> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return (stored[STORAGE_KEY] as ChannelLanguageMemory | undefined) ?? {};
}

async function recordChannelLanguage(channelName: string, videoId: string, language: string) {
  const memory = await readMemory();
  const code = normalizeLanguageCode(language);
  const videos = (memory[channelName] ??= {});
  if (videos[videoId] === code) return;
  delete videos[videoId];
  videos[videoId] = code;
  const ids = Object.keys(videos);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_VIDEOS_PER_CHANNEL))) delete videos[id];
  await browser.storage.local.set({ [STORAGE_KEY]: memory });
}

async function channelMajorityLanguage(channelName: string): Promise<string | null> {
  const codes = Object.values((await readMemory())[channelName] ?? {});
  if (codes.length < MIN_CONFIRMED_VIDEOS) return null;
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  const [code, count] = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return count / codes.length >= MIN_MAJORITY_SHARE ? code : null;
}

/**
 * Text refinement plus a per-channel memory. Only trusted results (uploader metadata or a
 * reliable text detection, i.e. not `weak`) are remembered. The channel's language is a last
 * resort when neither names any language, and only once 3+ remembered videos exist and 80%
 * of them agree, so multilingual channels (Talks at Google) stay unlabelled instead of forced.
 */
export async function resolveVideoLanguage(
  detected: DetectedLanguage,
  text: string,
  source: VideoChannel,
  displayLocale?: string | null
): Promise<DetectedLanguage> {
  const refined = await refineLanguageWithText(detected, text, displayLocale);
  const channel = source.channelName?.trim();
  if (!channel) return refined;
  try {
    if (refined.language) {
      if (!refined.weak && source.videoId) {
        await recordChannelLanguage(channel, source.videoId, refined.language);
      }
      return refined;
    }
    const code = await channelMajorityLanguage(channel);
    if (!code) return refined;
    return { language: code, languageName: languageDisplayName(code, displayLocale) };
  } catch {
    return refined;
  }
}
