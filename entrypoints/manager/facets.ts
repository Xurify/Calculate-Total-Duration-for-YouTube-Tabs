import { VideoData, type SavedSessionTab, type SessionSection } from "../../utils/storage";
import { formatDurationWords, formatShortDuration, getVideoIdFromUrl } from "../../utils/format";
import { englishLanguageName, languageFlagHtml } from "../../utils/languageFlags";
import { languageColor as sharedLanguageColor, NO_LANGUAGE_COLOR } from "../../utils/languageColor";
import { focusLabelOf, OTHER_LANGUAGES } from "../../utils/focusLanguages";
import { languageOverrideFor } from "../../utils/languageOverrides";
import { app } from "./state";
import { deskAvatarHtml } from "./avatars";
import { sectionRailVar } from "./palette";
import { remainingOf } from "./playback";
import { render } from "./render";
import {
  liveSectionIdForVideo,
  orderedSections,
  partitionLiveVideosBySection,
  partitionSessionTabsBySection,
  sessionTabSectionId,
} from "./sections";
import { escapeHtml, positionFixedMenu } from "./util";
import { filterSessionTabsForDisplay, filterVideosForDisplay } from "./view-filter";

// ───────────────────────── Facets: the desk organises itself ─────────────────────────

export type FacetKind = "all" | "continue" | "language" | "channel" | "pile";
/** One choice per group; all set groups must match. */
const facets: { language?: string; channel?: string; pile?: string; continue?: boolean } = {};

export const UNKNOWN_LANGUAGE = "Unknown language";
export const DETECTING_LANGUAGE = "Detecting…";


export function hasAnyFacet(): boolean {
  return Boolean(facets.language || facets.channel || facets.pile || facets.continue);
}

export function clearFacets(): void {
  delete facets.language;
  delete facets.channel;
  delete facets.pile;
  delete facets.continue;
}

function languageLabelOf(languageName: string | null | undefined, code: string | null | undefined): string {
  const stripped = languageName ? languageName.split("(")[0].trim() : "";
  const english = englishLanguageName(code) ?? englishLanguageName(stripped);
  if (english) return english;
  if (stripped) return stripped;
  if (code) return code.toUpperCase();
  return UNKNOWN_LANGUAGE;
}

function videoLanguageLabel(video: VideoData): string {
  const override = languageOverrideFor(app.languageOverrides, getVideoIdFromUrl(video.url), video.channelName);
  if (override) return focusLabelOf(app.focusLanguages, override.name);
  if (video.language === undefined && !video.suspended) return DETECTING_LANGUAGE;
  return focusLabelOf(app.focusLanguages, languageLabelOf(video.languageName, video.language));
}

/** The tab's own language, before languages outside Settings' list fold into "Other". */
export function sessionTabSpokenLanguage(tab: SavedSessionTab): string {
  const override = languageOverrideFor(app.languageOverrides, getVideoIdFromUrl(tab.url), tab.channelName);
  return override ? override.name : languageLabelOf(tab.languageName, tab.language);
}

export function sessionTabLanguageLabel(tab: SavedSessionTab): string {
  return focusLabelOf(app.focusLanguages, sessionTabSpokenLanguage(tab));
}

/** Real languages first by time, then the grey catch-alls. */
function languageRank(label: string): number {
  return label === DETECTING_LANGUAGE ? 3 : label === UNKNOWN_LANGUAGE ? 2 : label === OTHER_LANGUAGES ? 1 : 0;
}

export function languageColor(label: string): string {
  if (languageRank(label) !== 0) return NO_LANGUAGE_COLOR;
  return sharedLanguageColor(label);
}

export function toggleFacet(kind: FacetKind, value = ""): void {
  if (kind === "all") {
    clearFacets();
  } else if (kind === "continue") {
    facets.continue = facets.continue ? undefined : true;
  } else if (facets[kind] === value) {
    delete facets[kind];
  } else {
    facets[kind] = value;
  }
  app.lastTabListFingerprint = "";
  render();
}

export function facetMatchesVideo(video: VideoData): boolean {
  if (facets.continue && !(!video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds)) return false;
  if (facets.language && videoLanguageLabel(video) !== facets.language) return false;
  if (facets.channel && (video.channelName || "Unknown channel") !== facets.channel) return false;
  if (facets.pile && (liveSectionIdForVideo(video) ?? "__unsorted") !== facets.pile) return false;
  return true;
}

