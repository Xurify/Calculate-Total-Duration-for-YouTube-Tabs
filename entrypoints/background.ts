import {
  loadPrefsAndMetadataCache,
  normalizeYoutubeUrl,
  saveSession,
  loadCachedMandalaSummary,
  saveCachedMandalaSummary,
  mandalaStatusFor,
  shelfLinksForVideo,
  type MandalaStatus,
  saveStagedClozeCard,
  loadStagedClozeCards,
  clearStagedClozeCards,
  removeStagedClozeCards,
  getSavedSessions,
  PENDING_MANDALA_LOGS_KEY,
  PENDING_MANDALA_SHELF_LINKS_KEY,
  type CachedMetadata,
  type VideoChapter,
  type SavedSessionTab,
  type UserPrefs,
  type StagedClozeCard,
  type PendingMandalaTimeLog,
  type PendingMandalaShelfLink,
} from "../utils/storage";
import { applyMetadataBatchToCache, normalizeMetadataBatch } from "../utils/store";
import {
  detectLanguageFromPlayerResponse,
  languageTextFromPlayerResponse,
  normalizeLanguageCode,
  type DetectedLanguage,
} from "../utils/captionLanguage";
import { extractChaptersFromPlayerResponse } from "../utils/chapters";
import { resolveVideoLanguage } from "../utils/channelLanguage";
import { RESOLVE_LANGUAGE_ACTION, type ResolveLanguageMessage } from "../utils/languageRequest";
import { getVideoIdFromUrl, isYoutubeWatchOrShortsUrl } from "../utils/format";
import { queryReadingList, removeReadingListItemById } from "../utils/readingList";
import {
  buildApprovalRequest,
  ensureReadGrant,
  handleApprovalPageMessage,
  isExtensionPageSender,
  requestApproval,
} from "../utils/approvals";
import { isMandalaUrl, SiteTracker } from "../utils/siteTracker";
import {
  loadSiteRules,
  loadTimeTrackingPrefs,
  removeSiteRule,
  saveTimeTrackingPrefs,
  summarize,
  upsertSiteRule,
  wholeMinutes,
  type SiteRule,
  type TimeTrackingPrefs,
} from "../utils/timeLog";
import { getLiveTabSections } from "../utils/storage";
import { avatarFromWatchHtml, loadChannelAvatars, recordChannelAvatar, recordChannelAvatars } from "../utils/channelAvatars";
import { goalStreaks } from "../utils/goals";
import { recommendInstead, type Recommendation } from "../utils/recommendations";
import { watchCsv, watchEntriesSince, CSV_COLUMNS, type CsvColumn } from "../utils/watchCsv";
import {
  cleanLanguageLimits,
  limitUsage,
  loadLanguageLimits,
  loadLimitWarningsShown,
  newLimitWarnings,
  saveLanguageLimits,
  saveLimitWarningsShown,
  type LanguageLimitUsage,
  type LimitWarning,
} from "../utils/languageLimits";
import {
  cleanWatchSample,
  languageLabelOf,
  loadWatchLog,
  recordWatchSample,
  saveWatchLog,
  summarizeWatch,
  trimWatchLog,
  type WatchEntry,
  type WatchSample,
} from "../utils/watchLog";
import { languageOverrideFor, loadLanguageOverrides, type LanguageOverrides } from "../utils/languageOverrides";
import { archiveEntries, languageHoursRows, loadLanguageHours, saveLanguageHours, setEarlierHours } from "../utils/languageHours";
import { loadListeningLog, recordCheck, saveListeningLog, summarizeListening, type CheckResult } from "../utils/listening";
import {
  addToBank,
  cleanBank,
  editSentences,
  loadSentenceBank,
  markInClozemaster,
  reviewSentence,
  saveSentenceBank,
  type NewBankSentence,
  type ReviewGrade,
  type SentenceEdit,
} from "../utils/sentenceBank";
import { clozemasterCard, DEFAULT_COLLECTION_NAME, sentenceLanguageCode } from "../utils/clozemasterExport";
import { MAX_CARDS_PER_CALL } from "../utils/clozemasterTools";

/** Tells every open Mandala tab there is time to take; the tab asks for it and posts it to the page. */
async function notifyMandalaTabsOfPendingTime(): Promise<void> {
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined || !isMandalaUrl(tab.url)) continue;
    void browser.tabs.sendMessage(tab.id, { action: "flush-time-log" }).catch(() => {});
  }
}

const siteTracker = new SiteTracker(() => void notifyMandalaTabsOfPendingTime());

let watchLog: WatchEntry[] | null = null;
let watchQueue: Promise<unknown> = Promise.resolve();

function withWatchLog<T>(work: (log: WatchEntry[]) => Promise<T> | T): Promise<T> {
  const run = watchQueue.then(async () => {
    watchLog ??= await loadWatchLog();
    return work(watchLog);
  });
  watchQueue = run.catch((error) => console.warn("[Study Harvester] watch log:", error));
  return run;
}

