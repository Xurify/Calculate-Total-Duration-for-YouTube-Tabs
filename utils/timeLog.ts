import { getVideoIdFromUrl } from "./format";
import {
  normalizeYoutubeUrl,
  shelfLinksForVideo,
  type CachedMandalaSummary,
  type LiveTabSectionsState,
} from "./storage";
import { newTypeId } from "./typeId";

/**
 * Time on a page, measured by the background tracker and kept here. Only time on a page that a rule
 * places on a Mandala pillar is kept; everything else is dropped on the spot, never stored, so the log is
 * study time and not browsing history.
 */

export type TimeMode = "active" | "passive";

export type SiteRuleKind = "host" | "prefix" | "pile";

export interface SiteRule {
  id: string;
  kind: SiteRuleKind;
  /** A host ("clozemaster.com"), a URL prefix ("https://slovake.eu/en/learning/"), or a pile's section id. */
  pattern: string;
  /** What the pattern reads as, for lists: the pile's name, else the pattern itself. */
  label: string;
  pillarIndex: number;
  /** A Mandala action id. Without one, Mandala picks the pillar's routine. */
  actionId?: string;
  createdAt: number;
}

export type MatchSource = "shelf" | SiteRuleKind;

export interface RuleMatch {
  source: MatchSource;
  pillarIndex: number;
  actionId?: string;
  /** The shelf link's Mandala id, when matched by shelf. */
  linkId?: string;
  ruleId?: string;
}

export type SyncState = "pending" | "done" | "skipped";

export interface TimeEntry {
  /** A `session_` TypeID, the id Mandala logs it under. */
  id: string;
  host: string;
  url: string;
  title: string;
  startedAt: number;
  endedAt: number;
  seconds: number;
  mode: TimeMode;
  source: MatchSource;
  pillarIndex: number;
  actionId?: string;
  linkId?: string;
  ruleId?: string;
  /** Still growing: the next stretch on the same page may extend it. */
  open: boolean;
  sync: SyncState;
  syncNote?: string;
}

export interface TimeTrackingPrefs {
  enabled: boolean;
  /** Seconds without input before the active tab stops counting. */
  idleSeconds: number;
}

export const SITE_RULES_KEY = "siteRules";
export const TIME_LOG_KEY = "timeLog";
export const TIME_TRACKING_PREFS_KEY = "timeTrackingPrefs";

export const DEFAULT_TIME_TRACKING_PREFS: TimeTrackingPrefs = { enabled: true, idleSeconds: 60 };

/** A stretch shorter than this is noise: a tab passed through on the way somewhere else. */
export const MIN_STRETCH_SECONDS = 5;
/** Two stretches on one page closer than this are one session. */
export const MERGE_GAP_MS = 2 * 60_000;
export const KEEP_DAYS = 90;
export const MAX_ENTRIES = 5000;

/** Mandala's pillar hues, as colours a badge and a bar can use. */
export const PILLAR_COLORS = ["#c4513f", "#b8860b", "#6b8e23", "#2e8b57", "#2a8077", "#3a6fb0", "#7b5aa6", "#b3476a"] as const;

