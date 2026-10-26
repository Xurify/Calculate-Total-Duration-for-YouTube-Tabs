import { isGoal, languageKey, secondsTodayByLanguage, type LanguageLimit } from "./languageLimits";
import type { LanguageOverrides } from "./languageOverrides";
import { COMPLETED_SHARE, entryLanguage, UNKNOWN_LANGUAGE, type WatchEntry } from "./watchLog";

export interface Recommendation {
  videoId: string;
  title: string;
  channelName: string;
  language: string;
  durationSeconds: number;
  /** Where to pick the video up again; 0 starts from the beginning. */
  resumeSeconds: number;
  /** A goal in this language still needs time today. */
  forGoal: boolean;
}

export const RECOMMENDATION_COUNT = 3;
/** Closer than this to either end, starting over or skipping the video is the better offer. */
const RESUME_MARGIN_SECONDS = 30;

export function recommendInstead(
  entries: readonly WatchEntry[],
  rules: readonly LanguageLimit[],
  overLanguage: string,
  now: number = Date.now(),
  overrides: LanguageOverrides | null = null,
  count = RECOMMENDATION_COUNT
): Recommendation[] {
  const today = secondsTodayByLanguage(entries, now, overrides);
  const blocked = new Set([languageKey(overLanguage), languageKey(UNKNOWN_LANGUAGE)]);
  const goalNeeds = new Set<string>();
  for (const rule of rules) {
    const key = languageKey(rule.language);
    const used = today.get(key) ?? 0;
    if (isGoal(rule) && used < rule.minutes * 60) goalNeeds.add(key);
    if (!isGoal(rule) && used >= rule.minutes * 60) blocked.add(key);
  }

  const latest = new Map<string, WatchEntry>();
  const watchedVideoSeconds = new Map<string, number>();
  for (const entry of entries) {
    watchedVideoSeconds.set(entry.videoId, (watchedVideoSeconds.get(entry.videoId) ?? 0) + entry.videoSeconds);
    const previous = latest.get(entry.videoId);
    if (!previous || entry.endedAt >= previous.endedAt) latest.set(entry.videoId, entry);
  }

  const candidates: (Recommendation & { lastAt: number })[] = [];
  for (const entry of latest.values()) {
    if (entry.isLive || entry.isShort || entry.durationSeconds <= 0) continue;
    const language = entryLanguage(entry, overrides);
    const key = languageKey(language);
    if (blocked.has(key)) continue;
    const position = entry.lastPosition ?? 0;
    const finished =
      position >= entry.durationSeconds - RESUME_MARGIN_SECONDS ||
      (watchedVideoSeconds.get(entry.videoId) ?? 0) >= entry.durationSeconds * COMPLETED_SHARE;
    if (finished) continue;
    candidates.push({
      videoId: entry.videoId,
      title: entry.title,
      channelName: entry.channelName,
      language,
      durationSeconds: entry.durationSeconds,
      resumeSeconds: position >= RESUME_MARGIN_SECONDS ? Math.floor(position) : 0,
      forGoal: goalNeeds.has(key),
      lastAt: entry.endedAt,
    });
  }

  const ranked = candidates.sort((first, second) => Number(second.forGoal) - Number(first.forGoal) || second.lastAt - first.lastAt);
  // One per language first, so the card offers a real choice; the rest fill up in rank order.
  const picked: typeof ranked = [];
  const languages = new Set<string>();
  for (const candidate of ranked) {
    if (picked.length < count && !languages.has(candidate.language)) {
      picked.push(candidate);
      languages.add(candidate.language);
    }
  }
  for (const candidate of ranked) if (picked.length < count && !picked.includes(candidate)) picked.push(candidate);
  return picked
    .sort((first, second) => ranked.indexOf(first) - ranked.indexOf(second))
    .map(({ lastAt, ...recommendation }) => recommendation);
}
