import { closeAllCustomSelects } from "./custom-select";
import {
  VideoData,
  normalizeYoutubeUrl,
  getSavedSessions,
  updateSessionTabs,
  updateSessionSections,
  setLiveTabSections,
  type SavedSessionTab,
  type SavedSession,
  type SessionSection,
} from "../../utils/storage";
import { app } from "./state";
import { showConfirm, showNameSessionModal } from "./dialogs";
import { SECTION_RAIL_VARS, sectionRailVar } from "./palette";
import { render } from "./render";
import { currentSectionsForMove, updateSelectionUI } from "./selection";
import { collapsedGroups, selectedSessionTabUrls, selectedTabIds } from "./state";
import { showToast } from "./toast";
import { escapeHtml, positionFixedMenu } from "./util";

const SECTION_PRESETS: { name: string; emoji: string; colorIndex: number }[] = [
  { name: "Music", emoji: "🎵", colorIndex: 6 },
  { name: "Work", emoji: "💼", colorIndex: 5 },
  { name: "Podcasts", emoji: "🎙️", colorIndex: 3 },
  { name: "Learning", emoji: "📚", colorIndex: 4 },
  { name: "Entertainment", emoji: "🎬", colorIndex: 1 },
  { name: "Favorites", emoji: "⭐", colorIndex: 7 },
  { name: "Gaming", emoji: "🎮", colorIndex: 2 },
  { name: "News", emoji: "📰", colorIndex: 0 },
];

export const SECTION_COLLAPSE_PREFIX = "sec:";
export const UNSORTED_COLLAPSE_KEY = `${SECTION_COLLAPSE_PREFIX}__unsorted`;

export function renderSectionPickerRows(sections: ReturnType<typeof orderedSections>): string {
  const rows = sections.map((sec) => {
    const rail = sectionRailVar(sec.colorIndex ?? 0);
    return `
      <button type="button" role="menuitem" class="ctx-section-item" data-ctx-section-id="${escapeHtml(sec.id)}">
        <span class="w-1.5 h-4 rounded-full shrink-0" style="background:${rail}"></span>
        <span class="truncate">${sec.emoji ? `${escapeHtml(sec.emoji)} ` : ""}${escapeHtml(sec.name)}</span>
      </button>`;
  });
  rows.push(`<div class="ctx-menu-divider" role="separator"></div>`);
  rows.push(
    `<button type="button" role="menuitem" class="ctx-section-item ctx-section-item--muted" data-ctx-section-id="">✦ Unsorted</button>`
  );
  return rows.join("");
}

export function tabCardDnDHtml(sectionColorIndex: number | "unsorted" | undefined): { extraClass: string; draggableAttr: string } {
  if (sectionColorIndex === undefined) return { extraClass: "", draggableAttr: "" };
  return { extraClass: " tab-card-dnd", draggableAttr: ` draggable="true"` };
}

export function orderedSections(sections: SessionSection[] | undefined): SessionSection[] {
  if (!sections || sections.length === 0) return [];
  return [...sections].sort((a, b) => a.order - b.order);
}

function validSectionIds(sections: SessionSection[]): Set<string> {
  return new Set(sections.map((s) => s.id));
}

export function liveSectionIdForVideo(video: VideoData): string | undefined {
  const sections = orderedSections(app.liveTabSectionsState.sections);
  const valid = validSectionIds(sections);
  const key = normalizeYoutubeUrl(video.url);
  const sid = app.liveTabSectionsState.assignments[key];
  if (typeof sid === "string" && valid.has(sid)) return sid;
  return undefined;
}

export function sessionTabSectionId(tab: SavedSessionTab, sections: SessionSection[]): string | undefined {
  const valid = validSectionIds(sections);
  const sid = tab.sectionId;
  if (typeof sid === "string" && valid.has(sid)) return sid;
  return undefined;
}

