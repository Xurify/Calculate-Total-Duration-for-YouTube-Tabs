import { languageKey } from "./languageLimits";
import type { TranscriptSentence } from "./transcript";

/**
 * Listen-first checks: captions stay hidden, the video pauses after a stretch of speech, and the learner says
 * whether they caught it, caught it only after reading, or not at all.
 */

export type CheckResult = "caught" | "read" | "missed";

export interface ListeningCheckpoint {
  firstIndex: number;
  lastIndex: number;
  startSeconds: number;
  endSeconds: number;
}

export interface ListeningVideo {
  videoId: string;
  title: string;
  channelName: string;
  language: string;
  caught: number;
  read: number;
  missed: number;
  lastAt: number;
}

export type ListeningLog = Record<string, ListeningVideo>;

export interface ListeningTotals {
  caught: number;
  read: number;
  missed: number;
}

export interface ListeningSummary {
  byLanguage: (ListeningTotals & { language: string; videos: number })[];
  videos: ListeningVideo[];
}

export const LISTENING_LOG_KEY = "listeningLog";
export const LISTEN_FIRST_KEY = "listenFirst";
/** Pausing after "Ja." or "Áno." would stop every second; a check covers at least this much speech. */
export const MIN_CHECK_SECONDS = 3;
const MAX_LOGGED_VIDEOS = 500;

export function listeningCheckpoints(sentences: readonly TranscriptSentence[], minSeconds = MIN_CHECK_SECONDS): ListeningCheckpoint[] {
  const checkpoints: ListeningCheckpoint[] = [];
  let first = 0;
  for (let index = 0; index < sentences.length; index++) {
    const startSeconds = sentences[first].startSeconds;
    const endSeconds = sentences[index].endSeconds;
    if (endSeconds - startSeconds >= minSeconds || index === sentences.length - 1) {
      checkpoints.push({ firstIndex: first, lastIndex: index, startSeconds, endSeconds });
      first = index + 1;
    }
  }
  const last = checkpoints[checkpoints.length - 1];
  const beforeLast = checkpoints[checkpoints.length - 2];
  if (last && beforeLast && last.endSeconds - last.startSeconds < minSeconds) {
    beforeLast.lastIndex = last.lastIndex;
    beforeLast.endSeconds = last.endSeconds;
    checkpoints.pop();
  }
  return checkpoints;
}

/** The checkpoint being spoken at `seconds`, or the next one when between two. */
export function checkpointAt(checkpoints: readonly ListeningCheckpoint[], seconds: number): number {
  const index = checkpoints.findIndex((checkpoint) => seconds < checkpoint.endSeconds);
  return index === -1 ? checkpoints.length : index;
}

export function checkpointText(sentences: readonly TranscriptSentence[], checkpoint: ListeningCheckpoint): string {
  return sentences
    .slice(checkpoint.firstIndex, checkpoint.lastIndex + 1)
    .map((sentence) => sentence.text)
    .join(" ");
}

export function recordCheck(
  log: ListeningLog,
  video: Pick<ListeningVideo, "videoId" | "title" | "channelName" | "language">,
  result: CheckResult,
  now: number = Date.now()
): ListeningLog {
  const existing = log[video.videoId];
  const row: ListeningVideo = existing
    ? { ...existing, title: video.title || existing.title, channelName: video.channelName || existing.channelName, language: video.language || existing.language }
    : { ...video, caught: 0, read: 0, missed: 0, lastAt: now };
  row[result] += 1;
  row.lastAt = now;
  const next = { ...log, [video.videoId]: row };
  const ids = Object.keys(next);
  if (ids.length > MAX_LOGGED_VIDEOS) {
    ids
      .sort((first, second) => next[first].lastAt - next[second].lastAt)
      .slice(0, ids.length - MAX_LOGGED_VIDEOS)
      .forEach((id) => delete next[id]);
  }
  return next;
}

export function checkCount(totals: ListeningTotals): number {
  return totals.caught + totals.read + totals.missed;
}

/** Share caught by ear alone. */
export function caughtShare(totals: ListeningTotals): number {
  const count = checkCount(totals);
  return count > 0 ? totals.caught / count : 0;
}

export function summarizeListening(log: ListeningLog): ListeningSummary {
  const videos = Object.values(log)
    .filter((video) => checkCount(video) > 0)
    .sort((first, second) => second.lastAt - first.lastAt);
  const languages = new Map<string, ListeningSummary["byLanguage"][number]>();
  for (const video of videos) {
    const key = languageKey(video.language);
    const row = languages.get(key) ?? { language: video.language, caught: 0, read: 0, missed: 0, videos: 0 };
    row.caught += video.caught;
    row.read += video.read;
    row.missed += video.missed;
    row.videos += 1;
    languages.set(key, row);
  }
  return { byLanguage: [...languages.values()].sort((first, second) => checkCount(second) - checkCount(first)), videos };
}

export function cleanListeningLog(raw: unknown): ListeningLog {
  if (!raw || typeof raw !== "object") return {};
  const log: ListeningLog = {};
  for (const [id, value] of Object.entries(raw as Record<string, Partial<ListeningVideo>>)) {
    if (!value || typeof value !== "object" || typeof value.videoId !== "string") continue;
    const count = (field: unknown) => (typeof field === "number" && Number.isFinite(field) && field > 0 ? Math.floor(field) : 0);
    log[id] = {
      videoId: value.videoId,
      title: typeof value.title === "string" ? value.title : "",
      channelName: typeof value.channelName === "string" ? value.channelName : "",
      language: typeof value.language === "string" ? value.language : "",
      caught: count(value.caught),
      read: count(value.read),
      missed: count(value.missed),
      lastAt: count(value.lastAt),
    };
  }
  return log;
}

export async function loadListeningLog(): Promise<ListeningLog> {
  if (!browser.storage?.local) return {};
  const data = await browser.storage.local.get(LISTENING_LOG_KEY);
  return cleanListeningLog(data[LISTENING_LOG_KEY]);
}

export async function saveListeningLog(log: ListeningLog): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [LISTENING_LOG_KEY]: log });
}