export function pillarColor(pillarIndex: number): string {
  return PILLAR_COLORS[((pillarIndex % 8) + 8) % 8];
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Pages that can never count: the browser's own, the extension's own, blank tabs. */
export function isTrackableUrl(url: string | undefined): url is string {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/** The page as the log and the rules see it: no hash, and one address per YouTube video. */
export function normalizePageUrl(url: string): string {
  const youtube = normalizeYoutubeUrl(url);
  if (youtube !== url) return youtube;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

/** A prefix rule matches the page's address without query or hash, so it reads as "this page and what is under it". */
export function pagePrefixOf(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function hostMatches(host: string, pattern: string): boolean {
  const wanted = pattern.toLowerCase().replace(/^www\./, "");
  return host === wanted || host.endsWith(`.${wanted}`);
}

export function matchRules(
  url: string,
  rules: readonly SiteRule[],
  summary: CachedMandalaSummary | null,
  piles: LiveTabSectionsState | null
): RuleMatch | null {
  const normalized = normalizePageUrl(url);
  const host = hostOf(normalized);
  if (!host) return null;

  if (summary) {
    const exact =
      summary.shelfLinks.find((link) => normalizePageUrl(link.url) === normalized) ?? shelfLinksForVideo(summary.shelfLinks, normalized)[0];
    if (exact) return { source: "shelf", pillarIndex: exact.pillarIndex, actionId: exact.action, linkId: exact.id };
  }

  const prefixRules = rules
    .filter((rule) => rule.kind === "prefix" && normalized.startsWith(rule.pattern))
    .sort((first, second) => second.pattern.length - first.pattern.length);
  if (prefixRules[0]) return ruleMatch(prefixRules[0]);

  const hostRule = rules.find((rule) => rule.kind === "host" && hostMatches(host, rule.pattern));
  if (hostRule) return ruleMatch(hostRule);

  if (piles && getVideoIdFromUrl(normalized)) {
    const sectionId = piles.assignments[normalized];
    const pileRule = sectionId ? rules.find((rule) => rule.kind === "pile" && rule.pattern === sectionId) : undefined;
    if (pileRule) return ruleMatch(pileRule);
  }

  return null;
}

function ruleMatch(rule: SiteRule): RuleMatch {
  return { source: rule.kind, pillarIndex: rule.pillarIndex, actionId: rule.actionId, ruleId: rule.id };
}

export async function loadSiteRules(): Promise<SiteRule[]> {
  if (!browser.storage?.local) return [];
  const data = await browser.storage.local.get(SITE_RULES_KEY);
  const raw = data[SITE_RULES_KEY];
  return Array.isArray(raw) ? (raw as SiteRule[]).filter(isSiteRule) : [];
}

function isSiteRule(value: unknown): value is SiteRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as SiteRule;
  return (
    typeof rule.id === "string" &&
    (rule.kind === "host" || rule.kind === "prefix" || rule.kind === "pile") &&
    typeof rule.pattern === "string" &&
    Number.isInteger(rule.pillarIndex) &&
    rule.pillarIndex >= 0 &&
    rule.pillarIndex < 8
  );
}

export async function saveSiteRules(rules: SiteRule[]): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [SITE_RULES_KEY]: rules });
}

/** One rule per pattern: setting a pattern again replaces what it pointed at. */
export async function upsertSiteRule(input: Omit<SiteRule, "id" | "createdAt"> & { id?: string }): Promise<SiteRule> {
  const rules = await loadSiteRules();
  const existing = rules.find((rule) => rule.id === input.id || (rule.kind === input.kind && rule.pattern === input.pattern));
  const rule: SiteRule = {
    id: existing?.id ?? newTypeId("rule"),
    kind: input.kind,
    pattern: input.pattern,
    label: input.label,
    pillarIndex: input.pillarIndex,
    actionId: input.actionId,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  await saveSiteRules([...rules.filter((each) => each.id !== rule.id), rule]);
  return rule;
}

export async function removeSiteRule(id: string): Promise<void> {
  const rules = await loadSiteRules();
  await saveSiteRules(rules.filter((rule) => rule.id !== id));
}

export async function loadTimeTrackingPrefs(): Promise<TimeTrackingPrefs> {
  if (!browser.storage?.local) return { ...DEFAULT_TIME_TRACKING_PREFS };
  const data = await browser.storage.local.get(TIME_TRACKING_PREFS_KEY);
  const raw = data[TIME_TRACKING_PREFS_KEY] as Partial<TimeTrackingPrefs> | undefined;
  return {
    enabled: raw?.enabled ?? DEFAULT_TIME_TRACKING_PREFS.enabled,
    idleSeconds:
      typeof raw?.idleSeconds === "number" && raw.idleSeconds >= 15 ? Math.floor(raw.idleSeconds) : DEFAULT_TIME_TRACKING_PREFS.idleSeconds,
  };
}

export async function saveTimeTrackingPrefs(prefs: TimeTrackingPrefs): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [TIME_TRACKING_PREFS_KEY]: prefs });
}

export async function loadTimeLog(): Promise<TimeEntry[]> {
  if (!browser.storage?.local) return [];
  const data = await browser.storage.local.get(TIME_LOG_KEY);
  const raw = data[TIME_LOG_KEY];
  return Array.isArray(raw) ? (raw as TimeEntry[]) : [];
}

