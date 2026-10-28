import { getSavedSessions, type SavedSessionTab, type SavedSession } from "../../utils/storage";
import { formatDurationWords, getVideoIdFromUrl, normalizeText } from "../../utils/format";
import { sessionTotalSeconds } from "../../utils/sessions";
import { app } from "./state";
import { deskAvatarHtml } from "./avatars";
import {
  DETECTING_LANGUAGE,
  languageColor,
  sessionTabLanguageLabel,
  sessionTabSpokenLanguage,
  tally,
  UNKNOWN_LANGUAGE,
} from "./facets";
import { render } from "./render";
import { orderedSections } from "./sections";
import { getThumbnailSrc } from "./tabs";
import { plural } from "./time/html";
import { escapeHtml } from "./util";

export async function refreshSavedSessionsSidebar() {
  const sessions = await getSavedSessions();
  if (sessions.length !== app.savedSessionsCount) {
    app.savedSessionsCount = sessions.length;
    if (app.isSessionsView) render();
  }
  renderSessionsTotals(sessions);
  const query = normalizeText(app.sessionSidebarSearch.trim());
  const filtered = query
    ? sessions.filter((session) => normalizeText(`${session.name} ${sessionDisplayName(session).title}`).includes(query))
    : sessions;
  document.getElementById("session-sidebar-search")?.classList.toggle("hidden", sessions.length === 0);
  document.getElementById("sessions-hint")?.classList.toggle("hidden", filtered.length === 0);

  const fp = [
    query,
    app.selectedSession?.id ?? "",
    filtered.map((session) => `${session.id}:${session.name}:${session.savedAt}:${session.tabs?.length ?? 0}:${session.pinned ? 1 : 0}`).join("|"),
  ].join("\x1f");
  if (fp === app.lastSavedSessionsFingerprint) return;
  app.lastSavedSessionsFingerprint = fp;

  const container = document.getElementById("saved-sessions-sidebar");
  if (!container) return;
  container.setAttribute("aria-busy", "false");

  const emptyMessage = (text: string) =>
    `<div class="px-3 py-2 text-xs text-text-muted">${text}</div>`;

  if (filtered.length === 0) {
    container.innerHTML = query
      ? emptyMessage(`No sessions match "${escapeHtml(query)}". Try part of a name or a language.`)
      : `<div class="col-span-full flex flex-col items-center justify-center py-16 px-6 text-center">
          <div class="font-display text-xl text-text-primary">No saved sessions yet</div>
          <div class="text-sm text-text-muted mt-1 max-w-sm">A session keeps a set of tabs so you can close them now and open them again later.</div>
          <button type="button" class="chip mt-4" data-empty-save-session>Save the open tabs</button>
        </div>`;
    return;
  }
  const isSelected = (sessionId: string) => app.selectedSession?.id === sessionId;
  container.innerHTML = filtered.map((savedSession) => sessionCardHtml(savedSession, isSelected(savedSession.id))).join("");
}

function renderSessionsTotals(sessions: SavedSession[]): void {
  const stats = document.getElementById("global-stats-count");
  if (!stats || !app.isSessionsView) return;
  const totalVideos = sessions.reduce((sum, session) => sum + (session.tabs?.length ?? 0), 0);
  const totalSeconds = sessions.reduce((sum, session) => sum + sessionTotalSeconds(session.tabs ?? []), 0);
  stats.textContent = sessions.length === 0 ? "" : `${plural(sessions.length, "session")} · ${plural(totalVideos, "video")} · ${formatDurationWords(totalSeconds)} kept`;
}

export const AUTO_SESSION_NAME = /^Session \d{1,2}\/\d{1,2}\/\d{2,4}, \d{1,2}:\d{2} (?:AM|PM)\s*(?:\((.+)\))?$/;

/** Auto-named sessions ("Session 10/15/26, 7:27 AM") read as what they hold instead of when they were saved. */
export function sessionDisplayName(session: SavedSession): { title: string; custom: boolean } {
  const match = session.name.match(AUTO_SESSION_NAME);
  if (!match && session.name.trim()) return { title: session.name, custom: true };
  if (match?.[1]) return { title: match[1].trim(), custom: true };
  const languages = Array.from(tally(session.tabs ?? [], sessionTabSpokenLanguage, (tab) => tab.seconds ?? 0).entries())
    .filter(([label]) => label !== UNKNOWN_LANGUAGE && label !== DETECTING_LANGUAGE)
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([label]) => label);
  if (languages.length === 0) return { title: "Mixed desk", custom: false };
  if (languages.length === 1) return { title: `${languages[0]} desk`, custom: false };
  return { title: `${languages[0]} & ${languages[1]} desk`, custom: false };
}

