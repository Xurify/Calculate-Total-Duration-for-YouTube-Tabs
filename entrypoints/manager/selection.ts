import type { SavedSessionTab, SessionSection } from "../../utils/storage";
import { app } from "./state";
import { liveSectionIdForVideo, orderedSections, renderSectionPickerRows, sessionTabSectionId } from "./sections";
import { selectedSessionTabUrls, selectedTabIds } from "./state";

function updateSelectAllCheckbox() {
  const wrap = document.getElementById("select-all-wrap");
  const checkbox = document.getElementById("select-all-checkbox") as HTMLInputElement;
  const dashEl = wrap?.querySelector(".select-all-indeterminate-dash") as HTMLElement;
  if (!wrap || !checkbox) return;

  const inSessionView = app.selectedSession != null;
  const tabElements = document.querySelectorAll("#tab-list [data-session-tab-url]");
  const idElements = document.querySelectorAll("#tab-list [data-id]");
  const visibleUrls = inSessionView ? Array.from(tabElements).map((el) => (el as HTMLElement).getAttribute("data-session-tab-url")!) : [];
  const visibleIds = inSessionView ? [] : Array.from(idElements).map((el) => parseInt((el as HTMLElement).dataset.id || "0", 10));

  const count = inSessionView ? visibleUrls.length : visibleIds.length;
  if (count === 0) {
    wrap.classList.add("hidden");
    wrap.classList.remove("flex");
    return;
  }
  wrap.classList.remove("hidden");
  wrap.classList.add("flex");

  const allSelected = inSessionView
    ? visibleUrls.every((url) => selectedSessionTabUrls.has(url))
    : visibleIds.every((id) => selectedTabIds.has(id));
  const someSelected = inSessionView
    ? visibleUrls.some((url) => selectedSessionTabUrls.has(url))
    : visibleIds.some((id) => selectedTabIds.has(id));

  checkbox.checked = allSelected;
  checkbox.indeterminate = someSelected && !allSelected;
  if (dashEl) dashEl.style.opacity = checkbox.indeterminate ? "1" : "0";
}

function syncFlatGroupHeaderCheckboxes(): void {
  document.querySelectorAll(".group-selection-toggle").forEach((toggle) => {
    const groupName = (toggle as HTMLElement).dataset.group;
    if (!groupName) return;

    let scopeVideos = app.allVideos;
    if (app.currentWindowId !== "all") {
      scopeVideos = app.allVideos.filter((video) => video.windowId === app.currentWindowId);
    }
    const videosInGroup = scopeVideos.filter((video) => {
      if (app.groupingMode === "channel") {
        return (video.channelName || "Unknown Channel") === groupName;
      }
      if (app.groupingMode === "language") {
        const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
        const langName = stripped ? stripped : (video.language ? video.language.toUpperCase() : "Unspecified");
        return langName === groupName;
      }
      return false;
    });

    const allSelected = videosInGroup.length > 0 && videosInGroup.every((video) => selectedTabIds.has(video.id));
    const someSelected = videosInGroup.some((video) => selectedTabIds.has(video.id));
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    if (!checkbox) return;
    checkbox.checked = allSelected;
    checkbox.indeterminate = someSelected && !allSelected;
  });
}

function syncNestedGroupHeaderCheckboxes(): void {
  document.querySelectorAll(".nested-group-selection-toggle").forEach((toggle) => {
    const el = toggle as HTMLElement;
    const scopeId = el.dataset.nestedGroupScope;
    const groupName = el.dataset.nestedGroupName;
    if (!scopeId || !groupName) return;

    let allSelected = false;
    let someSelected = false;

    if (app.selectedSession) {
      const secs = orderedSections(app.selectedSession.sections);
      const inSection = (tab: SavedSessionTab) => {
        if (scopeId === "__unsorted") return !sessionTabSectionId(tab, secs);
        return sessionTabSectionId(tab, secs) === scopeId;
      };
      const groupTabs = (app.selectedSession.tabs ?? []).filter((tab) => {
        if (!inSection(tab)) return false;
        if (app.groupingMode === "channel") return (tab.channelName ?? "Unknown Channel") === groupName;
        if (app.groupingMode === "language") {
          const stripped = tab.languageName ? tab.languageName.split("(")[0].trim() : "";
          const langName = stripped ? stripped : (tab.language ? tab.language.toUpperCase() : "Unspecified");
          return langName === groupName;
        }
        return false;
      });
      const urls = groupTabs.map((tab) => tab.url ?? "").filter(Boolean);
      allSelected = urls.length > 0 && urls.every((url) => selectedSessionTabUrls.has(url));
      someSelected = urls.some((url) => selectedSessionTabUrls.has(url));
    } else {
      let scopeVideos = app.allVideos;
      if (app.currentWindowId !== "all") {
        scopeVideos = app.allVideos.filter((video) => video.windowId === app.currentWindowId);
      }
      const groupVideos = scopeVideos.filter((video) => {
        const sid = liveSectionIdForVideo(video);
        const inSec = scopeId === "__unsorted" ? sid === undefined : sid === scopeId;
        if (!inSec) return false;
        if (app.groupingMode === "channel") return (video.channelName || "Unknown Channel") === groupName;
        if (app.groupingMode === "language") {
          const stripped = video.languageName ? video.languageName.split("(")[0].trim() : "";
          const langName = stripped ? stripped : (video.language ? video.language.toUpperCase() : "Unspecified");
          return langName === groupName;
        }
        return false;
      });
      allSelected = groupVideos.length > 0 && groupVideos.every((video) => selectedTabIds.has(video.id));
      someSelected = groupVideos.some((video) => selectedTabIds.has(video.id));
    }

    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    if (!checkbox) return;
    checkbox.checked = allSelected;
    checkbox.indeterminate = someSelected && !allSelected;
  });
}