export async function saveTimeLog(entries: TimeEntry[]): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [TIME_LOG_KEY]: trimTimeLog(entries) });
}

export function trimTimeLog(entries: TimeEntry[], now: number = Date.now()): TimeEntry[] {
  const floor = now - KEEP_DAYS * 86_400_000;
  const kept = entries.filter((entry) => entry.endedAt >= floor).sort((first, second) => first.startedAt - second.startedAt);
  return kept.length > MAX_ENTRIES ? kept.slice(kept.length - MAX_ENTRIES) : kept;
}

export async function clearTimeLog(): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ [TIME_LOG_KEY]: [] });
}

export interface Stretch {
  url: string;
  title: string;
  startedAt: number;
  endedAt: number;
  mode: TimeMode;
  match: RuleMatch;
}

/**
 * Adds a measured stretch to the log. A stretch on the same page, in the same mode, that follows an open
 * entry within the merge gap extends it; anything else starts an entry. Returns the log, changed in place.
 */
export function recordStretch(entries: TimeEntry[], stretch: Stretch): TimeEntry[] {
  const seconds = Math.round((stretch.endedAt - stretch.startedAt) / 1000);
  if (seconds < MIN_STRETCH_SECONDS) return entries;
  const url = normalizePageUrl(stretch.url);
  const last = [...entries].reverse().find((entry) => entry.open && entry.url === url && entry.mode === stretch.mode);
  if (last && stretch.startedAt - last.endedAt <= MERGE_GAP_MS && samePlace(last, stretch.match)) {
    last.endedAt = stretch.endedAt;
    last.seconds += seconds;
    if (stretch.title) last.title = stretch.title;
    return entries;
  }
  if (last) last.open = false;
  entries.push({
    id: newTypeId("session", stretch.startedAt),
    host: hostOf(url),
    url,
    title: stretch.title,
    startedAt: stretch.startedAt,
    endedAt: stretch.endedAt,
    seconds,
    mode: stretch.mode,
    source: stretch.match.source,
    pillarIndex: stretch.match.pillarIndex,
    actionId: stretch.match.actionId,
    linkId: stretch.match.linkId,
    ruleId: stretch.match.ruleId,
    open: true,
    sync: "pending",
  });
  return entries;
}

function samePlace(entry: TimeEntry, match: RuleMatch): boolean {
  return entry.pillarIndex === match.pillarIndex && entry.actionId === match.actionId && entry.linkId === match.linkId;
}

/** Closes entries nothing has extended for a merge gap, so they can go to Mandala. */
export function closeStaleEntries(entries: TimeEntry[], now: number = Date.now()): boolean {
  let changed = false;
  for (const entry of entries) {
    if (entry.open && now - entry.endedAt > MERGE_GAP_MS) {
      entry.open = false;
      changed = true;
    }
  }
  return changed;
}

export function wholeMinutes(entry: TimeEntry): number {
  return Math.floor(entry.seconds / 60);
}

/** Closed entries of a minute or more that Mandala has not logged yet. */
export function pendingForMandala(entries: readonly TimeEntry[]): TimeEntry[] {
  return entries.filter((entry) => !entry.open && entry.sync === "pending" && wholeMinutes(entry) >= 1);
}

