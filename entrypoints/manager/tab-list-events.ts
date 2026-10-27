import { updateSessionTabs, type SavedSessionTab } from "../../utils/storage";
import { removeReadingListItem } from "../../utils/readingList";
import { app } from "./state";
import { tabListStructureFingerprint } from "./fingerprint";
import { loadReadingList } from "./reading-list";
import { render } from "./render";
import {
  applyFlatChannelGroupCollapseDom,
  applyNestedGroupCollapseDom,
  applySectionCollapseDom,
} from "./section-render";
import {
  liveSectionIdForVideo,
  moveLiveVideosToSection,
  moveSessionTabsToSection,
  orderedSections,
  sessionTabSectionId,
} from "./sections";
import { updateSelectionUI } from "./selection";
import {
  focusLiveVideoTab,
  openOrFocusSessionVideo,
  openSessionVideoInNewTab,
  sessionTabMatchesUrl,
} from "./session-actions";
import { refreshSavedSessionsSidebar, sessionDisplayName } from "./sessions-sidebar";
import { renderSidebar } from "./sidebar";
import { collapsedGroups, selectedSessionTabUrls, selectedTabIds } from "./state";
import { closeVideoTabs, restoreSessionTabs } from "./tab-actions";
import { showToast } from "./toast";

const TAB_MANAGER_DRAG_MIME = "application/x-tab-manager";
let sectionDropHighlightEl: HTMLElement | null = null;

function clearSectionDropHighlight(): void {
  sectionDropHighlightEl?.classList.remove("section-drop-target--active");
  sectionDropHighlightEl = null;
}

function setSectionDropHighlight(zone: HTMLElement | null): void {
  if (sectionDropHighlightEl === zone) return;
  clearSectionDropHighlight();
  if (zone) {
    zone.classList.add("section-drop-target--active");
    sectionDropHighlightEl = zone;
  }
}

function parseTabManagerDrag(raw: string): { kind: "session"; url: string } | { kind: "live"; tabId: number } | null {
  try {
    const o = JSON.parse(raw) as { kind?: string; url?: string; tabId?: number };
    if (o.kind === "session" && typeof o.url === "string") return { kind: "session", url: o.url };
    if (o.kind === "live" && typeof o.tabId === "number") return { kind: "live", tabId: o.tabId };
  } catch {
    /* ignore */
  }
  return null;
}

