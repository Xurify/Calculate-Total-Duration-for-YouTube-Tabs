import { getLiveTabSections, loadCachedMandalaSummary, type CachedMandalaSummary, type LiveTabSectionsState } from "./storage";
import {
  closeStaleEntries,
  DEFAULT_TIME_TRACKING_PREFS,
  isTrackableUrl,
  loadSiteRules,
  loadTimeLog,
  loadTimeTrackingPrefs,
  matchRules,
  pendingForMandala,
  pillarColor,
  recordStretch,
  saveTimeLog,
  summarize,
  TIME_TRACKING_PREFS_KEY,
  SITE_RULES_KEY,
  type RuleMatch,
  type SiteRule,
  type TimeEntry,
  type TimeMode,
  type TimeTrackingPrefs,
} from "./timeLog";
import { CACHED_MANDALA_SUMMARY_KEY } from "./storage";

/**
 * Measures time on pages from the background, with no script on the page: the focused tab counts as
 * active while the person is not idle, and a tab making sound elsewhere counts as passive. Each stretch
 * is closed on every change and once a minute, so a service worker that is put to sleep loses at most a
 * minute. Only stretches a rule places on a pillar reach the log.
 */

interface OpenStretch {
  tabId: number;
  url: string;
  title: string;
  since: number;
  mode: TimeMode;
}

interface TrackerState {
  active: OpenStretch | null;
  passive: Record<string, OpenStretch>;
  idle: boolean;
}

const STATE_KEY = "siteTrackerState";
const TICK_ALARM = "site-tracker-tick";
/** A stretch longer than this had no tick in between, so the browser was shut: it ends at its last known minute. */
const MAX_STRETCH_MS = 10 * 60_000;
const LIVE_TAB_SECTIONS_KEY = "liveTabSections";

export function isMandalaUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === "mandalamethod.vercel.app" || (import.meta.env.DEV && parsed.host === "localhost:5173");
  } catch {
    return false;
  }
}

type SessionStorageArea = { get(key: string): Promise<Record<string, unknown>>; set(items: Record<string, unknown>): Promise<void> };

/** Cleared when the browser closes, so a stretch never outlives the session it started in. */
function sessionStorage(): SessionStorageArea | null {
  const storage = browser.storage as unknown as { session?: SessionStorageArea };
  return storage.session ?? null;
}

function toolbarButton() {
  const api = browser as unknown as { action?: typeof browser.action; browserAction?: typeof browser.action };
  return api.action ?? api.browserAction ?? null;
}

export class SiteTracker {
  #state: TrackerState = { active: null, passive: {}, idle: false };
  #prefs: TimeTrackingPrefs = { ...DEFAULT_TIME_TRACKING_PREFS };
  #rules: SiteRule[] = [];
  #summary: CachedMandalaSummary | null = null;
  #piles: LiveTabSectionsState | null = null;
  #log: TimeEntry[] | null = null;
  #ready: Promise<void>;
  #queue: Promise<void> = Promise.resolve();
  #pendingCountLastNotified = 0;
  #notifyPending: () => void;

  constructor(notifyPending: () => void) {
    this.#notifyPending = notifyPending;
    this.#ready = this.#restore();
  }