export function currentSectionsForMove(): SessionSection[] {
  if (app.selectedSession) return orderedSections(app.selectedSession.sections);
  return orderedSections(app.liveTabSectionsState.sections);
}

function moveToSectionPopoverSig(): string {
  const context = app.selectedSession ? `s:${app.selectedSession.id}` : "live";
  const sections = currentSectionsForMove();
  if (sections.length === 0) return `${context}\x1f0`;
  return `${context}\x1f${orderedSections(sections).map((s) => `${s.id}:${s.name}:${s.emoji ?? ""}:${s.colorIndex ?? 0}`).join("|")}`;
}

function updateMoveToSectionPopover(): void {
  const pop = document.getElementById("move-to-section-popover");
  if (!pop) return;
  const sig = moveToSectionPopoverSig();
  if (sig === app.lastMoveToSectionPopoverSig) return;
  app.lastMoveToSectionPopoverSig = sig;

  const sections = currentSectionsForMove();
  if (sections.length === 0) {
    pop.innerHTML = `<div class="px-3 py-2.5 text-[11px] text-text-muted leading-relaxed">Create a pile with <span class="text-text-secondary font-medium">New pile</span> first.</div>`;
    return;
  }
  pop.innerHTML = `
    <div class="menu-panel-header">Move to pile</div>
    <div class="px-1 pb-1">${renderSectionPickerRows(sections)}</div>
  `;
}

function selectionRowSyncSig(): string {
  const inSession = app.selectedSession != null;
  const sel = inSession
    ? [...selectedSessionTabUrls].sort().join("|")
    : [...selectedTabIds].sort((a, b) => a - b).join(",");
  return `${inSession ? "s" : "l"}:${app.selectedSession?.id ?? ""}:${app.layoutMode}:${sel}`;
}

export function applyTabListCheckboxIndeterminateFromAttr(): void {
  document.querySelectorAll("#tab-list input[type='checkbox']").forEach((checkbox) => {
    const input = checkbox as HTMLInputElement;
    if (input.getAttribute("indeterminate") != null) input.indeterminate = true;
  });
}

export function updateSelectionUI() {
  const bar = document.getElementById("selection-actions");
  const count = document.getElementById("selection-count");
  const closeBtn = document.getElementById("btn-close-selected");
  const moveWrap = document.getElementById("move-to-section-wrap");
  const stageSelectedBtn = document.getElementById("btn-stage-study-selected");

  const inSessionView = app.selectedSession != null;
  const selectionSize = inSessionView ? selectedSessionTabUrls.size : selectedTabIds.size;
  const hasSections = currentSectionsForMove().length > 0;

  if (stageSelectedBtn) {
    stageSelectedBtn.classList.toggle("hidden", inSessionView || app.isReadingListView);
  }

  if (selectionSize > 0 && !app.isReadingListView) {
    bar?.classList.remove("hidden");
    if (count) count.innerText = `${selectionSize} selected`;
    if (closeBtn) closeBtn.textContent = inSessionView ? "Remove from session" : "Close tabs";
    if (moveWrap) {
      if (hasSections) {
        moveWrap.classList.remove("hidden");
        updateMoveToSectionPopover();
      } else moveWrap.classList.add("hidden");
    }
  } else {
    bar?.classList.add("hidden");
    moveWrap?.classList.add("hidden");
    document.getElementById("move-to-section-popover")?.classList.add("hidden");
  }

  const rowSig = selectionRowSyncSig();
  const skipRowSync = !app.tabListContainerInnerHtmlUpdated && rowSig === app.lastSelectionRowSyncSig;

  if (!skipRowSync) {
    app.lastSelectionRowSyncSig = rowSig;
    updateSelectAllCheckbox();

    if (inSessionView) {
      document.querySelectorAll("#tab-list [data-session-tab-url]").forEach((row) => {
        const url = (row as HTMLElement).getAttribute("data-session-tab-url");
        const isSelected = url != null && selectedSessionTabUrls.has(url);
        const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
        if (checkbox) checkbox.checked = isSelected;
        if (isSelected) {
          row.classList.add("bg-surface-hover", "border-border", "ring-1", "ring-accent/50");
          row.querySelector(".session-selection-toggle")?.classList.add("opacity-100");
        } else {
          row.classList.remove("bg-surface-hover", "border-border", "ring-1", "ring-accent/50");
          row.querySelector(".session-selection-toggle")?.classList.remove("opacity-100");
        }
      });
      syncNestedGroupHeaderCheckboxes();
      return;
    }

    document.querySelectorAll('#tab-list [data-id]').forEach((row) => {
      const id = parseInt((row as HTMLElement).dataset.id || "0");
      const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
      const isSelected = selectedTabIds.has(id);
      if (checkbox) checkbox.checked = isSelected;

      if (app.layoutMode === 'list') {
        if (isSelected) row.classList.add('bg-surface-hover', 'border-border');
        else row.classList.remove('bg-surface-hover', 'border-border');
      } else {
        if (isSelected) row.classList.add('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');
        else row.classList.remove('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');

        const selectionToggle = row.querySelector('.selection-toggle');
        if (selectionToggle) {
          if (isSelected) selectionToggle.classList.add('opacity-100');
          else selectionToggle.classList.remove('opacity-100');
        }
      }
    });

    syncFlatGroupHeaderCheckboxes();
    syncNestedGroupHeaderCheckboxes();
  }
}