export function partitionSessionTabsBySection(
  tabs: SavedSessionTab[],
  sections: SessionSection[]
): { blocks: { section: SessionSection; tabs: SavedSessionTab[] }[]; unsorted: SavedSessionTab[] } {
  const ordered = orderedSections(sections);
  const byId = new Map<string, SavedSessionTab[]>();
  for (const s of ordered) byId.set(s.id, []);
  const unsorted: SavedSessionTab[] = [];
  for (const t of tabs) {
    const sid = sessionTabSectionId(t, ordered);
    if (sid && byId.has(sid)) byId.get(sid)!.push(t);
    else unsorted.push(t);
  }
  const blocks = ordered.map((section) => ({ section, tabs: byId.get(section.id) ?? [] }));
  return { blocks, unsorted };
}

export function partitionLiveVideosBySection(
  videos: VideoData[],
  sections: SessionSection[],
  assignments: Record<string, string>
): { blocks: { section: SessionSection; videos: VideoData[] }[]; unsorted: VideoData[] } {
  const ordered = orderedSections(sections);
  const byId = new Map<string, VideoData[]>();
  for (const s of ordered) byId.set(s.id, []);
  const unsorted: VideoData[] = [];
  const valid = validSectionIds(ordered);
  for (const v of videos) {
    const key = normalizeYoutubeUrl(v.url);
    const sid = assignments[key];
    if (typeof sid === "string" && valid.has(sid) && byId.has(sid)) byId.get(sid)!.push(v);
    else unsorted.push(v);
  }
  const blocks = ordered.map((section) => ({ section, videos: byId.get(section.id) ?? [] }));
  return { blocks, unsorted };
}

export function usesSectionLayoutForSession(session: SavedSession | null): boolean {
  if (!session) return false;
  return orderedSections(session.sections).length > 0;
}

export function usesSectionLayoutForLive(): boolean {
  return orderedSections(app.liveTabSectionsState.sections).length > 0;
}

function persistLiveSections(): Promise<void> {
  return setLiveTabSections(app.liveTabSectionsState);
}

export async function reloadSelectedSessionFromStorage(): Promise<void> {
  if (!app.selectedSession) return;
  const sessions = await getSavedSessions();
  const fresh = sessions.find((s) => s.id === app.selectedSession!.id);
  if (fresh) app.selectedSession = fresh;
}

export async function moveSessionTabsToSection(urls: string[], sectionId: string | null): Promise<void> {
  if (!app.selectedSession || urls.length === 0) return;
  const sections = orderedSections(app.selectedSession.sections);
  const valid = validSectionIds(sections);
  const target = sectionId && valid.has(sectionId) ? sectionId : undefined;
  const tabs = (app.selectedSession.tabs ?? []).map((t) => {
    const u = t.url ?? "";
    if (!urls.includes(u)) return t;
    if (target) return { ...t, sectionId: target };
    return { url: t.url, title: t.title, channelName: t.channelName, seconds: t.seconds };
  });
  await updateSessionTabs(app.selectedSession.id, tabs);
  app.selectedSession.tabs = tabs;
  await reloadSelectedSessionFromStorage();
  selectedSessionTabUrls.clear();
  updateSelectionUI();
  render();
}

export async function moveLiveVideosToSection(tabIds: number[], sectionId: string | null): Promise<void> {
  if (tabIds.length === 0) return;
  const sections = orderedSections(app.liveTabSectionsState.sections);
  const valid = validSectionIds(sections);
  const assign = { ...app.liveTabSectionsState.assignments };
  for (const id of tabIds) {
    const video = app.allVideos.find((v) => v.id === id);
    if (!video) continue;
    const key = normalizeYoutubeUrl(video.url);
    if (sectionId && valid.has(sectionId)) assign[key] = sectionId;
    else delete assign[key];
  }
  app.liveTabSectionsState = { ...app.liveTabSectionsState, assignments: assign };
  await persistLiveSections();
  selectedTabIds.clear();
  updateSelectionUI();
  render();
}

