import { normalizeLanguageCode, type DetectedLanguage } from "./captionLanguage";
import { loadFocusLanguages } from "./focusLanguages";
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

/** A null language forgets the video, so a guess made by older, surer-sounding logic stops counting. */
async function recordChannelLanguage(channelName: string, videoId: string, language: string | null) {
  const memory = await readMemory();
  const code = language ? normalizeLanguageCode(language) : null;
  const videos = (memory[channelName] ??= {});
  if (code === null) {
    if (!(videoId in videos)) return;
    delete videos[videoId];
  } else {
    if (videos[videoId] === code) return;
    delete videos[videoId];
    videos[videoId] = code;
    const ids = Object.keys(videos);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_VIDEOS_PER_CHANNEL))) delete videos[id];
  }
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
 * clear text detection, i.e. not `weak`) are remembered. The channel's language settles text
 * that is a close call, and is the last resort when nothing names any language, but only once
 * 3+ remembered videos exist and 80% of them agree, so multilingual channels (Talks at Google)
 * stay unlabelled instead of forced.
 */
export async function resolveVideoLanguage(
  detected: DetectedLanguage,
  text: string,
  source: VideoChannel,
  displayLocale?: string | null
): Promise<DetectedLanguage> {
  const channel = source.channelName?.trim();
  const [channelCode, followed] = await Promise.all([
    channel ? channelMajorityLanguage(channel).catch(() => null) : null,
    loadFocusLanguages().catch(() => []),
  ]);
  const refined = await refineLanguageWithText(detected, text, displayLocale, { channel: channelCode, followed });
  if (!channel) return refined;
  try {
    if (refined.language) {
      if (source.videoId) await recordChannelLanguage(channel, source.videoId, refined.weak ? null : refined.language);
      return refined;
    }
    if (!channelCode) return refined;
    return { language: channelCode, languageName: languageDisplayName(channelCode, displayLocale) };
  } catch {
    return refined;
  }
}