function sessionSavedLabel(savedAt: number): string {
  const date = new Date(savedAt);
  const day = date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day}, ${time}`;
}

function sessionLanguageBarHtml(tabs: SavedSessionTab[]): string {
  const languages = tally(tabs, sessionTabLanguageLabel, (tab) => tab.seconds ?? 0);
  const entries = Array.from(languages.entries())
    .filter(([, entry]) => entry.seconds > 0)
    .sort((a, b) => b[1].seconds - a[1].seconds || a[0].localeCompare(b[0]));
  const total = entries.reduce((sum, [, entry]) => sum + entry.seconds, 0);
  if (total <= 0) return `<div class="session-langs text-text-muted">No durations yet</div>`;
  const bar = entries
    .map(([label, entry]) => `<span class="session-lang-seg" style="flex: ${Math.max(1, Math.round(entry.seconds))} 1 0px; background: ${languageColor(label)}" title="${escapeHtml(label)}: ${plural(entry.count, "video")}, ${formatDurationWords(entry.seconds)}"></span>`)
    .join("");
  const shown = entries.slice(0, 3);
  const more = entries.length - shown.length;
  const legend = shown
    .map(([label, entry]) => `<span class="session-lang"><span class="facet-dot" style="background: ${languageColor(label)}"></span>${escapeHtml(label)} <span class="text-text-muted tabular-nums">${formatDurationWords(entry.seconds)}</span></span>`)
    .join("");
  return `
    <div class="session-lang-bar" aria-hidden="true">${bar}</div>
    <div class="session-langs">${legend}${more > 0 ? `<span class="text-text-muted">+${more} more</span>` : ""}</div>`;
}

const SESSION_THUMBS = 4;

function sessionThumbStripHtml(tabs: SavedSessionTab[]): string {
  const shown = tabs.slice(0, SESSION_THUMBS);
  if (shown.length === 0) return "";
  const more = tabs.length - shown.length;
  const cells = shown
    .map((tab, index) => {
      const src = getThumbnailSrc(getVideoIdFromUrl(tab.url), "mqdefault.jpg");
      const overlay = index === shown.length - 1 && more > 0 ? `<span class="session-thumb-more">+${more}</span>` : "";
      return `<span class="session-thumb">${src ? `<img src="${src}" alt="" loading="lazy" decoding="async" draggable="false" />` : ""}${overlay}</span>`;
    })
    .join("");
  const filler = `<span class="session-thumb"></span>`.repeat(SESSION_THUMBS - shown.length);
  return `<div class="session-thumbs" aria-hidden="true">${cells}${filler}</div>`;
}

function sessionAvatarStackHtml(tabs: SavedSessionTab[]): string {
  const channels = Array.from(tally(tabs, (tab) => tab.channelName?.trim() || "", (tab) => tab.seconds ?? 0).entries())
    .filter(([name]) => name !== "")
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .map(([name]) => name);
  if (channels.length === 0) return "";
  const shown = channels.slice(0, 4);
  return `<span class="session-avatars" title="${escapeHtml(channels.join(", "))}">${shown.map((name) => deskAvatarHtml(name, "w-5 h-5 text-[9px]")).join("")}</span>`;
}

function sessionCardHtml(session: SavedSession, active: boolean): string {
  const tabs = session.tabs ?? [];
  const { title, custom } = sessionDisplayName(session);
  const pileCount = orderedSections(session.sections).length;
  const pinIcon = `<svg class="shrink-0 w-3.5 h-3.5 text-accent" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
  return `
    <article class="session-card sidebar-item${active ? " session-card--active" : ""}" data-sidebar-type="session" data-session-id="${escapeHtml(session.id)}" data-pinned="${session.pinned ? "1" : "0"}" aria-label="${escapeHtml(title)}">
      ${sessionThumbStripHtml(tabs)}
      <div class="session-card-head">
        <h3 class="session-card-title${custom ? "" : " session-card-title--auto"}"><button type="button" class="session-card-open" title="Put ${escapeHtml(title)} on the desk">${escapeHtml(title)}</button></h3>
        ${session.pinned ? pinIcon : ""}
        ${sessionAvatarStackHtml(tabs)}
      </div>
      <div class="session-card-sub">
        <span class="tabular-nums">${plural(tabs.length, "video")} · ${formatDurationWords(sessionTotalSeconds(tabs))}</span>
        ${pileCount > 0 ? `<span>· ${pileCount} ${pileCount === 1 ? "pile" : "piles"}</span>` : ""}
        <span class="text-text-muted/80">· saved ${escapeHtml(sessionSavedLabel(session.savedAt))}</span>
      </div>
      ${sessionLanguageBarHtml(tabs)}
      <div class="session-card-actions">
        <button type="button" class="chip h-8" data-session-action="restore" title="Open these tabs in a window">
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          Open tabs
        </button>
        <button type="button" class="chip h-8" data-session-action="add" title="Add the tabs open now to this session">+ Add open tabs</button>
        <span class="flex-1"></span>
        <button type="button" class="queue-action" data-session-action="more" title="Rename, pin, duplicate, delete" aria-label="More actions">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
        </button>
      </div>
    </article>
  `;
}