async function moveSelectionToSection(sectionId: string | null): Promise<void> {
  if (app.selectedSession) {
    await moveSessionTabsToSection(Array.from(selectedSessionTabUrls), sectionId);
  } else {
    await moveLiveVideosToSection(Array.from(selectedTabIds), sectionId);
  }
}

async function addNewSection(name: string, emoji: string | undefined, colorIndex: number): Promise<void> {
  const trimmed = name.trim() || "Section";
  if (app.selectedSession) {
    const list = orderedSections(app.selectedSession.sections);
    const sec = createSectionObject(trimmed, emoji, colorIndex, list);
    const next = [...list, sec];
    app.selectedSession.sections = next;
    await updateSessionSections(app.selectedSession.id, next);
    await reloadSelectedSessionFromStorage();
  } else {
    const list = orderedSections(app.liveTabSectionsState.sections);
    const sec = createSectionObject(trimmed, emoji, colorIndex, list);
    app.liveTabSectionsState = {
      sections: [...list, sec],
      assignments: { ...app.liveTabSectionsState.assignments },
    };
    await persistLiveSections();
  }
  showToast(`Pile "${trimmed}" added`);
  render();
}

async function deleteSectionById(sectionId: string): Promise<void> {
  if (app.selectedSession) {
    const nextSecs = orderedSections(app.selectedSession.sections).filter((s) => s.id !== sectionId);
    await updateSessionSections(app.selectedSession.id, nextSecs);
    await reloadSelectedSessionFromStorage();
  } else {
    const nextSecs = app.liveTabSectionsState.sections.filter((s) => s.id !== sectionId);
    const assign = { ...app.liveTabSectionsState.assignments };
    for (const k of Object.keys(assign)) {
      if (assign[k] === sectionId) delete assign[k];
    }
    app.liveTabSectionsState = { sections: nextSecs, assignments: assign };
    await persistLiveSections();
  }
  render();
}

async function renameSectionById(sectionId: string, newName: string): Promise<void> {
  const name = newName.trim();
  if (!name) return;
  if (app.selectedSession) {
    const next = orderedSections(app.selectedSession.sections).map((s) => (s.id === sectionId ? { ...s, name } : s));
    await updateSessionSections(app.selectedSession.id, next);
    await reloadSelectedSessionFromStorage();
  } else {
    app.liveTabSectionsState = {
      ...app.liveTabSectionsState,
      sections: app.liveTabSectionsState.sections.map((s) => (s.id === sectionId ? { ...s, name } : s)),
    };
    await persistLiveSections();
  }
  render();
}

export function openAddSectionModal(): void {
  const modal = document.getElementById("add-section-modal");
  const presets = document.getElementById("add-section-presets");
  const customInput = document.getElementById("add-section-custom") as HTMLInputElement | null;
  if (!modal || !presets) return;
  presets.innerHTML = SECTION_PRESETS.map(
    (p) => `
    <button type="button" class="section-preset-btn text-left" style="--preset-color: ${sectionRailVar(p.colorIndex)}" data-preset-name="${escapeHtml(p.name)}" data-preset-emoji="${escapeHtml(p.emoji)}" data-preset-color="${p.colorIndex}">
      <span class="text-lg leading-none">${escapeHtml(p.emoji)}</span>
      <span class="text-xs font-semibold text-text-primary">${escapeHtml(p.name)}</span>
    </button>
  `
  ).join("");
  if (customInput) customInput.value = "";
  modal.classList.remove("hidden");
  requestAnimationFrame(() => customInput?.focus());
}

function closeAddSectionModal(): void {
  document.getElementById("add-section-modal")?.classList.add("hidden");
}

function nextSectionOrder(sections: SessionSection[]): number {
  if (sections.length === 0) return 0;
  return Math.max(...sections.map((s) => s.order)) + 1;
}