export function facetMatchesSessionTab(tab: SavedSessionTab, sections: SessionSection[]): boolean {
  if (facets.continue) return false;
  if (facets.language && sessionTabLanguageLabel(tab) !== facets.language) return false;
  if (facets.channel && (tab.channelName || "Unknown channel") !== facets.channel) return false;
  if (facets.pile && (sessionTabSectionId(tab, sections) ?? "__unsorted") !== facets.pile) return false;
  return true;
}

interface FacetRow { kind: FacetKind; value: string; label: string; count: number; seconds: number; color?: string; sectionId?: string; muted?: boolean }

export function tally<T>(items: T[], keyOf: (item: T) => string, secondsOf: (item: T) => number): Map<string, { count: number; seconds: number }> {
  const map = new Map<string, { count: number; seconds: number }>();
  for (const item of items) {
    const key = keyOf(item);
    const entry = map.get(key) ?? { count: 0, seconds: 0 };
    entry.count += 1;
    entry.seconds += secondsOf(item);
    map.set(key, entry);
  }
  return map;
}

function languageRowsFrom(languages: Map<string, { count: number; seconds: number }>): FacetRow[] {
  return Array.from(languages.entries())
    .sort((a, b) => languageRank(a[0]) - languageRank(b[0]) || b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]))
    .map(([label, entry]) => ({
      kind: "language",
      value: label,
      label,
      count: entry.count,
      seconds: entry.seconds,
      color: languageColor(label),
      muted: languageRank(label) > 0,
    }));
}

function channelRowsFrom(channels: Map<string, { count: number; seconds: number }>): FacetRow[] {
  return Array.from(channels.entries())
    .sort((a, b) => b[1].count - a[1].count || b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([label, entry]) => ({ kind: "channel", value: label, label, count: entry.count, seconds: entry.seconds }));
}

function facetRowsForLive(videos: VideoData[]): { languages: FacetRow[]; channels: FacetRow[]; piles: FacetRow[]; continueRow: FacetRow } {
  const languageRows = languageRowsFrom(tally(videos, videoLanguageLabel, remainingOf));
  const channelRows = channelRowsFrom(tally(videos, (video) => video.channelName || "Unknown channel", remainingOf));

  const sections = orderedSections(app.liveTabSectionsState.sections);
  const { blocks, unsorted } = partitionLiveVideosBySection(videos, sections, app.liveTabSectionsState.assignments);
  const pileRows: FacetRow[] = blocks.map(({ section, videos: sectionVideos }) => ({
    kind: "pile",
    value: section.id,
    label: section.name,
    count: sectionVideos.length,
    seconds: sectionVideos.reduce((sum, video) => sum + remainingOf(video), 0),
    color: sectionRailVar(section.colorIndex ?? 0),
    sectionId: section.id,
  }));
  if (sections.length > 0) {
    pileRows.push({ kind: "pile", value: "__unsorted", label: "Not in a pile", count: unsorted.length, seconds: unsorted.reduce((sum, video) => sum + remainingOf(video), 0) });
  }

  const started = videos.filter((video) => !video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds);
  const continueRow: FacetRow = { kind: "continue", value: "", label: "Continue watching", count: started.length, seconds: started.reduce((sum, video) => sum + remainingOf(video), 0) };
  return { languages: languageRows, channels: channelRows, piles: pileRows, continueRow };
}

function facetRowsForSession(tabs: SavedSessionTab[], sections: SessionSection[]): { languages: FacetRow[]; channels: FacetRow[]; piles: FacetRow[] } {
  const seconds = (tab: SavedSessionTab) => tab.seconds ?? 0;
  const languageRows = languageRowsFrom(tally(tabs, sessionTabLanguageLabel, seconds));
  const channelRows = channelRowsFrom(tally(tabs, (tab) => tab.channelName || "Unknown channel", seconds));
  const { blocks, unsorted } = partitionSessionTabsBySection(tabs, sections);
  const pileRows: FacetRow[] = blocks.map(({ section, tabs: sectionTabs }) => ({
    kind: "pile",
    value: section.id,
    label: section.name,
    count: sectionTabs.length,
    seconds: sectionTabs.reduce((sum, tab) => sum + seconds(tab), 0),
    color: sectionRailVar(section.colorIndex ?? 0),
    sectionId: section.id,
  }));
  if (sections.length > 0) {
    pileRows.push({ kind: "pile", value: "__unsorted", label: "Not in a pile", count: unsorted.length, seconds: unsorted.reduce((sum, tab) => sum + seconds(tab), 0) });
  }
  return { languages: languageRows, channels: channelRows, piles: pileRows };
}

