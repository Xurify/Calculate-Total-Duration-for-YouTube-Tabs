import { normalizeLanguageCode, type DetectedLanguage } from "../../utils/captionLanguage";
import { resolveVideoLanguage } from "../../utils/channelLanguage";
import { SiteTracker } from "../../utils/siteTracker";
import { loadTimeTrackingPrefs } from "../../utils/timeLog";
import { recordChannelAvatar } from "../../utils/channelAvatars";
import { recommendInstead, type Recommendation } from "../../utils/recommendations";
import {
  limitUsage,
  loadLanguageLimits,
  loadLimitWarningsShown,
  newLimitWarnings,
  saveLimitWarningsShown,
  type LanguageLimitUsage,
  type LimitWarning,
} from "../../utils/languageLimits";
import {
  loadWatchLog,
  recordWatchSample,
  saveWatchLog,
  trimWatchLog,
  type WatchEntry,
  type WatchSample,
} from "../../utils/watchLog";
import { loadLanguageOverrides } from "../../utils/languageOverrides";
import { archiveEntries, loadLanguageHours, saveLanguageHours } from "../../utils/languageHours";
import { notifyMandalaTabsOfPendingTime } from "./mandala";

export const siteTracker = new SiteTracker(() => void notifyMandalaTabsOfPendingTime());

let watchLog: WatchEntry[] | null = null;
let watchQueue: Promise<unknown> = Promise.resolve();

export function withWatchLog<T>(work: (log: WatchEntry[]) => Promise<T> | T): Promise<T> {
  const run = watchQueue.then(async () => {
    watchLog ??= await loadWatchLog();
    return work(watchLog);
  });
  watchQueue = run.catch((error) => console.warn("[Study Harvester] watch log:", error));
  return run;
}

export async function recordWatch(sample: WatchSample): Promise<{ limitWarnings: LimitWarning[]; recommendations: Recommendation[] }> {
  const prefs = await loadTimeTrackingPrefs();
  if (!prefs.watchHistory) return { limitWarnings: [], recommendations: [] };
  const { usage, limits, overrides, log } = await withWatchLog(async (log) => {
    recordWatchSample(log, sample);
    await persistWatchLog(log);
    const limits = await loadLanguageLimits();
    const overrides = await loadLanguageOverrides();
    return { usage: limits.length > 0 ? limitUsage(limits, log, Date.now(), overrides) : [], limits, overrides, log: [...log] };
  });
  if (sample.channelAvatar && sample.channelName) await recordChannelAvatar(sample.channelName, sample.channelAvatar);
  const limitWarnings = await takeLimitWarnings(usage);
  const over = limitWarnings.find((warning) => warning.level === "over");
  return { limitWarnings, recommendations: over ? recommendInstead(log, limits, over.language, Date.now(), overrides) : [] };
}

/** Time in entries the trim drops is kept per language, so lifetime hours do not shrink after a year. */
async function persistWatchLog(log: WatchEntry[]): Promise<void> {
  const kept = trimWatchLog(log);
  if (kept.length < log.length) {
    const keptIds = new Set(kept.map((entry) => entry.id));
    const dropped = log.filter((entry) => !keptIds.has(entry.id));
    await saveLanguageHours(archiveEntries(await loadLanguageHours(), dropped));
    log.splice(0, log.length, ...kept);
  }
  await saveWatchLog(log);
}

let limitWarningsQueue: Promise<unknown> = Promise.resolve();

/** Serialised so two tabs flushing at once don't both show the same warning. */
function takeLimitWarnings(usage: LanguageLimitUsage[]): Promise<LimitWarning[]> {
  const run = limitWarningsQueue.then(async () => {
    const { warnings, shown } = newLimitWarnings(usage, await loadLimitWarningsShown());
    await saveLimitWarningsShown(shown);
    return warnings;
  });
  limitWarningsQueue = run.catch(() => {});
  return run;
}

const watchLanguageTried = new Set<string>();

/** Reuses a name already in the log for the same code, so a label in another display language doesn't split a row. */
export async function fillMissingWatchLanguages(log: WatchEntry[]): Promise<void> {
  const missing = log.filter((entry) => !entry.language && !watchLanguageTried.has(entry.id));
  if (missing.length === 0) return;
  const namesByCode = new Map<string, string>();
  for (const entry of log) {
    if (entry.language && entry.languageName) namesByCode.set(normalizeLanguageCode(entry.language), entry.languageName);
  }
  const resolved = new Map<string, DetectedLanguage>();
  let changed = false;
  for (const entry of missing) {
    watchLanguageTried.add(entry.id);
    let detected = resolved.get(entry.videoId);
    if (!detected) {
      const title = entry.title === "YouTube Video" ? "" : entry.title;
      detected = await resolveVideoLanguage({ language: null, languageName: null }, title, { channelName: entry.channelName, videoId: entry.videoId });
      resolved.set(entry.videoId, detected);
    }
    if (!detected.language) continue;
    entry.language = detected.language;
    entry.languageName = namesByCode.get(normalizeLanguageCode(detected.language)) ?? detected.languageName;
    changed = true;
  }
  if (changed) await persistWatchLog(log);
}