export function wireTabList() {
  document.getElementById("tab-list")?.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;

    const readingCard = target.closest(".reading-list-card") as HTMLElement | null;
    if (readingCard) {
      const url = readingCard.getAttribute("data-reading-list-url");
      if (url) {
        if (target.closest(".reading-list-remove-btn")) {
          event.stopPropagation();
          const removed = await removeReadingListItem(url);
          if (removed) {
            showToast("Removed from Reading List");
            await loadReadingList();
            render();
          } else {
            showToast("Failed to remove item from Reading List");
          }
          return;
        }
        if (target.closest(".reading-list-open-btn")) {
          event.stopPropagation();
          await browser.tabs.create({ url, active: true });
          return;
        }
      }
    }

    if (target.closest(".section-collapse-toggle")) {
      const btn = target.closest(".section-collapse-toggle") as HTMLElement;
      const key = btn.dataset.sectionCollapse;
      if (key) {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        applySectionCollapseDom(key, collapsedGroups.has(key));
        app.lastTabListFingerprint = tabListStructureFingerprint();
      }
      return;
    }

    if (target.closest(".nested-group-toggle") && !target.closest(".nested-group-selection-toggle")) {
      const tg = target.closest(".nested-group-toggle") as HTMLElement;
      const key = tg.dataset.nestedGroup;
      if (key) {
        if (collapsedGroups.has(key)) collapsedGroups.delete(key);
        else collapsedGroups.add(key);
        applyNestedGroupCollapseDom(key, collapsedGroups.has(key));
        app.lastTabListFingerprint = tabListStructureFingerprint();
      }
      return;
    }

    const sessionRow = target.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && app.selectedSession) {
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (url != null) {
        if (target.closest(".session-remove-btn")) {
          event.stopPropagation();
          const tab = (app.selectedSession.tabs ?? []).find((sessionTab) => sessionTabMatchesUrl(sessionTab, url));
          const session = app.selectedSession;
          const previousTabs = [...(session.tabs ?? [])];
          const newTabs = (app.selectedSession.tabs ?? []).filter((sessionTab) => !sessionTabMatchesUrl(sessionTab, url));
          await updateSessionTabs(app.selectedSession.id, newTabs);
          app.selectedSession.tabs = newTabs;
          selectedSessionTabUrls.delete(url);
          refreshSavedSessionsSidebar();
          updateSelectionUI();
          render();
          showToast(`Removed "${tab?.title || "the video"}" from "${sessionDisplayName(session).title}"`, {
            label: "Undo",
            run: () => restoreSessionTabs(session.id, previousTabs),
          });
          return;
        }
        if (target.closest(".session-selection-toggle")) {
          event.stopPropagation();
          if (selectedSessionTabUrls.has(url)) selectedSessionTabUrls.delete(url);
          else selectedSessionTabUrls.add(url);
          updateSelectionUI();
          return;
        }
        if (target.closest(".session-open-new-tab")) {
          event.stopPropagation();
          openSessionVideoInNewTab(url);
          return;
        }
        if (target.closest(".session-video-click-target")) {
          event.stopPropagation();
          if (selectedSessionTabUrls.size > 0) {
            if (selectedSessionTabUrls.has(url)) selectedSessionTabUrls.delete(url);
            else selectedSessionTabUrls.add(url);
            updateSelectionUI();
            return;
          }
          void openOrFocusSessionVideo(url);
          return;
        }
      }
      return;
    }

    const row = target.closest("[data-id]") as HTMLElement | null;
    const id = row ? parseInt(row.dataset.id || "0", 10) : 0;

    const chapterItem = target.closest(".video-chapter-item") as HTMLElement | null;
    if (chapterItem) {
      event.stopPropagation();
      const videoId = parseInt(chapterItem.dataset.videoId || "", 10);
      const startSeconds = parseInt(chapterItem.dataset.time || "0", 10);
      const video = app.allVideos.find((candidate) => candidate.id === videoId);
      if (video) {
        const rawUrl = video.url.split("&t=")[0].split("?t=")[0];
        const separator = rawUrl.includes("?") ? "&" : "?";
        const targetUrl = `${rawUrl}${separator}t=${startSeconds}`;
        await browser.tabs.update(video.id, { url: targetUrl, active: true });
        if (video.windowId !== undefined) {
          await browser.windows.update(video.windowId, { focused: true });
        }
      }
      return;
    }

    const chapterToggle = target.closest(".video-chapters-toggle") as HTMLElement | null;
    if (chapterToggle) {
      event.stopPropagation();
      const container = chapterToggle.closest(".video-chapters-container");
      const list = container?.querySelector(".video-chapters-list");
      if (list) {
        list.classList.toggle("hidden");
        const isExpanded = !list.classList.contains("hidden");
        chapterToggle.setAttribute("aria-expanded", String(isExpanded));
        chapterToggle.querySelector(".chapter-toggle-arrow")?.classList.toggle("rotate-90", isExpanded);
      }
      return;
    }

    if (target.closest(".selection-toggle")) {
      event.stopPropagation();
      if (selectedTabIds.has(id)) selectedTabIds.delete(id);
      else selectedTabIds.add(id);
      updateSelectionUI();
      return;
    }
    if (target.closest(".jump-btn")) {
      event.stopPropagation();
      const video = app.allVideos.find((candidate) => candidate.id === id);
      if (video) {
        await focusLiveVideoTab(video);
      }
      return;
    }
    if (target.closest(".close-btn")) {
      event.stopPropagation();
      const closing = app.allVideos.find((video) => video.id === id);
      if (closing) await closeVideoTabs([closing]);
      else await browser.tabs.remove(id);
      row?.remove();
      app.allVideos = app.allVideos.filter((video) => video.id !== id);
      for (const group of app.windowGroups) {
        group.tabs = group.tabs.filter((video) => video.id !== id);
        group.duration = group.tabs.reduce((accumulator, video) => accumulator + video.seconds, 0);
      }
      app.windowGroups = app.windowGroups.filter((group) => group.tabs.length > 0);
      app.lastTabListFingerprint = tabListStructureFingerprint();
      renderSidebar();
      updateSelectionUI();
      return;
    }
    if (target.closest(".video-click-target")) {
      event.stopPropagation();
      if (selectedTabIds.size > 0) {
        if (selectedTabIds.has(id)) selectedTabIds.delete(id);
        else selectedTabIds.add(id);
        updateSelectionUI();
        return;
      }
      const video = app.allVideos.find((candidate) => candidate.id === id);
      if (video) await focusLiveVideoTab(video);
      return;
    }
    if (target.closest(".nested-group-selection-toggle")) {
      event.stopPropagation();
      const el = target.closest(".nested-group-selection-toggle") as HTMLElement;
      const scopeId = el.dataset.nestedGroupScope;
      const groupName = el.dataset.nestedGroupName;
      if (!scopeId || !groupName) return;
      if (app.selectedSession) {
        const secs = orderedSections(app.selectedSession.sections);
        const inSection = (tab: SavedSessionTab) => {
          if (scopeId === "__unsorted") return !sessionTabSectionId(tab, secs);
          return sessionTabSectionId(tab, secs) === scopeId;
        };
        const groupTabs = (app.selectedSession.tabs ?? []).filter((t) => {
          if (!inSection(t)) return false;
          if (app.groupingMode === "channel") {
            return (t.channelName ?? "Unknown Channel") === groupName;
          } else if (app.groupingMode === "language") {
            const stripped = t.languageName ? t.languageName.split('(')[0].trim() : "";
            const langName = stripped ? stripped : (t.language ? t.language.toUpperCase() : "Unspecified");
            return langName === groupName;
          }
          return false;
        });
        const urls = groupTabs.map((t) => t.url ?? "").filter(Boolean);
        const allSelected = urls.length > 0 && urls.every((u) => selectedSessionTabUrls.has(u));
        urls.forEach((u) => {
          if (allSelected) selectedSessionTabUrls.delete(u);
          else selectedSessionTabUrls.add(u);
        });
      } else {
        let scopeVideos = app.allVideos;
        if (app.currentWindowId !== "all") {
          scopeVideos = app.allVideos.filter((video) => video.windowId === app.currentWindowId);
        }
        const groupVideos = scopeVideos.filter((v) => {
          const sid = liveSectionIdForVideo(v);
          const inSec = scopeId === "__unsorted" ? sid === undefined : sid === scopeId;
          if (!inSec) return false;
          if (app.groupingMode === "channel") {
            return (v.channelName || "Unknown Channel") === groupName;
          } else if (app.groupingMode === "language") {
            const stripped = v.languageName ? v.languageName.split('(')[0].trim() : "";
            const langName = stripped ? stripped : (v.language ? v.language.toUpperCase() : "Unspecified");
            return langName === groupName;
          }
          return false;
        });
        const allSelected =
          groupVideos.length > 0 && groupVideos.every((v) => selectedTabIds.has(v.id));
        groupVideos.forEach((v) => {
          if (allSelected) selectedTabIds.delete(v.id);
          else selectedTabIds.add(v.id);
        });
      }
      updateSelectionUI();
      return;
    }
    const groupToggle = target.closest(".group-toggle");
    if (groupToggle) {
      const groupName = (groupToggle as HTMLElement).dataset.group;
      if (groupName) {
        if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
        else collapsedGroups.add(groupName);
        applyFlatChannelGroupCollapseDom(groupName, collapsedGroups.has(groupName));
        app.lastTabListFingerprint = tabListStructureFingerprint();
      }
      return;
    }
    if (target.closest(".group-selection-toggle")) {
      event.stopPropagation();
      const groupEl = target.closest("[data-group]") as HTMLElement;
      const groupName = groupEl?.dataset.group;
      if (groupName) {
        let scopeVideos = app.allVideos;
        if (app.currentWindowId !== "all") {
          scopeVideos = app.allVideos.filter((video) => video.windowId === app.currentWindowId);
        }
        const videosInGroup = scopeVideos.filter((video) => {
          if (app.groupingMode === "channel") {
            return (video.channelName || "Unknown Channel") === groupName;
          } else if (app.groupingMode === "language") {
            const stripped = video.languageName ? video.languageName.split('(')[0].trim() : "";
            const langName = stripped ? stripped : (video.language ? video.language.toUpperCase() : "Unspecified");
            return langName === groupName;
          }
          return false;
        });
        const allSelected = videosInGroup.every((video) => selectedTabIds.has(video.id));
        videosInGroup.forEach((video) => {
          if (allSelected) selectedTabIds.delete(video.id);
          else selectedTabIds.add(video.id);
        });
        updateSelectionUI();
      }
    }
  });

  document.getElementById("tab-list")?.addEventListener("dragstart", (e) => {
    const t = e.target as HTMLElement;
    if (
      t.closest(
        "button, input, .session-selection-toggle, .selection-toggle, .session-open-new-tab, .session-remove-btn, .jump-btn, .close-btn, .nested-group-selection-toggle, .nested-group-toggle, .group-toggle, .section-collapse-toggle"
      )
    ) {
      e.preventDefault();
      return;
    }
    const sessionRow = t.closest("[data-session-tab-url]") as HTMLElement | null;
    if (sessionRow && app.selectedSession) {
      const url = sessionRow.getAttribute("data-session-tab-url");
      if (!url) return;
      e.dataTransfer?.setData(TAB_MANAGER_DRAG_MIME, JSON.stringify({ kind: "session", url }));
      e.dataTransfer!.effectAllowed = "move";
      sessionRow.classList.add("tab-card-dragging");
      return;
    }
    const liveRow = t.closest("[data-id]") as HTMLElement | null;
    if (liveRow && !app.selectedSession) {
      const id = parseInt(liveRow.dataset.id || "0", 10);
      if (Number.isNaN(id)) return;
      e.dataTransfer?.setData(TAB_MANAGER_DRAG_MIME, JSON.stringify({ kind: "live", tabId: id }));
      e.dataTransfer!.effectAllowed = "move";
      liveRow.classList.add("tab-card-dragging");
    }
    if (document.querySelector(".tab-card-dragging")) document.body.classList.add("is-dragging");
  });

  document.getElementById("tab-list")?.addEventListener("dragend", () => {
    document.querySelectorAll(".tab-card-dragging").forEach((el) => el.classList.remove("tab-card-dragging"));
    document.body.classList.remove("is-dragging");
    clearSectionDropHighlight();
  });

  const dropRoots = [document.getElementById("tab-list"), document.getElementById("facet-rail")];

  dropRoots.forEach((root) => root?.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MANAGER_DRAG_MIME)) return;
    const zone = (e.target as HTMLElement).closest("[data-section-wrapper]");
    setSectionDropHighlight(zone as HTMLElement | null);
    if (zone) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  }));

  dropRoots.forEach((root) => root?.addEventListener("drop", async (e) => {
    if (!e.dataTransfer?.types.includes(TAB_MANAGER_DRAG_MIME)) return;
    const zone = (e.target as HTMLElement).closest("[data-section-wrapper]");
    e.preventDefault();
    clearSectionDropHighlight();
    if (!zone) return;
    const raw = e.dataTransfer.getData(TAB_MANAGER_DRAG_MIME);
    const payload = parseTabManagerDrag(raw);
    if (!payload) return;
    const sectionKey = zone.getAttribute("data-section-wrapper");
    const targetSectionId = sectionKey === "__unsorted" || sectionKey == null ? null : sectionKey;

    if (payload.kind === "session") {
      if (!app.selectedSession) return;
      const secs = orderedSections(app.selectedSession.sections);
      const tab = (app.selectedSession.tabs ?? []).find((x) => (x.url ?? "") === payload.url);
      const cur = tab ? sessionTabSectionId(tab, secs) : undefined;
      const curNorm = cur ?? null;
      const tgtNorm = targetSectionId ?? null;
      if (curNorm === tgtNorm) return;
      await moveSessionTabsToSection([payload.url], targetSectionId);
    } else {
      if (app.selectedSession) return;
      const video = app.allVideos.find((v) => v.id === payload.tabId);
      if (!video) return;
      const cur = liveSectionIdForVideo(video);
      const curNorm = cur ?? null;
      const tgtNorm = targetSectionId ?? null;
      if (curNorm === tgtNorm) return;
      await moveLiveVideosToSection([payload.tabId], targetSectionId);
    }
  }));
}