/** A filter whose value left the desk (last Slovak tab closed) clears itself instead of showing an empty list. */
export function pruneStaleFacets(): void {
  if (app.selectedSession) {
    const base = filterSessionTabsForDisplay(app.selectedSession.tabs ?? [], { ignoreFacet: true });
    const sections = orderedSections(app.selectedSession.sections);
    if (facets.language && !base.some((tab) => sessionTabLanguageLabel(tab) === facets.language)) delete facets.language;
    if (facets.channel && !base.some((tab) => (tab.channelName || "Unknown channel") === facets.channel)) delete facets.channel;
    if (facets.pile && facets.pile !== "__unsorted" && !sections.some((section) => section.id === facets.pile)) delete facets.pile;
    if (facets.continue) delete facets.continue;
    return;
  }
  const base = filterVideosForDisplay(currentLiveBaseVideos(), { ignoreFacet: true });
  const sections = orderedSections(app.liveTabSectionsState.sections);
  if (facets.language && !base.some((video) => videoLanguageLabel(video) === facets.language)) delete facets.language;
  if (facets.channel && !base.some((video) => (video.channelName || "Unknown channel") === facets.channel)) delete facets.channel;
  if (facets.pile && facets.pile !== "__unsorted" && !sections.some((section) => section.id === facets.pile)) delete facets.pile;
  if (facets.pile === "__unsorted" && sections.length === 0) delete facets.pile;
  if (facets.continue && !base.some((video) => !video.isLive && video.currentTime > 0 && video.seconds > 0 && video.currentTime < video.seconds)) delete facets.continue;
}

function facetIsActive(row: FacetRow): boolean {
  switch (row.kind) {
    case "all": return !hasAnyFacet();
    case "continue": return Boolean(facets.continue);
    case "language": return facets.language === row.value;
    case "channel": return facets.channel === row.value;
    case "pile": return facets.pile === row.value;
  }
}

const FACET_ICONS: Record<string, string> = {
  all: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  continue: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8 5 4-5 4z" fill="currentColor"/></svg>`,
  channel: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
  unsorted: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 3" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>`,
  add: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
};

function facetIconHtml(row: FacetRow): string {
  if (row.kind === "channel" && app.deskChannelAvatars[row.value]) {
    return `<span class="facet-icon">${deskAvatarHtml(row.value)}</span>`;
  }
  if (row.kind === "language") {
    const flag = languageFlagHtml(row.label, "lang-flag lang-flag--sm");
    if (flag) return `<span class="facet-icon">${flag}</span>`;
  }
  if (row.kind === "language" || (row.kind === "pile" && row.value !== "__unsorted")) {
    return `<span class="facet-icon"><span class="facet-dot" style="background: ${row.color ?? "var(--color-border-hover)"}"></span></span>`;
  }
  const icon = row.kind === "pile" ? FACET_ICONS.unsorted : FACET_ICONS[row.kind] ?? "";
  return `<span class="facet-icon">${icon}</span>`;
}

function facetButtonHtml(row: FacetRow, extraAttrs = ""): string {
  const active = facetIsActive(row);
  const dot = facetIconHtml(row);
  const hasTime = row.count > 0 && row.seconds > 0;
  const timeWords = hasTime ? `, ${formatDurationWords(row.seconds)}${app.selectedSession == null ? " left to watch" : ""}` : "";
  const title = `${row.label}: ${row.count} ${row.count === 1 ? "video" : "videos"}${timeWords}`;
  return `
    <button type="button" class="facet${active ? " facet--active" : ""}${row.muted ? " facet--muted" : ""}" data-facet-kind="${row.kind}" data-facet-value="${escapeHtml(row.value)}"${extraAttrs} aria-pressed="${active}" title="${escapeHtml(title)}">
      ${dot}
      <span class="facet-name">${escapeHtml(row.label)}</span>
      <span class="facet-count" aria-label="${row.count} ${row.count === 1 ? "video" : "videos"}">${row.count}</span>
      <span class="facet-time">${hasTime ? formatShortDuration(row.seconds) : ""}</span>
    </button>`;
}