async function recordWatch(sample: WatchSample): Promise<{ limitWarnings: LimitWarning[]; recommendations: Recommendation[] }> {
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

let practiceQueue: Promise<unknown> = Promise.resolve();

function withPracticeStore<T>(work: () => Promise<T>): Promise<T> {
  const run = practiceQueue.then(work);
  practiceQueue = run.catch((error) => console.warn("[Study Harvester] practice:", error));
  return run;
}

function videoLanguageLabel(overrides: LanguageOverrides, videoId: string, channelName: string, code: unknown, name: unknown): string {
  const override = languageOverrideFor(overrides, videoId, channelName);
  if (override) return override.name;
  return languageLabelOf(typeof name === "string" ? name : null, typeof code === "string" ? code : null);
}

function cleanNewSentence(raw: unknown, language: string, code: unknown): NewBankSentence | null {
  const sentence = raw as Partial<NewBankSentence> | null;
  if (!sentence || typeof sentence.text !== "string" || !sentence.text.trim() || typeof sentence.videoId !== "string") return null;
  if (typeof sentence.startSeconds !== "number" || typeof sentence.endSeconds !== "number" || sentence.endSeconds <= sentence.startSeconds) return null;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");
  return {
    text: text(sentence.text, 1000),
    clozeWord: text(sentence.clozeWord, 100) || null,
    translation: text(sentence.translation, 500),
    language,
    languageCode: typeof code === "string" && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(code) ? code : null,
    videoId: sentence.videoId,
    videoTitle: text(sentence.videoTitle, 300),
    channelName: text(sentence.channelName, 200),
    startSeconds: sentence.startSeconds,
    endSeconds: sentence.endSeconds,
    source: sentence.source === "cloze" ? "cloze" : "listening",
  };
}

async function addSentenceToBank(raw: unknown, code: unknown, name: unknown): Promise<boolean> {
  const overrides = await loadLanguageOverrides();
  const partial = raw as Partial<NewBankSentence> | null;
  const language = videoLanguageLabel(overrides, String(partial?.videoId ?? ""), String(partial?.channelName ?? ""), code, name);
  const sentence = cleanNewSentence(raw, language, code);
  if (!sentence) return false;
  return withPracticeStore(async () => {
    const result = addToBank(await loadSentenceBank(), sentence);
    await saveSentenceBank(result.bank);
    return result.added;
  });
}

const CLIP_MESSAGE_ATTEMPTS = 30;
const CLIP_RETRY_MS = 500;
let clipWindowId: number | null = null;

async function sendClipToTab(tabId: number, clip: { videoId: string; startSeconds: number; endSeconds: number }): Promise<{ success: boolean; errorMessage?: string }> {
  let last: { success: boolean; errorMessage?: string } = { success: false, errorMessage: "YouTube did not answer." };
  for (let attempt = 0; attempt < CLIP_MESSAGE_ATTEMPTS; attempt++) {
    try {
      const response = (await browser.tabs.sendMessage(tabId, { action: "play-clip", ...clip })) as { success: boolean; errorMessage?: string } | undefined;
      if (response?.success) return response;
      if (response) last = response;
      // A tab still on its previous video answers "another video" until the new page takes over.
      if (response && response.errorMessage !== "This tab shows another video.") return response;
    } catch {
      // The content script is not there yet.
    }
    await new Promise((resolve) => setTimeout(resolve, CLIP_RETRY_MS));
  }
  return last;
}

/**
 * Plays a saved sentence with the speaker's own voice. A tab that already shows the video is used; otherwise a
 * small player window, kept for the next clip. Chrome does not load media in a tab that has never been shown,
 * so a hidden background tab would stay silent.
 */
async function playClip(clip: { videoId: string; startSeconds: number; endSeconds: number }): Promise<{ success: boolean; errorMessage?: string }> {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(clip.videoId)}&t=${Math.floor(clip.startSeconds)}s`;
  const open = await browser.tabs.query({ url: ["*://*.youtube.com/watch*"] });
  const showing = open.find((tab) => tab.id !== undefined && !tab.discarded && tab.windowId !== clipWindowId && getVideoIdFromUrl(tab.url ?? "") === clip.videoId);
  if (showing?.id !== undefined) {
    const result = await sendClipToTab(showing.id, clip);
    if (result.success) return result;
  }
  let tabId: number | undefined;
  if (clipWindowId !== null) {
    try {
      const window = await browser.windows.get(clipWindowId, { populate: true });
      const tab = window.tabs?.[0];
      if (tab?.id !== undefined) {
        tabId = tab.id;
        if (getVideoIdFromUrl(tab.url ?? "") !== clip.videoId) await browser.tabs.update(tab.id, { url });
      }
    } catch {
      clipWindowId = null;
    }
  }
  if (tabId === undefined) {
    const window = await browser.windows.create({ url, type: "popup", width: 560, height: 360, focused: false });
    clipWindowId = window?.id ?? null;
    tabId = window?.tabs?.[0]?.id;
  }
  if (tabId === undefined) return { success: false, errorMessage: "Could not open a YouTube player." };
  return sendClipToTab(tabId, clip);
}

const avatarTried = new Set<string>();
let avatarFill: Promise<unknown> = Promise.resolve();
/** Watch pages are big; a few per summary is enough to fill the gaps over time without hammering YouTube. */
const AVATAR_FETCHES_PER_RUN = 4;

/**
 * Channels watched before avatars were recorded, or only ever seen in a background tab, get their avatar from
 * one of their videos' watch pages. Each channel is tried once per service worker life.
 */
function fillChannelAvatars(channels: { channelName: string; videoId: string }[]): void {
  avatarFill = avatarFill.then(async () => {
    const known = await loadChannelAvatars();
    const missing = channels
      .filter((channel) => channel.channelName && channel.channelName !== "Unknown channel" && !known[channel.channelName] && !avatarTried.has(channel.channelName))
      .slice(0, AVATAR_FETCHES_PER_RUN);
    const found: Record<string, string> = {};
    for (const channel of missing) {
      avatarTried.add(channel.channelName);
      try {
        const response = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(channel.videoId)}`);
        if (response.url.includes("/sorry")) break;
        const avatar = avatarFromWatchHtml(await response.text());
        if (avatar) found[channel.channelName] = avatar;
      } catch (error) {
        console.warn("[Study Harvester] channel avatar:", error);
      }
    }
    await recordChannelAvatars(found);
  }).catch(() => {});
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
async function fillMissingWatchLanguages(log: WatchEntry[]): Promise<void> {
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

const BATCH_FLUSH_MS = 80;
let pendingCacheUpdates = new Map<string, { url: string; metadata: Omit<CachedMetadata, "timestamp"> }>();
let flushTimeout: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<void> = Promise.resolve();

let storePrefs!: UserPrefs;
let storeMetadataCache: Record<string, CachedMetadata> = {};
const storeReady: Promise<void> = loadPrefsAndMetadataCache().then(({ prefs, metadataCache }) => {
  storePrefs = prefs;
  storeMetadataCache = metadataCache;
});

function broadcastStoreUpdate(patch: {
  prefs?: UserPrefs;
  metadataCache?: Record<string, CachedMetadata>;
}): void {
  void browser.runtime
    .sendMessage({ action: "store-updated", ...patch })
    .catch(() => {});
}

async function persistPrefs(): Promise<void> {
  await browser.storage.local.set({ ...storePrefs });
}

async function persistMetadataCache(): Promise<void> {
  await browser.storage.local.set({ metadataCache: storeMetadataCache });
}

function scheduleFlush() {
  if (flushTimeout != null) return;
  flushTimeout = setTimeout(() => {
    flushTimeout = null;
    const batch = new Map(pendingCacheUpdates);
    pendingCacheUpdates.clear();
    flushPromise = flushPromise.then(() => applyBatchCacheUpdates(batch));
  }, BATCH_FLUSH_MS);
}

async function applyBatchCacheUpdates(
  batch: Map<string, { url: string; metadata: Omit<CachedMetadata, "timestamp"> }>
) {
  if (batch.size === 0) return;
  await storeReady;
  const normalized = normalizeMetadataBatch(batch);
  applyMetadataBatchToCache(storeMetadataCache, normalized);
  await persistMetadataCache();
  broadcastStoreUpdate({ metadataCache: storeMetadataCache });
}

async function patchPrefs(updates: Partial<UserPrefs>): Promise<void> {
  await storeReady;
  storePrefs = { ...storePrefs, ...updates };
  await persistPrefs();
  broadcastStoreUpdate({ prefs: storePrefs });
}

async function clearMetadataCacheInStore(): Promise<void> {
  await storeReady;
  storeMetadataCache = {};
  await persistMetadataCache();
  broadcastStoreUpdate({ metadataCache: storeMetadataCache });
}

async function openDesk(): Promise<void> {
  const deskUrl = browser.runtime.getURL("/manager.html");
  const [existing] = await browser.tabs.query({ url: deskUrl });
  if (existing?.id == null) {
    await browser.tabs.create({ url: deskUrl });
    return;
  }
  await browser.tabs.update(existing.id, { active: true });
  if (existing.windowId != null) await browser.windows.update(existing.windowId, { focused: true });
}

export default defineBackground(() => {
  siteTracker.start();

  browser.commands.onCommand.addListener((command) => {
    if (command === "open-desk") void openDesk();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (handleApprovalPageMessage(message, sender, sendResponse)) {
      return true;
    }

    if (message.action === "get-time-summary") {
      const days = typeof message.days === "number" && message.days > 0 ? Math.min(90, Math.floor(message.days)) : 7;
      void Promise.all([
        siteTracker.entries(),
        withWatchLog(async (log) => {
          await fillMissingWatchLanguages(log).catch((error) => console.warn("[Study Harvester] watch languages:", error));
          return [...log];
        }),
        loadLanguageOverrides(),
        loadTimeTrackingPrefs(),
        loadSiteRules(),
        loadCachedMandalaSummary(),
        getLiveTabSections(),
        loadChannelAvatars(),
        loadLanguageLimits(),
        loadLanguageHours(),
      ])
        .then(([entries, watchEntries, overrides, prefs, rules, mandala, piles, avatars, limits, hoursStore]) => {
          const watch = summarizeWatch(watchEntries, days, Date.now(), overrides, avatars);
          sendResponse({
            summary: summarize(entries, days),
            watch,
            limits: limitUsage(limits, watchEntries, Date.now(), overrides),
            streaks: goalStreaks(watchEntries, limits, Date.now(), overrides),
            hours: languageHoursRows(watchEntries, hoursStore, limits, Date.now(), overrides),
            prefs,
            rules,
            mandala,
            piles,
          });
          fillChannelAvatars(watch.byChannel.filter((channel) => !channel.avatarUrl).map((channel) => ({ channelName: channel.channelName, videoId: channel.lastVideoId })));
        })
        .catch((error) => sendResponse({ errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === RESOLVE_LANGUAGE_ACTION) {
      const request = message as ResolveLanguageMessage;
      void resolveVideoLanguage(
        request.detected ?? { language: null, languageName: null },
        typeof request.text === "string" ? request.text : "",
        { channelName: request.channelName, videoId: request.videoId },
        request.displayLocale
      )
        .then(sendResponse)
        .catch(() => sendResponse(request.detected));
      return true;
    }

    if (message.action === "watch-sample") {
      const sample = cleanWatchSample(message.sample);
      if (!sample) {
        sendResponse({ success: true });
        return;
      }
      void recordWatch(sample)
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "listening-check") {
      const result = message.result as CheckResult;
      const video = message.video as { videoId?: unknown; title?: unknown; channelName?: unknown; language?: unknown; languageName?: unknown } | undefined;
      if (!video || typeof video.videoId !== "string" || !["caught", "read", "missed"].includes(result)) {
        sendResponse({ success: false });
        return;
      }
      const videoId = video.videoId;
      const title = typeof video.title === "string" ? video.title.slice(0, 300) : "";
      const channelName = typeof video.channelName === "string" ? video.channelName.slice(0, 200) : "";
      void loadLanguageOverrides()
        .then(async (overrides) => {
          const language = videoLanguageLabel(overrides, videoId, channelName, video.language, video.languageName);
          await withPracticeStore(async () => saveListeningLog(recordCheck(await loadListeningLog(), { videoId, title, channelName, language }, result)));
          const added = message.sentence ? await addSentenceToBank(message.sentence, video.language, video.languageName) : false;
          sendResponse({ success: true, added });
        })
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "bank-add") {
      void addSentenceToBank(message.sentence, message.languageCode, message.languageName)
        .then((added) => sendResponse({ success: true, added }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "get-practice") {
      if (!isExtensionPageSender(sender)) return;
      void Promise.all([loadSentenceBank(), loadListeningLog()])
        .then(([bank, listening]) => sendResponse({ bank, listening: summarizeListening(listening) }))
        .catch((error) => sendResponse({ errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "bank-review" || message.action === "bank-delete") {
      if (!isExtensionPageSender(sender) || typeof message.id !== "string") return;
      const id = message.id;
      const grade: ReviewGrade = message.grade === "again" ? "again" : "good";
      void withPracticeStore(async () => {
        const bank = await loadSentenceBank();
        const next = message.action === "bank-delete" ? bank.filter((sentence) => sentence.id !== id) : reviewSentence(bank, id, grade);
        await saveSentenceBank(next);
        return next;
      })
        .then((bank) => sendResponse({ success: true, bank }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "bank-restore") {
      if (!isExtensionPageSender(sender)) return;
      const [restored] = cleanBank([message.sentence]);
      if (!restored) return;
      void withPracticeStore(async () => {
        const bank = await loadSentenceBank();
        const next = bank.some((sentence) => sentence.id === restored.id) ? bank : [...bank, restored];
        await saveSentenceBank(next);
        return next;
      })
        .then((bank) => sendResponse({ success: true, bank }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "bank-edit") {
      if (!isExtensionPageSender(sender)) return;
      const edits = cleanEdits(message.edits);
      void withPracticeStore(async () => {
        const next = editSentences(await loadSentenceBank(), edits);
        await saveSentenceBank(next);
        return next;
      })
        .then((bank) => sendResponse({ success: true, bank }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "clozemaster-pairs") {
      if (!isExtensionPageSender(sender)) return;
      void visitedClozemasterPairs()
        .then((pairs) => sendResponse({ pairs }))
        .catch(() => sendResponse({ pairs: [] }));
      return true;
    }

    if (message.action === "clozemaster-send") {
      if (!isExtensionPageSender(sender)) return;
      void sendBankToClozemaster(message, sender)
        .then(sendResponse)
        .catch((error) =>
          sendResponse({
            success: false,
            reason: error instanceof ClozemasterRemoteError ? error.reason : "request_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            ...(error instanceof ClozemasterRemoteError ? error.details : {}),
          })
        );
      return true;
    }

    if (message.action === "play-clip") {
      if (!isExtensionPageSender(sender) || typeof message.videoId !== "string") return;
      const startSeconds = Number(message.startSeconds);
      const endSeconds = Number(message.endSeconds);
      if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) return;
      void playClip({ videoId: message.videoId, startSeconds, endSeconds })
        .then(sendResponse)
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "set-earlier-hours") {
      if (!isExtensionPageSender(sender) || typeof message.language !== "string") return;
      const language = message.language;
      void loadLanguageHours()
        .then((store) => saveLanguageHours(setEarlierHours(store, language, Number(message.hours))))
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "get-current-site") {
      const tabId = typeof message.tabId === "number" ? message.tabId : undefined;
      void siteTracker
        .describeTab(tabId, message.url as string | undefined)
        .then((site) => sendResponse(site))
        .catch((error) => sendResponse({ match: null, todayMinutes: 0, runningSeconds: 0, pageSeconds: 0, errorMessage: String(error) }));
      return true;
    }

    if (message.action === "set-site-rule") {
      void upsertSiteRule(message.rule as Omit<SiteRule, "id" | "createdAt"> & { id?: string })
        .then((rule) => siteTracker.retrySkipped().then(() => sendResponse({ success: true, rule })))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "remove-site-rule") {
      void removeSiteRule(message.id as string)
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "set-language-limits") {
      void saveLanguageLimits(cleanLanguageLimits(message.limits))
        .then((limits) => sendResponse({ success: true, limits }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "set-time-tracking-prefs") {
      void saveTimeTrackingPrefs(message.prefs as TimeTrackingPrefs)
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "clear-time-log") {
      void Promise.all([
        siteTracker.clear(),
        withWatchLog(async (log) => {
          log.length = 0;
          await saveWatchLog(log);
          const hours = await loadLanguageHours();
          await saveLanguageHours({ ...hours, archived: {} });
        }),
      ])
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "export-watch-csv") {
      const days = typeof message.days === "number" && message.days > 0 ? Math.floor(message.days) : null;
      const allowed = new Set<string>(CSV_COLUMNS.map((column) => column.id));
      const columns = (Array.isArray(message.columns) ? message.columns : []).filter((id: unknown): id is CsvColumn => typeof id === "string" && allowed.has(id));
      void Promise.all([withWatchLog((log) => [...log]), loadLanguageOverrides()])
        .then(([log, overrides]) => {
          const rows = watchEntriesSince(log, days);
          sendResponse({ csv: watchCsv(rows, columns, overrides), rows: rows.length });
        })
        .catch((error) => sendResponse({ errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "fill-channel-avatars") {
      const channels = (Array.isArray(message.channels) ? message.channels : []).filter(
        (channel: unknown): channel is { channelName: string; videoId: string } =>
          !!channel && typeof (channel as { channelName?: unknown }).channelName === "string" && typeof (channel as { videoId?: unknown }).videoId === "string"
      );
      fillChannelAvatars(channels);
      sendResponse({ success: true });
      return;
    }

    if (message.action === "record-channel-avatars") {
      void recordChannelAvatars(message.avatars && typeof message.avatars === "object" ? (message.avatars as Record<string, string>) : {})
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }

    if (message.action === "export-time-log") {
      void Promise.all([siteTracker.entries(), withWatchLog((log) => [...log])])
        .then(([entries, watch]) => sendResponse({ json: JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), entries, watch }, null, 2) }))
        .catch((error) => sendResponse({ errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    // Only the Mandala page takes time out of the log, and only it reports what landed.
    if (message.action === "get-pending-time-entries") {
      if (!isMandalaUrl(sender.url)) {
        sendResponse({ entries: [] });
        return true;
      }
      void siteTracker
        .pending()
        .then((entries) => sendResponse({ entries: entries.map((entry) => ({ ...entry, minutes: wholeMinutes(entry) })) }))
        .catch(() => sendResponse({ entries: [] }));
      return true;
    }

    if (message.action === "mark-time-entries-synced") {
      if (!isMandalaUrl(sender.url)) {
        sendResponse({ success: false });
        return true;
      }
      void siteTracker
        .markSynced((message.logged as string[]) ?? [], (message.known as string[]) ?? [], (message.skipped as { id: string; reason: string }[]) ?? [])
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, errorMessage: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message.action === "ping") {
      sendResponse({ status: "ok" });
      return;
    }

    if (message.action === "get-store-state") {
      void storeReady.then(() => {
        sendResponse({ prefs: storePrefs, metadataCache: storeMetadataCache });
      });
      return true;
    }

    if (message.action === "update-prefs" && message.updates) {
      void patchPrefs(message.updates as Partial<UserPrefs>).then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.action === "clear-metadata-cache") {
      void clearMetadataCacheInStore().then(() => {
        sendResponse({ ok: true });
      });
      return true;
    }

    if (message.action === "update-cache" && message.url && message.metadata) {
      const normalizedUrl = normalizeYoutubeUrl(message.url);
      pendingCacheUpdates.set(normalizedUrl, {
        url: message.url,
        metadata: message.metadata as Omit<CachedMetadata, "timestamp">,
      });
      scheduleFlush();
      return;
    }

    if (message.action === "sync-all" && message.tabs) {
      void handleStealthSync(message.tabs as TabToSync[]);
      sendResponse({ started: true });
      return true;
    }

    if (message.action === "get-open-tabs-catalog") {
      void ensureReadGrant(
        sender,
        "open-tabs",
        buildApprovalRequest(sender, {
          title: "Share your open YouTube tabs?",
          summary:
            "This page wants the titles, channels and links of every YouTube tab open in all your windows.",
          confirmLabel: "Share tabs",
          destructive: false,
        })
      )
        .then(() => getOpenTabsCatalog())
        .then((catalog) => sendResponse({ success: true, catalog }))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "stage-focused-study-queue") {
      void stageFocusedStudyQueue(message.payload as StageQueuePayload, sender)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "get-reading-list-catalog") {
      void ensureReadGrant(
        sender,
        "reading-list",
        buildApprovalRequest(sender, {
          title: "Share your Reading List?",
          summary: "This page wants the title and link of every unread item in Chrome's Reading List.",
          confirmLabel: "Share Reading List",
          destructive: false,
        })
      )
        .then(() => queryReadingList(false))
        .then((items) => sendResponse({ success: true, items }))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "shelve-and-clear-reading-item") {
      const readingItemId = typeof message.id === "string" ? message.id.trim() : "";
      const notOnListMessage =
        "That id is not on the reading list. Call reading_list_get_unread and pass an id from it.";
      void queryReadingList(false)
        .then(async (items) => {
          const item = items.find((candidate) => candidate.id === readingItemId);
          if (!item) {
            sendResponse({ success: false, errorMessage: notOnListMessage });
            return;
          }
          const approved = await requestApproval(
            buildApprovalRequest(sender, {
              title: "Remove a Reading List item?",
              summary: "This page wants to remove this item from Chrome's Reading List.",
              items: [item.title ? `${item.title} — ${item.url}` : item.url],
              confirmLabel: "Remove item",
              destructive: true,
            })
          );
          if (!approved) throw new Error("The user declined to remove this Reading List item.");
          const removed = await removeReadingListItemById(readingItemId);
          sendResponse(
            removed ? { success: true, id: readingItemId } : { success: false, errorMessage: notOnListMessage }
          );
        })
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "clozemaster-remote") {
      void handleClozemasterRemote(message as ClozemasterRemoteMessage, sender)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            reason: error instanceof ClozemasterRemoteError ? error.reason : "request_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
            ...(error instanceof ClozemasterRemoteError ? error.details : {}),
          })
        );
      return true;
    }

    if (message.action === "find-clozemaster-collection-urls") {
      void findClozemasterCollectionUrls()
        .then((result) => sendResponse(result))
        .catch(() => sendResponse([]));
      return true;
    }

    if (message.action === "check-mandala-status") {
      void handleCheckMandalaStatus(message.url as string)
        .then(async (result) => {
          const site = await siteTracker.describeTab(sender.tab?.id, message.url as string);
          sendResponse({ ...result, autoLogged: site.match !== null, trackedSeconds: site.pageSeconds });
        })
        .catch((error) =>
          sendResponse({
            connected: false,
            cached: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "save-mandala-shelf-link") {
      void handleSaveMandalaShelfLink(
        message.payload as {
          pillarIndex: number;
          url: string;
          title: string;
          kind?: string;
          action?: string;
        }
      )
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "log-mandala-time") {
      void handleLogMandalaTime(message.payload as { url: string; minutes: number; videoTitle: string })
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "stage-cloze-card") {
      const card = message.card as StagedClozeCard;
      void saveStagedClozeCard(card)
        .then(() => {
          void broadcastToClozemasterTabs({ action: "new-cloze-card", card });
          sendResponse({ success: true, cardId: card.id });
        })
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "get-staged-cloze-cards") {
      void ensureReadGrant(
        sender,
        "staged-cards",
        buildApprovalRequest(sender, {
          title: "Share your captured sentences?",
          summary:
            "This page wants the sentences you captured from YouTube with the Cloze button, with their translations and notes.",
          confirmLabel: "Share sentences",
          destructive: false,
        })
      )
        .then(() => loadStagedClozeCards())
        .then((cards) => sendResponse({ success: true, cards }))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "clear-staged-cloze-cards") {
      void clearStagedCards(message.ids, sender)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "mandala-remote") {
      void handleMandalaRemote(message as MandalaRemoteMessage, sender)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "get-saved-sessions") {
      void ensureReadGrant(
        sender,
        "saved-sessions",
        buildApprovalRequest(sender, {
          title: "Share your saved sessions?",
          summary:
            "This page wants the names and video lists of the sessions saved in Study Harvester.",
          confirmLabel: "Share sessions",
          destructive: false,
        })
      )
        .then(() => getSavedSessionsCatalog())
        .then((sessions) => sendResponse({ success: true, sessions }))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }

    if (message.action === "open-saved-session") {
      void openSavedSession(message.payload as OpenSessionPayload, sender)
        .then((result) => sendResponse(result))
        .catch((error) =>
          sendResponse({
            success: false,
            errorMessage: error instanceof Error ? error.message : String(error),
          })
        );
      return true;
    }
  });
});

async function clearStagedCards(rawIds: unknown, sender: Browser.runtime.MessageSender) {
  if (rawIds !== undefined && rawIds !== null) {
    if (!Array.isArray(rawIds) || rawIds.some((id) => typeof id !== "string")) {
      throw new Error("ids must be an array of card ids from the captured cards.");
    }
  }
  const requestedIds = Array.isArray(rawIds) ? new Set(rawIds as string[]) : null;
  const stagedCards = await loadStagedClozeCards();
  const targetCards = requestedIds ? stagedCards.filter((card) => requestedIds.has(card.id)) : stagedCards;
  if (targetCards.length === 0) {
    return { success: true, removedCount: 0, remainingCount: stagedCards.length };
  }

  if (!isExtensionPageSender(sender)) {
    const approved = await requestApproval(
      buildApprovalRequest(sender, {
        title: `Remove ${targetCards.length} captured ${targetCards.length === 1 ? "sentence" : "sentences"}?`,
        summary:
          "This page wants to remove these sentences from the queue you captured with the Cloze button. Do this once they are in Clozemaster; they cannot be brought back.",
        items: targetCards.map((card) => card.sentence),
        confirmLabel: "Remove sentences",
        destructive: true,
      })
    );
    if (!approved) throw new Error("The user declined to remove the captured sentences.");
  }

  let remainingCards: StagedClozeCard[] = [];
  if (requestedIds) {
    remainingCards = await removeStagedClozeCards(targetCards.map((card) => card.id));
  } else {
    await clearStagedClozeCards();
  }
  void broadcastToClozemasterTabs({ action: "staged-cloze-cards-changed" });
  return { success: true, removedCount: targetCards.length, remainingCount: remainingCards.length };
}

interface MandalaRemoteMessage {
  op: "status" | "save" | "log";
  payload?: {
    url?: string;
    title?: string;
    pillarIndex?: unknown;
    kind?: unknown;
    minutes?: unknown;
    videoTitle?: string;
  };
}

const MAX_LOGGED_MINUTES = 24 * 60;

/**
 * The Mandala actions agents reach through the bridge. The in-player HUD keeps calling the
 * plain handlers: a click there is already the user's decision, a tool call is not.
 */
async function handleMandalaRemote(message: MandalaRemoteMessage, sender: Browser.runtime.MessageSender) {
  const payload = message.payload ?? {};
  const url = typeof payload.url === "string" ? payload.url : "";
  if (!url) throw new Error("No video URL was supplied.");

  if (message.op === "status") {
    await ensureReadGrant(
      sender,
      "mandala-status",
      buildApprovalRequest(sender, {
        title: "Share your Mandala pillars?",
        summary: "This page wants the names of your Mandala pillars and which of them hold this video.",
        confirmLabel: "Share pillars",
        destructive: false,
      })
    );
    return { success: true, ...(await handleCheckMandalaStatus(url)) };
  }

  if (message.op === "save") {
    const pillarIndex = payload.pillarIndex;
    if (typeof pillarIndex !== "number" || !Number.isInteger(pillarIndex) || pillarIndex < 0 || pillarIndex > 7) {
      throw new Error("pillarIndex must be an integer from 0 to 7.");
    }
    const kind = payload.kind === undefined ? "repeat" : payload.kind;
    if (kind !== "repeat" && kind !== "once") {
      throw new Error('kind must be "repeat" or "once".');
    }
    const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : url;
    const status = await handleCheckMandalaStatus(url);
    const pillarTitle = status.pillars.find((pillar) => pillar.index === pillarIndex)?.title || `Pillar ${pillarIndex + 1}`;
    if (status.savedPillarIndexes.includes(pillarIndex)) {
      return { success: true, alreadyExisted: true, queued: false, pillarIndex, pillarTitle };
    }

    if (!isExtensionPageSender(sender)) {
      const approved = await requestApproval(
        buildApprovalRequest(sender, {
          title: `Save this video to ${pillarTitle}?`,
          summary: `This page wants to put this video on the shelf of your Mandala pillar “${pillarTitle}”${kind === "once" ? " as a one-time item" : ""}.`,
          items: [title],
          confirmLabel: "Save to shelf",
          destructive: false,
        })
      );
      if (!approved) throw new Error("The user declined to save this video to Mandala.");
    }

    const result = await handleSaveMandalaShelfLink({ pillarIndex, url, title, kind });
    return { ...result, pillarIndex, pillarTitle };
  }

  if (message.op === "log") {
    const minutes = payload.minutes;
    if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1 || minutes > MAX_LOGGED_MINUTES) {
      throw new Error(`minutes must be a number from 1 to ${MAX_LOGGED_MINUTES}.`);
    }
    const wholeMinutes = Math.round(minutes);
    const videoTitle = typeof payload.videoTitle === "string" ? payload.videoTitle : "";

    if (!isExtensionPageSender(sender)) {
      const approved = await requestApproval(
        buildApprovalRequest(sender, {
          title: `Log ${wholeMinutes} min to Mandala?`,
          summary: "This page wants to log this watch time against the Mandala action this video is shelved under.",
          items: [videoTitle || url],
          confirmLabel: "Log time",
          destructive: false,
        })
      );
      if (!approved) throw new Error("The user declined to log this time to Mandala.");
    }

    return await handleLogMandalaTime({ url, minutes: wholeMinutes, videoTitle });
  }

  throw new Error(`Unknown Mandala operation "${String(message.op)}".`);
}

async function getSavedSessionsCatalog() {
  const sessions = await getSavedSessions();
  return sessions.map((session) => {
    const languages = new Map<string, string>();
    for (const tab of session.tabs) {
      if (tab.language) languages.set(tab.language, tab.languageName ?? tab.language);
    }
    return {
      id: session.id,
      name: session.name,
      savedAt: session.savedAt,
      pinned: Boolean(session.pinned),
      videoCount: session.tabs.length,
      totalSeconds: session.tabs.reduce((total, tab) => total + (tab.seconds || 0), 0),
      languages: [...languages.entries()].map(([code, name]) => ({ code, name })),
      videos: session.tabs.map((tab) => ({
        url: tab.url,
        videoId: getVideoIdFromUrl(tab.url),
        title: tab.title ?? "",
        channelName: tab.channelName ?? "",
        durationSeconds: tab.seconds ?? 0,
        language: tab.language ?? null,
        languageName: tab.languageName ?? null,
      })),
    };
  });
}

interface OpenSessionPayload {
  sessionId?: unknown;
  urls?: unknown;
}

const OPEN_TABS_BATCH = 8;

async function openSavedSession(payload: OpenSessionPayload, sender: Browser.runtime.MessageSender) {
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
  if (!sessionId) throw new Error("sessionId is required. Call youtube_list_saved_sessions and pass an id from it.");
  if (payload.urls !== undefined && (!Array.isArray(payload.urls) || payload.urls.some((url) => typeof url !== "string"))) {
    throw new Error("urls must be an array of the session's video URLs.");
  }

  const session = (await getSavedSessions()).find((candidate) => candidate.id === sessionId);
  if (!session) throw new Error("No saved session has that id. Call youtube_list_saved_sessions for the current ids.");

  const requestedIds = Array.isArray(payload.urls)
    ? new Set((payload.urls as string[]).map((url) => getVideoIdFromUrl(url) ?? normalizeYoutubeUrl(url)))
    : null;
  const selectedTabs = session.tabs.filter((tab) => {
    if (!tab.url) return false;
    if (!requestedIds) return true;
    return requestedIds.has(getVideoIdFromUrl(tab.url) ?? tab.url);
  });
  if (selectedTabs.length === 0) {
    throw new Error(
      requestedIds ? "None of those urls belong to this session." : "This session has no videos to open."
    );
  }

  const openTabs = await browser.tabs.query({});
  const openVideoIds = new Set(
    openTabs.map((tab) => (tab.url ? getVideoIdFromUrl(tab.url) : null)).filter((id): id is string => Boolean(id))
  );
  const tabsToOpen = selectedTabs.filter((tab) => {
    const videoId = getVideoIdFromUrl(tab.url);
    return !videoId || !openVideoIds.has(videoId);
  });
  if (tabsToOpen.length === 0) {
    return { success: true, sessionId, name: session.name, openedCount: 0, alreadyOpenCount: selectedTabs.length };
  }

  if (!isExtensionPageSender(sender)) {
    const approved = await requestApproval(
      buildApprovalRequest(sender, {
        title: `Open ${tabsToOpen.length} ${tabsToOpen.length === 1 ? "tab" : "tabs"} from “${session.name}”?`,
        summary: "This page wants to reopen these saved videos as background tabs in this window.",
        items: tabsToOpen.map((tab) => tab.title || tab.url),
        confirmLabel: "Open tabs",
        destructive: false,
      })
    );
    if (!approved) throw new Error("The user declined to open the saved session.");
  }

  const windowId = sender.tab?.windowId;
  let openedCount = 0;
  for (let index = 0; index < tabsToOpen.length; index += OPEN_TABS_BATCH) {
    const batch = tabsToOpen.slice(index, index + OPEN_TABS_BATCH);
    const results = await Promise.allSettled(
      batch.map((tab) => browser.tabs.create({ url: tab.url, active: false, ...(windowId != null ? { windowId } : {}) }))
    );
    openedCount += results.filter((result) => result.status === "fulfilled").length;
  }

  return {
    success: true,
    sessionId,
    name: session.name,
    openedCount,
    alreadyOpenCount: selectedTabs.length - tabsToOpen.length,
  };
}

async function findMandalaTab() {
  const allTabs = await browser.tabs.query({});
  return allTabs.find((candidateTab) => {
    if (!candidateTab.url) return false;
    try {
      const urlObject = new URL(candidateTab.url);
      return (
        urlObject.hostname === "mandalamethod.vercel.app" ||
        (import.meta.env.DEV && urlObject.host === "localhost:5173")
      );
    } catch {
      return false;
    }
  });
}

async function broadcastToClozemasterTabs(messagePayload: unknown): Promise<void> {
  const allTabs = await browser.tabs.query({});
  const clozemasterTabs = allTabs.filter((candidateTab) => {
    if (!candidateTab.url || candidateTab.id === undefined) return false;
    try {
      const urlObject = new URL(candidateTab.url);
      return urlObject.hostname.includes("clozemaster.com");
    } catch {
      return false;
    }
  });
  for (const clozemasterTab of clozemasterTabs) {
    if (clozemasterTab.id !== undefined) {
      void browser.tabs.sendMessage(clozemasterTab.id, messagePayload).catch(() => {});
    }
  }
}

const CLOZEMASTER_PLAY_URL = /^https:\/\/www\.clozemaster\.com\/l\/([a-z]{3}-[a-z]{3})\/collections\/([^/?#]+)\/play(?:[?#]|$)/i;

/** Only collection play URLs the person actually visited; nothing else from history leaves here. */
async function findClozemasterCollectionUrls(limit = 10) {
  const items = await browser.history.search({ text: "clozemaster.com/l/", startTime: 0, maxResults: 1000 });
  const bySlug = new Map<string, { url: string; languagePair: string; slug: string; title: string; lastVisitTime: number }>();
  for (const item of items) {
    const match = item.url?.match(CLOZEMASTER_PLAY_URL);
    if (!item.url || !match) continue;
    const slug = decodeURIComponent(match[2]);
    const lastVisitTime = item.lastVisitTime ?? 0;
    const existing = bySlug.get(slug);
    if (existing && existing.lastVisitTime >= lastVisitTime) continue;
    bySlug.set(slug, { url: item.url, languagePair: match[1].toLowerCase(), slug, title: item.title ?? "", lastVisitTime });
  }
  return [...bySlug.values()].sort((first, second) => second.lastVisitTime - first.lastVisitTime).slice(0, limit);
}

interface ClozemasterRemoteMessage {
  op: "list" | "add";
  payload?: {
    languagePair?: string;
    collectionId?: number | string;
    collectionName?: string;
    cards?: Array<{ sentence?: string }>;
  };
}

class ClozemasterRemoteError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

const CLOZEMASTER_PAIR_URL = /^https:\/\/www\.clozemaster\.com\/l\/([a-z]{3}-[a-z]{3})(?:[/?#]|$)/i;

function clozemasterPairOf(url: string | undefined): string | null {
  return url?.match(CLOZEMASTER_PAIR_URL)?.[1]?.toLowerCase() ?? null;
}

/** Language pairs the person has opened in Clozemaster, most recent first. */
async function visitedClozemasterPairs(): Promise<string[]> {
  const items = await browser.history.search({ text: "clozemaster.com/l/", startTime: 0, maxResults: 1000 });
  const pairs: string[] = [];
  for (const item of [...items].sort((first, second) => (second.lastVisitTime ?? 0) - (first.lastVisitTime ?? 0))) {
    const pair = clozemasterPairOf(item.url);
    if (pair && !pairs.includes(pair)) pairs.push(pair);
  }
  return pairs;
}

async function waitForTabComplete(tabId: number, timeoutMilliseconds = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

/**
 * A Clozemaster tab for the language: an open one if there is one, otherwise a background tab
 * on that language's dashboard (the /l/<pair> page Clozemaster's own language menu links to).
 */
async function clozemasterTabFor(requestedPair: string | null): Promise<{ tabId: number; opened: boolean; pair: string | null }> {
  const tabs = (await browser.tabs.query({ url: "https://www.clozemaster.com/*" })).filter((tab) => tab.id !== undefined);
  const matching = requestedPair
    ? tabs.find((tab) => clozemasterPairOf(tab.url) === requestedPair)
    : tabs.find((tab) => clozemasterPairOf(tab.url)) ?? tabs[0];
  if (matching?.id !== undefined) return { tabId: matching.id, opened: false, pair: clozemasterPairOf(matching.url) };

  let pair = requestedPair;
  if (!pair) {
    const visited = await visitedClozemasterPairs();
    if (visited.length === 1) pair = visited[0];
    else if (visited.length > 1) {
      throw new ClozemasterRemoteError("language_required", "Which Clozemaster language should these go to?", {
        instruction: "Pass languagePair, one of knownLanguagePairs.",
        knownLanguagePairs: visited,
      });
    } else {
      throw new ClozemasterRemoteError("no_clozemaster_tab", "No Clozemaster language is known yet.", {
        instruction: "Open https://www.clozemaster.com, sign in and open the language you study, then try again.",
      });
    }
  }

  const created = await browser.tabs.create({ url: `https://www.clozemaster.com/l/${pair}`, active: false });
  if (created.id === undefined) throw new ClozemasterRemoteError("request_failed", "Couldn't open Clozemaster.");
  await waitForTabComplete(created.id);
  return { tabId: created.id, opened: true, pair };
}

async function sendToClozemasterTab(tabId: number, message: unknown): Promise<unknown> {
  // A freshly opened tab may not have its content script yet.
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await browser.tabs.sendMessage(tabId, message);
      const notReady = (response as { reason?: string } | undefined)?.reason === "not_ready";
      if (response !== undefined && !notReady) return response;
    } catch {
      // Receiving end not there yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new ClozemasterRemoteError("not_ready", "The Clozemaster tab didn't answer.", {
    instruction: "Reload the Clozemaster tab and try again.",
  });
}

async function handleClozemasterRemote(message: ClozemasterRemoteMessage, sender: Browser.runtime.MessageSender) {
  const payload = message.payload ?? {};
  const requestedPair = payload.languagePair?.trim().toLowerCase() || null;
  if (requestedPair && !/^[a-z]{3}-[a-z]{3}$/.test(requestedPair)) {
    throw new ClozemasterRemoteError("invalid_input", `"${payload.languagePair}" isn't a Clozemaster language pair.`, {
      instruction: 'Use a pair from a Clozemaster URL, such as "slk-eng".',
    });
  }

  if (message.op === "list") {
    await ensureReadGrant(
      sender,
      "clozemaster-collections",
      buildApprovalRequest(sender, {
        title: "Share your Clozemaster collections?",
        summary: "This page wants to see the names of your Clozemaster collections so it can add sentences to one.",
        confirmLabel: "Allow",
        destructive: false,
      })
    );
  } else if (!isExtensionPageSender(sender)) {
    const cards = Array.isArray(payload.cards) ? payload.cards : [];
    const target = payload.collectionName?.trim()
      ? `“${payload.collectionName.trim()}” (created if you don't have it yet)`
      : `collection ${payload.collectionId ?? "?"}`;
    const approved = await requestApproval(
      buildApprovalRequest(sender, {
        title: `Add ${cards.length} ${cards.length === 1 ? "sentence" : "sentences"} to Clozemaster?`,
        summary: `This page wants to add these sentences to your Clozemaster ${target}${requestedPair ? ` for ${requestedPair}` : ""}.`,
        items: cards.map((card) => card.sentence ?? ""),
        confirmLabel: "Add sentences",
        destructive: false,
      })
    );
    if (!approved) throw new ClozemasterRemoteError("declined", "The user declined to add these sentences.");
  }

  const { tabId, opened, pair } = await clozemasterTabFor(requestedPair);
  try {
    const { languagePair: _ignored, ...opPayload } = payload;
    const result = (await sendToClozemasterTab(tabId, { action: "clozemaster-op", op: message.op, payload: opPayload })) as Record<
      string,
      unknown
    >;
    return { ...result, languagePair: pair };
  } finally {
    if (opened) void browser.tabs.remove(tabId).catch(() => {});
  }
}

function cleanEdits(raw: unknown): SentenceEdit[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((edit): edit is SentenceEdit => Boolean(edit) && typeof edit.id === "string")
    .map((edit) => ({
      id: edit.id,
      clozeWord: typeof edit.clozeWord === "string" ? edit.clozeWord.slice(0, 100) : undefined,
      translation: typeof edit.translation === "string" ? edit.translation.slice(0, 500) : undefined,
    }));
}

interface ClozemasterSendResult {
  success?: boolean;
  reason?: string;
  errorMessage?: string;
  instruction?: string;
  collection?: { name: string; playUrl: string | null };
  results?: Array<{ index: number; added: boolean; error?: string }>;
}

/**
 * Adds saved sentences to a collection for one language pair. The cards are built here from the
 * stored text, so the page only chooses the blank and the translation.
 */
async function sendBankToClozemaster(message: Record<string, unknown>, sender: Browser.runtime.MessageSender) {
  const languagePair = typeof message.languagePair === "string" ? message.languagePair : "";
  const collectionName = (typeof message.collectionName === "string" ? message.collectionName.trim().slice(0, 100) : "") || DEFAULT_COLLECTION_NAME;
  const edits = cleanEdits(message.items).filter((edit) => edit.clozeWord && edit.translation);
  // Saved first, so the translations typed in stay even when Clozemaster can't be reached.
  const bank = await withPracticeStore(async () => {
    const next = editSentences(await loadSentenceBank(), edits);
    await saveSentenceBank(next);
    return next;
  });
  const chosen = edits
    .map((edit) => bank.find((sentence) => sentence.id === edit.id))
    .filter((sentence): sentence is NonNullable<typeof sentence> => Boolean(sentence));
  if (chosen.length === 0) return { success: false, reason: "invalid_input", errorMessage: "Pick at least one sentence with a translation." };

  const added: string[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  let collection: ClozemasterSendResult["collection"];
  for (let start = 0; start < chosen.length; start += MAX_CARDS_PER_CALL) {
    const batch = chosen.slice(start, start + MAX_CARDS_PER_CALL);
    const cards = batch.map((sentence) => clozemasterCard(sentence, sentence.clozeWord ?? "", sentence.translation, sentenceLanguageCode(sentence)));
    const result = (await handleClozemasterRemote({ op: "add", payload: { languagePair, collectionName, cards } }, sender)) as ClozemasterSendResult;
    if (!result.results) {
      // Nothing was attempted: signed out, no Pro, or no Clozemaster tab. Keep what was sent so far.
      if (added.length === 0) return { ...result, success: false, bank };
      break;
    }
    collection = result.collection ?? collection;
    for (const row of result.results) {
      const sentence = batch[row.index];
      if (!sentence) continue;
      if (row.added) added.push(sentence.id);
      else failed.push({ id: sentence.id, error: row.error ?? "Not added." });
    }
  }

  const next = await withPracticeStore(async () => {
    const marked = markInClozemaster(await loadSentenceBank(), added, collection?.name ?? collectionName);
    await saveSentenceBank(marked);
    return marked;
  });
  const playUrl = collection?.playUrl ? new URL(collection.playUrl, "https://www.clozemaster.com").href : null;
  return { success: added.length > 0, bank: next, addedCount: added.length, failed, collection: { name: collection?.name ?? collectionName, playUrl } };
}

async function handleCheckMandalaStatus(rawUrl: string): Promise<MandalaStatus> {
  const mandalaTab = await findMandalaTab();
  if (mandalaTab && mandalaTab.id !== undefined) {
    try {
      const tabResponse = (await browser.tabs.sendMessage(mandalaTab.id, {
        action: "query-mandala-shelves",
        url: rawUrl,
      })) as MandalaStatus | undefined;
      if (tabResponse && typeof tabResponse === "object") {
        return tabResponse;
      }
    } catch {
      // Tab may still be initializing; fall back to cache
    }
  }

  const cachedSummary = await loadCachedMandalaSummary();
  if (!cachedSummary) {
    return { connected: false, cached: false, pillars: [], savedPillarIndexes: [] };
  }
  return mandalaStatusFor(cachedSummary, rawUrl, { connected: false, cached: true });
}

async function handleSaveMandalaShelfLink(payload: {
  pillarIndex: number;
  url: string;
  title: string;
  kind?: string;
  action?: string;
}) {
  const mandalaTab = await findMandalaTab();
  if (mandalaTab && mandalaTab.id !== undefined) {
    try {
      const tabResponse = (await browser.tabs.sendMessage(mandalaTab.id, {
        action: "add-shelf-link",
        ...payload,
      })) as { success?: boolean; errorMessage?: string } | undefined;
      if (tabResponse?.success) return { success: true, queued: false };
      if (tabResponse) return { success: false, errorMessage: tabResponse.errorMessage };
    } catch {
      // Tab communication failed; fall through to queued write
    }
  }

  const pendingData = await browser.storage.local.get(PENDING_MANDALA_SHELF_LINKS_KEY);
  const existingQueue = (pendingData[PENDING_MANDALA_SHELF_LINKS_KEY] as PendingMandalaShelfLink[]) || [];
  const newEntry: PendingMandalaShelfLink = {
    id: crypto.randomUUID(),
    pillarIndex: payload.pillarIndex,
    url: payload.url,
    title: payload.title,
    kind: payload.kind,
    action: payload.action,
    timestamp: Date.now(),
  };
  await browser.storage.local.set({
    [PENDING_MANDALA_SHELF_LINKS_KEY]: [...existingQueue, newEntry],
  });

  // Until the Mandala tab flushes the queue, the cache is what the player reads its shelves from.
  const cachedSummary = await loadCachedMandalaSummary();
  if (cachedSummary) {
    const existing = shelfLinksForVideo(cachedSummary.shelfLinks, payload.url).find((link) => link.pillarIndex === payload.pillarIndex);
    await saveCachedMandalaSummary({
      ...cachedSummary,
      shelfLinks: existing
        ? cachedSummary.shelfLinks.map((link) => (link === existing && payload.action ? { ...link, action: payload.action } : link))
        : [
            ...cachedSummary.shelfLinks,
            { id: newEntry.id, pillarIndex: payload.pillarIndex, title: payload.title, url: payload.url, kind: payload.kind, action: payload.action },
          ],
    });
  }

  return { success: true, queued: true };
}

async function handleLogMandalaTime(payload: { url: string; minutes: number; videoTitle: string }) {
  const mandalaTab = await findMandalaTab();
  if (mandalaTab && mandalaTab.id !== undefined) {
    try {
      const tabResponse = (await browser.tabs.sendMessage(mandalaTab.id, {
        action: "log-time",
        ...payload,
      })) as { success?: boolean; errorMessage?: string; actionText?: string; pillarTitle?: string } | undefined;
      if (tabResponse) return { ...tabResponse, success: Boolean(tabResponse.success), queued: false, minutes: payload.minutes };
    } catch {
      // Tab communication failed; fall through to queued write
    }
  }

  const cachedSummary = await loadCachedMandalaSummary();
  if (cachedSummary && shelfLinksForVideo(cachedSummary.shelfLinks, payload.url).length === 0) {
    return { success: false, errorMessage: "Save this video to a pillar first" };
  }

  const pendingData = await browser.storage.local.get(PENDING_MANDALA_LOGS_KEY);
  const existingQueue = (pendingData[PENDING_MANDALA_LOGS_KEY] as PendingMandalaTimeLog[]) || [];
  const newEntry: PendingMandalaTimeLog = {
    id: crypto.randomUUID(),
    url: payload.url,
    minutes: payload.minutes,
    videoTitle: payload.videoTitle,
    timestamp: Date.now(),
  };
  await browser.storage.local.set({
    [PENDING_MANDALA_LOGS_KEY]: [...existingQueue, newEntry],
  });

  return { success: true, queued: true, minutes: payload.minutes };
}

interface StageQueuePayload {
  orderedTabIds: number[];
  stashDistractionTabs?: boolean;
  sessionName?: string;
  playbackSpeed?: number;
}

async function getOpenTabsCatalog() {
  await storeReady;
  const tabs = await browser.tabs.query({});
  const videoTabs = tabs.filter(
    (tab) => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url))
  );

  return videoTabs.map((tab) => {
    const rawUrl = tab.url || "";
    const normalizedUrl = normalizeYoutubeUrl(rawUrl);
    const cached = storeMetadataCache[normalizedUrl];
    const durationSeconds = cached?.seconds || 0;
    const currentTimeSeconds = cached?.currentTime || 0;
    const remainingSeconds = Math.max(0, durationSeconds - currentTimeSeconds);

    return {
      tabId: tab.id,
      windowId: tab.windowId,
      videoId: cached?.videoId ?? getVideoIdFromUrl(rawUrl),
      title: cached?.title || tab.title || "YouTube Video",
      channelName: cached?.channelName || "",
      durationSeconds,
      currentTimeSeconds,
      remainingSeconds,
      url: rawUrl,
      isLive: cached?.isLive || false,
      language: cached?.language ?? null,
      languageName: cached?.languageName ?? null,
      chapters: cached?.chapters ?? [],
      active: tab.active ?? false,
    };
  });
}

const MAX_SESSION_NAME_LENGTH = 80;

async function stageFocusedStudyQueue(payload: StageQueuePayload, sender: Browser.runtime.MessageSender) {
  const senderTabId = sender.tab?.id;
  await storeReady;

  if (!payload || !Array.isArray(payload.orderedTabIds) || payload.orderedTabIds.length === 0) {
    throw new Error("orderedTabIds must be a non-empty array of valid YouTube tab IDs.");
  }

  const hasInvalidType = payload.orderedTabIds.some(
    (tabId) => typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0
  );
  if (hasInvalidType) {
    throw new Error("All entries in orderedTabIds must be positive numeric tab IDs.");
  }

  const allTabs = await browser.tabs.query({});
  const videoTabs = allTabs.filter(
    (tab) => Boolean(tab.url && isYoutubeWatchOrShortsUrl(tab.url))
  );

  const videoTabIdSet = new Set(
    videoTabs.map((tab) => tab.id).filter((tabId): tabId is number => typeof tabId === "number")
  );

  const missingIds = payload.orderedTabIds.filter((tabId) => !videoTabIdSet.has(tabId));
  if (missingIds.length > 0) {
    throw new Error(
      `Invalid tab ID(s): ${missingIds.join(", ")}. Every ID in orderedTabIds must correspond to an open YouTube watch or shorts tab.`
    );
  }

  const orderedTabIds = payload.orderedTabIds;
  const orderedSet = new Set(orderedTabIds);

  let stashedCount = 0;
  if (payload.stashDistractionTabs) {
    const unselectedTabs = videoTabs.filter(
      (tab) => tab.id !== undefined && !orderedSet.has(tab.id)
    );

    if (unselectedTabs.length > 0) {
      const tabsToStash: SavedSessionTab[] = unselectedTabs.map((tab) => {
        const rawUrl = tab.url || "";
        const normalizedUrl = normalizeYoutubeUrl(rawUrl);
        const cached = storeMetadataCache[normalizedUrl];
        return {
          url: normalizedUrl,
          title: cached?.title || tab.title || "YouTube Video",
          channelName: cached?.channelName || "",
          seconds: cached?.seconds || 0,
          language: cached?.language ?? undefined,
          languageName: cached?.languageName ?? undefined,
        };
      });

      if (!isExtensionPageSender(sender)) {
        const approved = await requestApproval(
          buildApprovalRequest(sender, {
            title: `Close ${tabsToStash.length} YouTube ${tabsToStash.length === 1 ? "tab" : "tabs"}?`,
            summary:
              "This page wants to save these tabs as a session in Study Harvester and then close them. You can reopen them from Saved Sessions.",
            items: tabsToStash.map((tab) => tab.title || tab.url),
            confirmLabel: "Stash and close",
            destructive: true,
          })
        );
        if (!approved) throw new Error("The user declined to stash and close the other tabs.");
      }

      const sessionName =
        (typeof payload.sessionName === "string" ? payload.sessionName.trim() : "").slice(
          0,
          MAX_SESSION_NAME_LENGTH
        ) || "Stashed Backlog";
      await saveSession(sessionName, tabsToStash);
      stashedCount = tabsToStash.length;

      const tabIdsToRemove = unselectedTabs
        .map((tab) => tab.id)
        .filter((tabId): tabId is number => typeof tabId === "number");

      if (tabIdsToRemove.length > 0) {
        // One call with all IDs fails as a whole if the user closed any tab while the
        // approval window was open, so close them one by one.
        const removeTabs = () =>
          Promise.allSettled(tabIdsToRemove.map((tabId) => browser.tabs.remove(tabId)));
        const callerIsTargeted = senderTabId !== undefined && tabIdsToRemove.includes(senderTabId);
        if (callerIsTargeted) {
          setTimeout(() => void removeTabs(), 150);
        } else {
          await removeTabs();
        }
      }
    }
  }

  const firstTabId = orderedTabIds[0];
  if (firstTabId !== undefined) {
    await browser.tabs.update(firstTabId, { active: true });

    if (typeof payload.playbackSpeed === "number" && payload.playbackSpeed > 0) {
      try {
        await browser.scripting.executeScript({
          target: { tabId: firstTabId },
          // movie_player.setPlaybackRate is a page-side method, invisible from the isolated world.
          world: "MAIN",
          func: (speed: number) => {
            const video = document.querySelector("video");
            if (video) video.playbackRate = speed;
            const moviePlayer = document.getElementById("movie_player") as unknown as {
              setPlaybackRate?: (rate: number) => void;
            };
            if (typeof moviePlayer?.setPlaybackRate === "function") {
              moviePlayer.setPlaybackRate(speed);
            }
          },
          args: [payload.playbackSpeed],
        });
      } catch {
        // Tab scripting may not be permitted if tab is discarded or restricted
      }
    }
  }

  return {
    success: true,
    stashedCount,
    focusedTabId: firstTabId ?? null,
  };
}

interface TabToSync {
  id: number;
  url: string;
}

const CACHE_FRESH_MAX_AGE_MS = 10 * 60 * 1000;
const LANGUAGE_CACHE_MAX_AGE_MS = 60 * 60 * 1000;
const SYNC_CONCURRENCY = 3;
const SYNC_DELAY_BETWEEN_REQUESTS_MS = 500;
const SYNC_IN_PROGRESS = new Set<string>();

interface ParsedPlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    isLive?: boolean;
    lengthSeconds?: string;
    defaultAudioLanguageCode?: string;
    defaultLanguage?: string;
    shortDescription?: string;
  };
  microformat?: {
    playerMicroformatRenderer?: {
      liveBroadcastDetails?: { endTimestamp?: string };
      defaultLanguage?: string;
      defaultAudioLanguage?: string;
    };
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{ kind?: string; languageCode?: string; name?: { simpleText?: string } }>;
    };
  };
}

function parseMetadataFromHtml(html: string): {
  duration: number;
  title: string;
  channel: string;
  isLive: boolean;
  syncedVideoId: string | null;
  detectedLanguage: DetectedLanguage;
  languageText: string;
  uiLanguage: string | null;
  chapters: VideoChapter[];
} {
  let duration = 0;
  let title = "";
  let channel = "";
  let isLive = false;
  let syncedVideoId: string | null = null;
  let detectedLanguage: DetectedLanguage = { language: null, languageName: null };
  let languageText = "";
  let chapters: VideoChapter[] = [];

  const playerResponseMatch =
    html.match(/var ytInitialPlayerResponse\s*=\s*({.+?});/s) ||
    html.match(/window\["ytInitialPlayerResponse"\]\s*=\s*({.+?});/s);
  if (playerResponseMatch) {
    try {
      const playerResponse = JSON.parse(playerResponseMatch[1]) as ParsedPlayerResponse;
      const videoDetails = playerResponse.videoDetails;
      if (videoDetails) {
        syncedVideoId = videoDetails.videoId ?? null;
        title = videoDetails.title || "";
        channel = videoDetails.author || "";
        isLive = videoDetails.isLive === true;
        const liveDetails = playerResponse.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
        if (liveDetails && !liveDetails.endTimestamp) isLive = true;
        const lengthSeconds = parseInt(videoDetails.lengthSeconds ?? "", 10) || 0;
        if (lengthSeconds > 0) {
          isLive = false;
          duration = lengthSeconds;
        }
      }

      detectedLanguage = detectLanguageFromPlayerResponse(playerResponse);
      languageText = languageTextFromPlayerResponse(playerResponse);
      chapters = extractChaptersFromPlayerResponse(playerResponse, isLive ? 0 : duration);
    } catch (_) {}
  }
  if (duration === 0) {
    const durationMatch = html.match(/"approxDurationMs"\s*:\s*"?(\d+)"?/);
    duration = durationMatch ? parseInt(durationMatch[1], 10) / 1000 : 0;
  }
  if (!title) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/);
    title = titleMatch ? titleMatch[1].replace(" - YouTube", "").trim() : "";
  }
  if (!channel) {
    const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/) || html.match(/"ownerChannelName"\s*:\s*"([^"]+)"/);
    channel = authorMatch ? authorMatch[1] : "";
  }

  return {
    duration,
    title,
    channel,
    isLive,
    syncedVideoId,
    detectedLanguage,
    languageText,
    uiLanguage: html.match(/<html[^>]*\slang="([^"]+)"/)?.[1] ?? null,
    chapters,
  };
}

async function fetchOneTab(tab: TabToSync): Promise<boolean> {
  const normalizedUrl = normalizeYoutubeUrl(tab.url);
  if (SYNC_IN_PROGRESS.has(normalizedUrl)) return false;
  SYNC_IN_PROGRESS.add(normalizedUrl);
  try {
    const response = await fetch(tab.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (response.url.includes("google.com/sorry") || response.url.includes("youtube.com/sorry")) {
      browser.runtime.sendMessage({ action: "sync-error", message: "Rate limited by YouTube" }).catch(() => {});
      return true;
    }
    const html = await response.text();
    if (html.includes("consent.youtube.com")) return false;
    const {
      duration,
      title,
      channel,
      isLive,
      syncedVideoId,
      detectedLanguage,
      languageText,
      uiLanguage,
      chapters,
    } = parseMetadataFromHtml(html);
    const { language, languageName } = await resolveVideoLanguage(
      detectedLanguage,
      languageText,
      { channelName: channel, videoId: syncedVideoId },
      uiLanguage
    );
    const avatar = channel ? avatarFromWatchHtml(html) : null;
    if (avatar) void recordChannelAvatar(channel, avatar);
    if (duration > 0 || title || isLive) {
      const metadata: Omit<CachedMetadata, "timestamp"> = {
        seconds: duration,
        title: title || "YouTube Video",
        channelName: channel || "",
        currentTime: 0,
        isLive,
        videoId: syncedVideoId ?? undefined,
        language,
        languageName,
        chapters: chapters.length > 0 ? chapters : undefined,
      };
      pendingCacheUpdates.set(normalizedUrl, { url: tab.url, metadata });
      scheduleFlush();
      browser.runtime.sendMessage({ action: "tab-synced", tabId: tab.id, metadata }).catch(() => {});
    }
  } catch (error) {
    console.error(`[Background] Error fetching ${tab.url}:`, error);
  } finally {
    SYNC_IN_PROGRESS.delete(normalizedUrl);
  }
  return false;
}

async function handleStealthSync(tabs: TabToSync[]) {
  await storeReady;
  const cache = storeMetadataCache;
  const toFetch: TabToSync[] = [];

  for (const tab of tabs) {
    const normalizedUrl = normalizeYoutubeUrl(tab.url);
    const cached = cache[normalizedUrl];
    const hasValidCoreCache =
      cached && (cached.seconds > 0 || cached.isLive) && cached.title;
    const cacheFresh =
      cached?.timestamp != null && Date.now() - cached.timestamp < CACHE_FRESH_MAX_AGE_MS;
    const languageFresh =
      cached?.language !== undefined &&
      cached.timestamp != null &&
      Date.now() - cached.timestamp < LANGUAGE_CACHE_MAX_AGE_MS;
    if (hasValidCoreCache && cacheFresh && languageFresh) {
      browser.runtime
        .sendMessage({
          action: "tab-synced",
          tabId: tab.id,
          metadata: {
            seconds: cached.seconds ?? 0,
            title: cached.title ?? "",
            channelName: cached.channelName ?? "",
            isLive: cached.isLive ?? false,
            language: cached.language,
            languageName: cached.languageName,
          },
        })
        .catch(() => {});
      continue;
    }
    toFetch.push(tab);
  }

  let rateLimited = false;
  for (let i = 0; i < toFetch.length && !rateLimited; i += SYNC_CONCURRENCY) {
    const chunk = toFetch.slice(i, i + SYNC_CONCURRENCY);
    const results = await Promise.all(chunk.map((tab) => fetchOneTab(tab)));
    if (results.some((result) => result)) rateLimited = true;
    if (i + SYNC_CONCURRENCY < toFetch.length) {
      await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY_BETWEEN_REQUESTS_MS));
    }
  }

  browser.runtime.sendMessage({ action: "sync-complete" }).catch(() => {});
}