function createSectionObject(name: string, emoji: string | undefined, colorIndex: number, sections: SessionSection[]): SessionSection {
  return {
    id: crypto.randomUUID(),
    name: name.trim() || "Section",
    emoji,
    colorIndex: colorIndex % SECTION_RAIL_VARS.length,
    order: nextSectionOrder(sections),
  };
}

export function wireSections() {
  function openTabSectionContextMenu(
    clientX: number,
    clientY: number,
    target: { mode: "session"; url: string } | { mode: "live"; tabId: number }
  ) {
    app.tabSectionContextTarget = target;
    const menu = document.getElementById("tab-section-context-menu");
    const items = document.getElementById("tab-section-context-items");
    if (!menu || !items) return;
    const sections = currentSectionsForMove();
    if (sections.length === 0) {
      items.innerHTML = `<div class="px-3 py-2.5 text-[11px] text-text-muted leading-relaxed">Create a pile with <span class="text-text-secondary font-medium">New pile</span> first.</div>`;
    } else {
      items.innerHTML = renderSectionPickerRows(sections);
    }
    positionFixedMenu(menu, clientX, clientY);
  }

  document.getElementById("btn-add-section")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openAddSectionModal();
  });

  document.getElementById("btn-collapse-all")?.addEventListener("click", () => {
    const keys = new Set<string>();
    document.querySelectorAll("button[data-section-collapse]").forEach((element) => {
      const value = (element as HTMLElement).dataset.sectionCollapse;
      if (value) {
        keys.add(value);
      }
    });
    document.querySelectorAll("button[data-nested-group]").forEach((element) => {
      const value = (element as HTMLElement).dataset.nestedGroup;
      if (value) {
        keys.add(value);
      }
    });
    document.querySelectorAll("button.group-toggle").forEach((element) => {
      const value = (element as HTMLElement).dataset.group;
      if (value) {
        keys.add(value);
      }
    });

    let allCollapsed = true;
    for (const key of keys) {
      if (!collapsedGroups.has(key)) {
        allCollapsed = false;
        break;
      }
    }

    if (allCollapsed) {
      collapsedGroups.clear();
    } else {
      for (const key of keys) {
        collapsedGroups.add(key);
      }
    }
    render();
  });

  document.getElementById("add-section-close")?.addEventListener("click", () => closeAddSectionModal());
  document.getElementById("add-section-modal")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id === "add-section-modal") closeAddSectionModal();
  });

  document.getElementById("add-section-presets")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest(".section-preset-btn") as HTMLElement | null;
    if (!b) return;
    const name = b.dataset.presetName;
    const emoji = b.dataset.presetEmoji;
    const color = parseInt(b.dataset.presetColor || "0", 10);
    if (!name) return;
    closeAddSectionModal();
    void addNewSection(name, emoji || undefined, color);
  });

  document.getElementById("add-section-custom-submit")?.addEventListener("click", () => {
    const input = document.getElementById("add-section-custom") as HTMLInputElement | null;
    const v = input?.value?.trim();
    if (!v) return;
    closeAddSectionModal();
    const n = app.selectedSession
      ? orderedSections(app.selectedSession.sections).length
      : orderedSections(app.liveTabSectionsState.sections).length;
    void addNewSection(v, undefined, n % SECTION_RAIL_VARS.length);
  });

  document.getElementById("add-section-custom")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      (document.getElementById("add-section-custom-submit") as HTMLButtonElement | null)?.click();
    }
  });

  document.getElementById("btn-move-to-section")?.addEventListener("click", (e) => {
    e.stopPropagation();
    document.getElementById("move-to-section-popover")?.classList.toggle("hidden");
  });

  document.getElementById("move-to-section-popover")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const button = (event.target as HTMLElement).closest("[data-ctx-section-id], [data-move-section-id]") as HTMLElement | null;
    if (!button) return;
    const raw = button.getAttribute("data-ctx-section-id") ?? button.getAttribute("data-move-section-id");
    void moveSelectionToSection(raw === "" || raw === null ? null : raw);
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  });

  document.getElementById("move-to-section-wrap")?.addEventListener("click", (event) => event.stopPropagation());

  document.getElementById("tab-section-context-items")?.addEventListener("click", async (event) => {
    const button = (event.target as HTMLElement).closest("[data-ctx-section-id]") as HTMLElement | null;
    if (!button || !app.tabSectionContextTarget) return;
    const raw = button.getAttribute("data-ctx-section-id");
    const sectionId = raw === "" || raw === null ? null : raw;
    const currentTarget = app.tabSectionContextTarget;
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    app.tabSectionContextTarget = null;
    if (currentTarget.mode === "session") {
      await moveSessionTabsToSection([currentTarget.url], sectionId);
    } else {
      await moveLiveVideosToSection([currentTarget.tabId], sectionId);
    }
  });

  document.getElementById("section-ctx-rename")?.addEventListener("click", async () => {
    const targetContext = app.sectionHeaderContextTarget;
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    if (!targetContext) return;
    const sections = currentSectionsForMove();
    const section = sections.find((s) => s.id === targetContext.sectionId);
    if (!section) return;
    const name = await showNameSessionModal(section.name, "Rename section");
    if (name === null) return;
    await renameSectionById(targetContext.sectionId, name);
    app.sectionHeaderContextTarget = null;
  });

  document.getElementById("section-ctx-delete")?.addEventListener("click", async () => {
    const targetContext = app.sectionHeaderContextTarget;
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    if (!targetContext) return;
    app.sectionHeaderContextTarget = null;
    const sections = currentSectionsForMove();
    const section = sections.find((s) => s.id === targetContext.sectionId);
    const confirmed = await showConfirm({
      title: "Delete pile",
      message: `Delete “${section?.name ?? "pile"}”? Its videos stay on the desk, just not in a pile.`,
      confirmLabel: "Delete",
      confirmDanger: true,
    });
    if (confirmed) await deleteSectionById(targetContext.sectionId);
  });

  document.getElementById("tab-list")?.addEventListener("contextmenu", (event) => {
    const t = event.target as HTMLElement;
    const sessionRow = t.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && app.selectedSession) {
      event.preventDefault();
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (url) openTabSectionContextMenu(event.clientX, event.clientY, { mode: "session", url });
      return;
    }
    const liveRow = t.closest("[data-id]") as HTMLElement | null;
    if (liveRow && !app.selectedSession) {
      event.preventDefault();
      const id = parseInt(liveRow.dataset.id || "0", 10);
      if (!Number.isNaN(id)) openTabSectionContextMenu(event.clientX, event.clientY, { mode: "live", tabId: id });
      return;
    }
    const titleTarget = t.closest(".section-title-target") as HTMLElement | null;
    const sid = titleTarget?.dataset.sectionId;
    if (sid && t.closest(".session-section-shell")) {
      event.preventDefault();
      app.sectionHeaderContextTarget = { sectionId: sid };
      const menu = document.getElementById("section-header-context-menu");
      if (menu) positionFixedMenu(menu, event.clientX, event.clientY);
    }
  });

  document.getElementById("tab-list")?.addEventListener("dblclick", async (event) => {
    const titleEl = (event.target as HTMLElement).closest(".section-title-target") as HTMLElement | null;
    const sid = titleEl?.dataset.sectionId;
    if (!sid) return;
    event.preventDefault();
    const sections = currentSectionsForMove();
    const sec = sections.find((s) => s.id === sid);
    if (!sec) return;
    const name = await showNameSessionModal(sec.name, "Rename section");
    if (name === null) return;
    await renameSectionById(sid, name);
  });

  document.addEventListener("click", () => {
    closeAllCustomSelects();
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  });
  document.getElementById("sidebar-context-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.getElementById("tab-section-context-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.getElementById("section-header-context-menu")?.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("contextmenu", () => {
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    document.getElementById("tab-section-context-menu")?.classList.add("hidden");
    document.getElementById("section-header-context-menu")?.classList.add("hidden");
  });
}