function facetGroupHtml(title: string, rows: FacetRow[], trailing = "", extraClass = ""): string {
  if (rows.length === 0 && !trailing) return "";
  return `
    <div class="facet-group${extraClass ? ` ${extraClass}` : ""}">
      <div class="facet-head">${escapeHtml(title)}</div>
      ${rows.map((row) => facetButtonHtml(row, row.sectionId || row.value === "__unsorted" ? ` data-section-wrapper="${escapeHtml(row.value)}"` : "")).join("")}
      ${trailing}
    </div>`;
}

function windowScopeHtml(): string {
  if (app.windowGroups.length <= 1) return "";
  const chip = (label: string, active: boolean, attrs: string) =>
    `<button type="button" class="scope-chip sidebar-item${active ? " scope-chip--active" : ""}" ${attrs}>${escapeHtml(label)}</button>`;
  return `
    <div class="scope-switch" role="group" aria-label="Which windows">
      ${chip("All windows", app.currentWindowId === "all", `data-sidebar-type="all"`)}
      ${app.windowGroups.map((group) => chip(`${group.label} · ${group.tabs.length}`, app.currentWindowId === group.id, `data-sidebar-type="window" data-window-id="${group.id}"`)).join("")}
    </div>`;
}

export function renderFacetRail(): void {
  const rail = document.getElementById("facet-rail");
  if (!rail) return;
  const live = !app.isReadingListView && !app.isSessionsView && !app.isTimeView && !app.isPracticeView && app.selectedSession == null;
  const session = app.selectedSession != null && !app.isSessionsView && !app.isReadingListView;
  rail.classList.toggle("hidden", !live && !session);
  if (!live && !session) return;

  const newPile = `<button type="button" class="facet facet--add" data-pile-create="1"><span class="facet-icon">${FACET_ICONS.add}</span><span class="facet-name">New pile…</span></button>`;
  let html = "";
  if (live) {
    const base = filterVideosForDisplay(currentLiveBaseVideos(), { ignoreFacet: true });
    const rows = facetRowsForLive(base);
    const allRow: FacetRow = { kind: "all", value: "", label: "Everything", count: base.length, seconds: base.reduce((sum, video) => sum + remainingOf(video), 0) };
    html += windowScopeHtml();
    html += `<div class="facet-group">${facetButtonHtml(allRow)}${rows.continueRow.count > 0 ? facetButtonHtml(rows.continueRow) : ""}</div>`;
    html += facetGroupHtml("Languages", rows.languages);
    html += facetGroupHtml("Channels", rows.channels);
    html += facetGroupHtml("Piles", rows.piles, newPile, "facet-group--piles");
  } else if (app.selectedSession) {
    const sections = orderedSections(app.selectedSession.sections);
    const base = filterSessionTabsForDisplay(app.selectedSession.tabs ?? [], { ignoreFacet: true });
    const rows = facetRowsForSession(base, sections);
    const allRow: FacetRow = { kind: "all", value: "", label: "Whole session", count: base.length, seconds: base.reduce((sum, tab) => sum + (tab.seconds ?? 0), 0) };
    html += `<div class="facet-group">${facetButtonHtml(allRow)}</div>`;
    html += facetGroupHtml("Languages", rows.languages);
    html += facetGroupHtml("Channels", rows.channels);
    html += facetGroupHtml("Piles", rows.piles, newPile, "facet-group--piles");
  }
  if (html !== app.lastFacetRailHtml) {
    app.lastFacetRailHtml = html;
    rail.innerHTML = html;
  }
}

function currentLiveBaseVideos(): VideoData[] {
  if (app.currentWindowId === "all") return app.allVideos;
  return app.windowGroups.find((group) => group.id === app.currentWindowId)?.tabs ?? [];
}

export function facetCrumbText(): string {
  const parts: string[] = [];
  if (facets.continue) parts.push("Continue watching");
  if (facets.language) parts.push(facets.language);
  if (facets.channel) parts.push(facets.channel);
  if (facets.pile) {
    if (facets.pile === "__unsorted") parts.push("Not in a pile");
    else {
      const sections = app.selectedSession ? orderedSections(app.selectedSession.sections) : orderedSections(app.liveTabSectionsState.sections);
      parts.push(sections.find((section) => section.id === facets.pile)?.name ?? "Pile");
    }
  }
  return parts.join(" · ");
}