  async #restore(): Promise<void> {
    await this.#loadSettings();
    const area = sessionStorage();
    if (!area) return;
    const saved = (await area.get(STATE_KEY))[STATE_KEY] as TrackerState | undefined;
    if (saved && typeof saved === "object") this.#state = { active: saved.active ?? null, passive: saved.passive ?? {}, idle: Boolean(saved.idle) };
  }

  async #loadSettings(): Promise<void> {
    [this.#prefs, this.#rules, this.#summary, this.#piles] = await Promise.all([loadTimeTrackingPrefs(), loadSiteRules(), loadCachedMandalaSummary(), getLiveTabSections()]);
  }

  /** Runs tracker work one piece at a time, so two events never read and write the log at once. */
  #enqueue(work: () => Promise<void>): Promise<void> {
    this.#queue = this.#queue.then(() => this.#ready).then(work, work).catch((error) => console.warn("[Study Harvester] time tracker:", error));
    return this.#queue;
  }

  start(): void {
    browser.tabs.onActivated.addListener(() => void this.#enqueue(() => this.#refreshActive(Date.now())));
    browser.windows.onFocusChanged.addListener(() => void this.#enqueue(() => this.#refreshActive(Date.now())));
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url === undefined && changeInfo.audible === undefined && changeInfo.title === undefined && changeInfo.mutedInfo === undefined) return;
      void this.#enqueue(() => this.#tabChanged(tabId, tab, Date.now()));
    });
    browser.tabs.onRemoved.addListener((tabId) => void this.#enqueue(() => this.#tabClosed(tabId, Date.now())));
    if (browser.idle) {
      browser.idle.onStateChanged.addListener((state) => void this.#enqueue(() => this.#idleChanged(state !== "active", Date.now())));
    }
    browser.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === TICK_ALARM) void this.#enqueue(() => this.#tick(Date.now()));
    });
    browser.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[SITE_RULES_KEY] || changes[CACHED_MANDALA_SUMMARY_KEY] || changes[LIVE_TAB_SECTIONS_KEY] || changes[TIME_TRACKING_PREFS_KEY]) {
        void this.#enqueue(() => this.#settingsChanged());
      }
    });
    void this.#enqueue(async () => {
      await this.#applyPrefs();
      await this.#refreshActive(Date.now());
      await this.#refreshPassive(Date.now());
    });
  }

  async #applyPrefs(): Promise<void> {
    if (!this.#prefs.enabled) {
      await browser.alarms.clear(TICK_ALARM);
      return;
    }
    const existing = await browser.alarms.get(TICK_ALARM);
    if (!existing) await browser.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
    if (browser.idle) browser.idle.setDetectionInterval(Math.max(15, this.#prefs.idleSeconds));
  }

  async #settingsChanged(): Promise<void> {
    const wasEnabled = this.#prefs.enabled;
    await this.#loadSettings();
    await this.#applyPrefs();
    const now = Date.now();
    if (wasEnabled && !this.#prefs.enabled) await this.#closeAll(now);
    else await this.#tick(now);
    await this.#updateBadge();
  }

  matchFor(url: string): RuleMatch | null {
    return matchRules(url, this.#rules, this.#summary, this.#piles);
  }

  async #getLog(): Promise<TimeEntry[]> {
    if (!this.#log) this.#log = await loadTimeLog();
    return this.#log;
  }

  async #persistState(): Promise<void> {
    await sessionStorage()?.set({ [STATE_KEY]: this.#state });
  }

  async #focusedTab(): Promise<Browser.tabs.Tab | null> {
    try {
      const window = await browser.windows.getLastFocused({ populate: true });
      if (!window.focused) return null;
      return window.tabs?.find((tab) => tab.active) ?? null;
    } catch {
      return null;
    }
  }

  async #refreshActive(now: number): Promise<void> {
    if (!this.#prefs.enabled) return;
    const tab = await this.#focusedTab();
    const current = this.#state.active;
    const same = tab && current && tab.id === current.tabId && tab.url && current.url === tab.url;
    if (same) {
      if (tab.title && tab.title !== current.title) current.title = tab.title;
      await this.#persistState();
      await this.#updateBadge();
      return;
    }
    await this.#closeActive(now);
    if (tab && tab.id !== undefined && isTrackableUrl(tab.url) && !this.#state.idle) {
      const passiveKey = String(tab.id);
      if (this.#state.passive[passiveKey]) await this.#closePassive(passiveKey, now);
      this.#state.active = { tabId: tab.id, url: tab.url, title: tab.title ?? "", since: now, mode: "active" };
    }
    await this.#persistState();
    await this.#updateBadge();
  }

  async #refreshPassive(now: number): Promise<void> {
    if (!this.#prefs.enabled) return;
    const audible = await browser.tabs.query({ audible: true });
    const wanted = new Map(audible.filter((tab) => tab.id !== undefined && !tab.mutedInfo?.muted && isTrackableUrl(tab.url)).map((tab) => [String(tab.id), tab]));
    for (const key of Object.keys(this.#state.passive)) {
      const tab = wanted.get(key);
      if (!tab || tab.url !== this.#state.passive[key].url) await this.#closePassive(key, now);
    }
    for (const [key, tab] of wanted) {
      if (this.#state.active?.tabId === tab.id) continue;
      if (!this.#state.passive[key]) this.#state.passive[key] = { tabId: tab.id!, url: tab.url!, title: tab.title ?? "", since: now, mode: "passive" };
    }
    await this.#persistState();
  }

  async #tabChanged(tabId: number, tab: Browser.tabs.Tab, now: number): Promise<void> {
    if (!this.#prefs.enabled) return;
    if (tab.active || this.#state.active?.tabId === tabId) {
      await this.#refreshActive(now);
      return;
    }
    const key = String(tabId);
    const sounding = Boolean(tab.audible) && !tab.mutedInfo?.muted && isTrackableUrl(tab.url);
    const open = this.#state.passive[key];
    if (open && (!sounding || tab.url !== open.url)) await this.#closePassive(key, now);
    if (sounding && !this.#state.passive[key]) this.#state.passive[key] = { tabId, url: tab.url!, title: tab.title ?? "", since: now, mode: "passive" };
    else if (sounding && tab.title) this.#state.passive[key].title = tab.title;
    await this.#persistState();
  }

  async #tabClosed(tabId: number, now: number): Promise<void> {
    if (this.#state.active?.tabId === tabId) await this.#closeActive(now);
    const key = String(tabId);
    if (this.#state.passive[key]) await this.#closePassive(key, now);
    await this.#persistState();
    await this.#saveLogAndNotify();
  }

  async #idleChanged(idle: boolean, now: number): Promise<void> {
    if (this.#state.idle === idle) return;
    this.#state.idle = idle;
    if (idle) {
      const active = this.#state.active;
      await this.#closeActive(now);
      // Sound keeps playing while the person is away, and that is what passive time is.
      if (active) {
        try {
          const tab = await browser.tabs.get(active.tabId);
          if (tab.audible && !tab.mutedInfo?.muted) this.#state.passive[String(active.tabId)] = { ...active, since: now, mode: "passive" };
        } catch {}
      }
      await this.#persistState();
      await this.#saveLogAndNotify();
    } else {
      await this.#refreshActive(now);
    }
  }

  async #tick(now: number): Promise<void> {
    if (!this.#prefs.enabled) return;
    const active = this.#state.active;
    if (active) {
      await this.#closeActive(now);
      this.#state.active = { ...active, since: now };
    }
    for (const key of Object.keys(this.#state.passive)) {
      const stretch = this.#state.passive[key];
      await this.#closePassive(key, now);
      this.#state.passive[key] = { ...stretch, since: now };
    }
    await this.#persistState();
    await this.#refreshActive(now);
    await this.#refreshPassive(now);
    const log = await this.#getLog();
    if (closeStaleEntries(log, now)) await this.#saveLogAndNotify();
  }

  async #closeAll(now: number): Promise<void> {
    await this.#closeActive(now);
    for (const key of Object.keys(this.#state.passive)) await this.#closePassive(key, now);
    await this.#persistState();
    await this.#saveLogAndNotify();
  }

  async #closeActive(now: number): Promise<void> {
    const stretch = this.#state.active;
    if (!stretch) return;
    this.#state.active = null;
    await this.#logStretch(stretch, now);
  }

  async #closePassive(key: string, now: number): Promise<void> {
    const stretch = this.#state.passive[key];
    if (!stretch) return;
    delete this.#state.passive[key];
    await this.#logStretch(stretch, now);
  }

  async #logStretch(stretch: OpenStretch, now: number): Promise<void> {
    const endedAt = Math.min(now, stretch.since + MAX_STRETCH_MS);
    if (endedAt <= stretch.since) return;
    const match = this.matchFor(stretch.url);
    if (!match) return;
    const log = await this.#getLog();
    recordStretch(log, { url: stretch.url, title: stretch.title, startedAt: stretch.since, endedAt, mode: stretch.mode, match });
    await saveTimeLog(log);
  }

  async #saveLogAndNotify(): Promise<void> {
    const log = await this.#getLog();
    await saveTimeLog(log);
    const pending = pendingForMandala(log).length;
    if (pending > 0 && pending !== this.#pendingCountLastNotified) this.#notifyPending();
    this.#pendingCountLastNotified = pending;
  }

  async #updateBadge(): Promise<void> {
    const api = toolbarButton();
    if (!api) return;
    const active = this.#state.active;
    if (!active) return;
    const match = this.#prefs.enabled ? this.matchFor(active.url) : null;
    try {
      if (!match) {
        await api.setBadgeText({ text: "", tabId: active.tabId });
        await api.setTitle({ title: "Study Harvester", tabId: active.tabId });
        return;
      }
      const today = summarize(await this.#getLog(), 1).byPillar[match.pillarIndex];
      const running = Math.round((Date.now() - active.since) / 1000);
      const activeMinutes = Math.floor((today.active + running) / 60);
      const passiveMinutes = Math.floor(today.passive / 60);
      const pillar = this.#summary?.pillars.find((each) => each.index === match.pillarIndex)?.title || `Pillar ${match.pillarIndex + 1}`;
      await api.setBadgeBackgroundColor({ color: pillarColor(match.pillarIndex), tabId: active.tabId });
      await api.setBadgeText({ text: activeMinutes >= 100 ? `${Math.floor(activeMinutes / 60)}h` : String(activeMinutes), tabId: active.tabId });
      await api.setTitle({
        title: `${pillar} · ${activeMinutes} min today${passiveMinutes > 0 ? ` (+${passiveMinutes} min in the background)` : ""}`,
        tabId: active.tabId,
      });
    } catch {
      // The tab is gone, or the badge is not available here.
    }
  }

  /** Where a tab's time goes, and how much went there today, for the popup and the player. */
  async describeTab(tabId: number | undefined, url: string | undefined): Promise<{ match: RuleMatch | null; todayMinutes: number; runningSeconds: number }> {
    await this.#ready;
    const match = url && this.#prefs.enabled ? this.matchFor(url) : null;
    if (!match) return { match: null, todayMinutes: 0, runningSeconds: 0 };
    const today = summarize(await this.#getLog(), 1).byPillar[match.pillarIndex];
    const active = this.#state.active;
    const running = active && active.tabId === tabId ? Math.round((Date.now() - active.since) / 1000) : 0;
    return { match, todayMinutes: Math.floor((today.active + today.passive + running) / 60), runningSeconds: running };
  }

  /** Read back from storage inside the queue, so a reader sees every write that came before it. */
  async #readLog(): Promise<TimeEntry[]> {
    let log: TimeEntry[] = [];
    await this.#enqueue(async () => {
      this.#log = await loadTimeLog();
      log = [...this.#log];
    });
    return log;
  }

  entries(): Promise<TimeEntry[]> {
    return this.#readLog();
  }

  async pending(): Promise<TimeEntry[]> {
    return pendingForMandala(await this.#readLog());
  }

  markSynced(logged: readonly string[], known: readonly string[], skipped: readonly { id: string; reason: string }[]): Promise<void> {
    return this.#enqueue(async () => {
      const log = await this.#getLog();
      const done = new Set([...logged, ...known]);
      const reasons = new Map(skipped.map((skip) => [skip.id, skip.reason]));
      for (const entry of log) {
        if (done.has(entry.id)) {
          entry.sync = "done";
          delete entry.syncNote;
        } else if (reasons.has(entry.id)) {
          entry.sync = "skipped";
          entry.syncNote = reasons.get(entry.id);
        }
      }
      await saveTimeLog(log);
      this.#pendingCountLastNotified = pendingForMandala(log).length;
    });
  }

  /** After a rule or the chart changed, what Mandala skipped may land now. */
  retrySkipped(): Promise<void> {
    return this.#enqueue(async () => {
      const log = await this.#getLog();
      for (const entry of log) if (entry.sync === "skipped") entry.sync = "pending";
      await this.#saveLogAndNotify();
    });
  }

  clear(): Promise<void> {
    return this.#enqueue(async () => {
      this.#log = [];
      await saveTimeLog([]);
      this.#pendingCountLastNotified = 0;
      await this.#updateBadge();
    });
  }
}