export function dateKeyOf(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface TimeTotals {
  active: number;
  passive: number;
}

export interface TimeSummary {
  /** Local date keys, oldest first, with seconds per day. */
  days: { key: string; active: number; passive: number }[];
  byPillar: TimeTotals[];
  bySite: { host: string; pillarIndex: number; active: number; passive: number; lastAt: number; entries: number }[];
  byPage: { url: string; title: string; host: string; pillarIndex: number; active: number; passive: number; lastAt: number }[];
  total: TimeTotals;
  pendingMinutes: number;
}

/** Seconds since local midnight `days` days ago, by pillar, host and day, for the desk. */
export function summarize(entries: readonly TimeEntry[], days = 7, now: number = Date.now()): TimeSummary {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const floor = start.getTime();
  const dayKeys: string[] = [];
  for (let offset = 0; offset < days; offset++) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    dayKeys.push(dateKeyOf(date.getTime()));
  }
  const perDay = new Map(dayKeys.map((key) => [key, { key, active: 0, passive: 0 }]));
  const byPillar: TimeTotals[] = Array.from({ length: 8 }, () => ({ active: 0, passive: 0 }));
  const sites = new Map<string, TimeSummary["bySite"][number]>();
  const pages = new Map<string, TimeSummary["byPage"][number]>();
  const total: TimeTotals = { active: 0, passive: 0 };
  let pendingMinutes = 0;

  for (const entry of entries) {
    if (entry.endedAt < floor) continue;
    const day = perDay.get(dateKeyOf(entry.startedAt));
    if (!day) continue;
    const field = entry.mode;
    day[field] += entry.seconds;
    byPillar[entry.pillarIndex][field] += entry.seconds;
    total[field] += entry.seconds;
    if (entry.sync === "pending" && !entry.open) pendingMinutes += wholeMinutes(entry);

    const siteKey = `${entry.host}|${entry.pillarIndex}`;
    const site = sites.get(siteKey) ?? { host: entry.host, pillarIndex: entry.pillarIndex, active: 0, passive: 0, lastAt: 0, entries: 0 };
    site[field] += entry.seconds;
    site.lastAt = Math.max(site.lastAt, entry.endedAt);
    site.entries += 1;
    sites.set(siteKey, site);

    const page = pages.get(entry.url) ?? { url: entry.url, title: entry.title, host: entry.host, pillarIndex: entry.pillarIndex, active: 0, passive: 0, lastAt: 0 };
    page[field] += entry.seconds;
    if (entry.endedAt >= page.lastAt) {
      page.lastAt = entry.endedAt;
      page.title = entry.title || page.title;
    }
    pages.set(entry.url, page);
  }

  const bySeconds = <T extends TimeTotals>(first: T, second: T) => second.active + second.passive - (first.active + first.passive);
  return {
    days: dayKeys.map((key) => perDay.get(key)!),
    byPillar,
    bySite: [...sites.values()].sort(bySeconds),
    byPage: [...pages.values()].sort(bySeconds).slice(0, 40),
    total,
    pendingMinutes,
  };
}

export interface TimeReport {
  days: number;
  from: string;
  to: string;
  activeMinutes: number;
  passiveMinutes: number;
  /** Whole minutes closed in the log that have not reached Mandala yet. */
  waitingForMandalaMinutes: number;
  byDay: { date: string; activeMinutes: number; passiveMinutes: number }[];
  byPillar: { pillar: number; name: string; activeMinutes: number; passiveMinutes: number }[];
  bySite: { host: string; pillar: number; name: string; activeMinutes: number; passiveMinutes: number; lastAt: string }[];
}

/** The summary as an agent on the Mandala page reads it: whole minutes, pillar names, no page addresses. */
export function timeReport(summary: TimeSummary, days: number, pillarName: (pillarIndex: number) => string): TimeReport {
  const minutes = (seconds: number) => Math.floor(seconds / 60);
  return {
    days,
    from: summary.days[0]?.key ?? "",
    to: summary.days[summary.days.length - 1]?.key ?? "",
    activeMinutes: minutes(summary.total.active),
    passiveMinutes: minutes(summary.total.passive),
    waitingForMandalaMinutes: summary.pendingMinutes,
    byDay: summary.days.map((day) => ({ date: day.key, activeMinutes: minutes(day.active), passiveMinutes: minutes(day.passive) })),
    byPillar: summary.byPillar
      .map((totals, pillar) => ({ pillar, name: pillarName(pillar), activeMinutes: minutes(totals.active), passiveMinutes: minutes(totals.passive) }))
      .filter((row) => row.activeMinutes + row.passiveMinutes > 0),
    bySite: summary.bySite.map((site) => ({
      host: site.host,
      pillar: site.pillarIndex,
      name: pillarName(site.pillarIndex),
      activeMinutes: minutes(site.active),
      passiveMinutes: minutes(site.passive),
      lastAt: new Date(site.lastAt).toISOString(),
    })),
  };
}