export function renderFacetCrumb(): void {
  const crumb = document.getElementById("facet-crumb");
  const clear = document.getElementById("facet-clear");
  const text = facetCrumbText();
  if (crumb) crumb.textContent = text;
  clear?.classList.toggle("hidden", text === "");
}

// ───────────────────────── Time bar: where the hours go ─────────────────────────

export function renderTimeBar(): void {
  const bar = document.getElementById("time-bar");
  const rest = document.getElementById("time-bar-rest");
  if (!bar) return;
  const live = !app.isReadingListView && !app.isSessionsView && !app.isTimeView && !app.isPracticeView && app.selectedSession == null;
  const session = app.selectedSession != null && !app.isSessionsView && !app.isReadingListView;
  bar.classList.toggle("hidden", !live && !session);
  rest?.classList.toggle("hidden", !live && !session);
  if (!live && !session) return;

  let entries: { label: string; seconds: number; count: number }[];
  if (live) {
    const base = filterVideosForDisplay(currentLiveBaseVideos(), { ignoreFacet: true });
    const languages = tally(base, videoLanguageLabel, remainingOf);
    entries = Array.from(languages.entries()).map(([label, entry]) => ({ label, seconds: entry.seconds, count: entry.count }));
  } else {
    const base = filterSessionTabsForDisplay(app.selectedSession!.tabs ?? [], { ignoreFacet: true });
    const languages = tally(base, sessionTabLanguageLabel, (tab) => tab.seconds ?? 0);
    entries = Array.from(languages.entries()).map(([label, entry]) => ({ label, seconds: entry.seconds, count: entry.count }));
  }
  entries = entries.filter((entry) => entry.seconds > 0).sort((a, b) => languageRank(a.label) - languageRank(b.label) || b.seconds - a.seconds || a.label.localeCompare(b.label));
  const total = entries.reduce((sum, entry) => sum + entry.seconds, 0);
  if (total <= 0) {
    bar.innerHTML = "";
    bar.classList.add("hidden");
    if (rest) rest.classList.add("hidden");
    return;
  }
  const small: string[] = [];
  bar.innerHTML = entries
    .map((entry) => {
      const share = (entry.seconds / total) * 100;
      const active = facets.language === entry.label;
      const dimmed = Boolean(facets.language) && !active;
      const detecting = entry.label === DETECTING_LANGUAGE;
      const labelled = share >= 9;
      if (!labelled) small.push(`<button type="button" class="time-bar-rest-item" data-facet-kind="language" data-facet-value="${escapeHtml(entry.label)}"><span class="facet-dot" style="background: ${languageColor(entry.label)}"></span>${escapeHtml(entry.label)} <span class="tabular-nums">${formatDurationWords(entry.seconds)}</span></button>`);
      const label = labelled ? `<span class="time-bar-label">${escapeHtml(entry.label)} <span class="time-bar-time">${formatDurationWords(entry.seconds)}</span></span>` : "";
      return `<button type="button" class="time-bar-seg${active ? " time-bar-seg--active" : ""}${dimmed ? " time-bar-seg--dim" : ""}${detecting ? " time-bar-seg--detecting" : ""}" style="flex: ${Math.max(1, Math.round(entry.seconds))} 1 0px; background: ${languageColor(entry.label)}" data-facet-kind="language" data-facet-value="${escapeHtml(entry.label)}" title="${escapeHtml(entry.label)}: ${entry.count} ${entry.count === 1 ? "video" : "videos"}, ${formatDurationWords(entry.seconds)} ${live ? "left" : "in total"}">${label}</button>`;
    })
    .join("");
  if (rest) {
    rest.innerHTML = small.length > 0 ? `<span class="text-text-muted">Also</span> ${small.join("")}` : "";
    rest.classList.toggle("hidden", small.length === 0);
  }
}

export function wirePileFacetMenu() {
  document.getElementById("facet-rail")?.addEventListener("contextmenu", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-facet-kind=\"pile\"]");
    const sectionId = button?.dataset.facetValue;
    if (!sectionId || sectionId === "__unsorted") return;
    event.preventDefault();
    // The document-level contextmenu listener closes every menu; keep it from closing this one.
    event.stopPropagation();
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    app.sectionHeaderContextTarget = { sectionId };
    const menu = document.getElementById("section-header-context-menu");
    if (menu) positionFixedMenu(menu, event.clientX, event.clientY);
  });
}
