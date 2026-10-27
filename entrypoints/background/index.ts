import {
  normalizeYoutubeUrl,
  loadCachedMandalaSummary,
  saveStagedClozeCard,
  loadStagedClozeCards,
  type CachedMetadata,
  type UserPrefs,
  type StagedClozeCard,
} from "../../utils/storage";
import { resolveVideoLanguage } from "../../utils/channelLanguage";
import { RESOLVE_LANGUAGE_ACTION, type ResolveLanguageMessage } from "../../utils/languageRequest";
import { queryReadingList, removeReadingListItemById } from "../../utils/readingList";
import {
  buildApprovalRequest,
  ensureReadGrant,
  handleApprovalPageMessage,
  isExtensionPageSender,
  requestApproval,
} from "../../utils/approvals";
import { isMandalaUrl } from "../../utils/siteTracker";
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
} from "../../utils/timeLog";
import { getLiveTabSections } from "../../utils/storage";
import { loadChannelAvatars, recordChannelAvatars } from "../../utils/channelAvatars";
import { goalStreaks } from "../../utils/goals";
import { watchCsv, watchEntriesSince, CSV_COLUMNS, type CsvColumn } from "../../utils/watchCsv";
import {
  cleanLanguageLimits,
  languageTodayRows,
  limitUsage,
  loadLanguageLimits,
  saveLanguageLimits,
} from "../../utils/languageLimits";
import { cleanWatchSample, saveWatchLog, summarizeWatch } from "../../utils/watchLog";
import { loadLanguageOverrides } from "../../utils/languageOverrides";
import { languageHoursRows, loadLanguageHours, saveLanguageHours, setEarlierHours } from "../../utils/languageHours";
import {
  loadListeningLog,
  recordCheck,
  saveListeningLog,
  summarizeListening,
  type CheckResult,
} from "../../utils/listening";
import {
  cleanBank,
  editSentences,
  loadSentenceBank,
  reviewSentence,
  saveSentenceBank,
  type ReviewGrade,
} from "../../utils/sentenceBank";
import { fillChannelAvatars } from "./avatars";
import {
  broadcastToClozemasterTabs,
  cleanEdits,
  ClozemasterRemoteError,
  type ClozemasterRemoteMessage,
  findClozemasterCollectionUrls,
  handleClozemasterRemote,
  sendBankToClozemaster,
  visitedClozemasterPairs,
} from "./clozemaster";
import { openDesk } from "./desk";
import {
  handleCheckMandalaStatus,
  handleLogMandalaTime,
  handleMandalaRemote,
  handleSaveMandalaShelfLink,
  type MandalaRemoteMessage,
} from "./mandala";
import { addSentenceToBank, clearStagedCards, playClip, videoLanguageLabel, withPracticeStore } from "./practice";
import { getSavedSessionsCatalog, openSavedSession, type OpenSessionPayload } from "./sessions";
import {
  clearMetadataCacheInStore,
  patchPrefs,
  pendingCacheUpdates,
  scheduleFlush,
  storeMetadataCache,
  storePrefs,
  storeReady,
} from "./store";
import { getOpenTabsCatalog, stageFocusedStudyQueue, type StageQueuePayload } from "./study-queue";
import { handleStealthSync, type TabToSync } from "./sync";
import { fillMissingWatchLanguages, recordWatch, siteTracker, withWatchLog } from "./watch-log";

export default defineBackground(() => {
  siteTracker.start();

  browser.commands.onCommand.addListener((command) => {
    if (command === "open-desk") void openDesk();
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (handleApprovalPageMessage(message, sender, sendResponse)) {
      return true;
    }

    if (message.action === "get-language-today") {
      void Promise.all([withWatchLog((log) => [...log]), loadLanguageLimits(), loadLanguageOverrides()])
        .then(([log, limits, overrides]) => sendResponse({ rows: languageTodayRows(limits, log, Date.now(), overrides, 6) }))
        .catch(() => sendResponse({ rows: [] }));
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
