import { mountCustomSelect } from "./custom-select";
import { updateSessionTabs } from "../../utils/storage";
import { summarizeDuplicates } from "../../utils/sessions";
import { app } from "./state";
import { type FacetKind, toggleFacet } from "./facets";
import { handleDeskKeydown } from "./keyboard";
import { plannedTabIds } from "./planner";
import { render } from "./render";
import { openAddSectionModal } from "./sections";
import { updateSelectionUI } from "./selection";
import { saveVideosAsSession, sessionTabMatchesUrl } from "./session-actions";
import { refreshSavedSessionsSidebar, sessionDisplayName } from "./sessions-sidebar";
import { saveSettings } from "./settings";
import { selectedSessionTabUrls, selectedTabIds } from "./state";
import { openStudySessionModal } from "./study-session";
import { closeVideoTabs, restoreSessionTabs } from "./tab-actions";
import { fetchTabs } from "./tabs";
import { plural } from "./time/html";
import { showToast } from "./toast";

const SORT_SELECT_OPTIONS = [
  { value: "started-first", label: "Started first" },
  { value: "index-asc", label: "Tab order" },
  { value: "duration-desc", label: "Longest first" },
  { value: "duration-asc", label: "Shortest first" },
  { value: "title-asc", label: "Title A to Z" },
  { value: "channel-asc", label: "Channel A to Z" },
] as const;

let searchDebounceTimeout: ReturnType<typeof setTimeout> | null = null;
const SEARCH_DEBOUNCE_MS = 200;

export function mountDeskSelects() {
  const sortSelectRoot = document.getElementById("sort-select");
  if (sortSelectRoot) {
    app.sortSelectHandle = mountCustomSelect(sortSelectRoot, {
      options: [...SORT_SELECT_OPTIONS],
      value: app.sortOption,
      compact: true,
      ariaLabel: "Sort by",
      onChange: (value) => {
        app.sortOption = value;
        saveSettings();
        render();
      },
    });
  }

  const restoreTargetRoot = document.getElementById("restore-target-window");
  if (restoreTargetRoot) {
    app.restoreTargetSelect = mountCustomSelect(restoreTargetRoot, {
      block: true,
      ariaLabel: "Open in",
      value: "new",
      options: [
        { value: "new", label: "New window" },
        { value: "current", label: "Current window" },
      ],
    });
  }

  const saveSessionTargetRoot = document.getElementById("save-session-target");
  if (saveSessionTargetRoot) {
    app.saveSessionTargetSelect = mountCustomSelect(saveSessionTargetRoot, {
      block: true,
      ariaLabel: "Existing session",
      options: [],
      value: "",
      onChange: () => app.onSaveSessionTargetChange?.(),
    });
    app.saveSessionTargetSelect.setHidden(true);
  }
}

export function wireDeskToolbar() {
  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    fetchTabs();
  });

  document.getElementById("btn-clear-selection")?.addEventListener("click", () => {
    selectedTabIds.clear();
    selectedSessionTabUrls.clear();
    updateSelectionUI();
    render();
  });

  document.getElementById("btn-close-selected")?.addEventListener("click", async () => {
    if (app.selectedSession) {
      const urls = Array.from(selectedSessionTabUrls);
      if (urls.length === 0) return;
      const session = app.selectedSession;
      const previousTabs = [...(session.tabs ?? [])];
      const newTabs = (app.selectedSession.tabs ?? []).filter(
        (sessionTab) => !urls.some((u) => sessionTabMatchesUrl(sessionTab, u))
      );
      await updateSessionTabs(app.selectedSession.id, newTabs);
      app.selectedSession.tabs = newTabs;
      selectedSessionTabUrls.clear();
      refreshSavedSessionsSidebar();
      updateSelectionUI();
      render();
      showToast(`Removed ${plural(urls.length, "video")} from "${sessionDisplayName(session).title}"`, {
        label: "Undo",
        run: () => restoreSessionTabs(session.id, previousTabs),
      });
      return;
    }
    const videos = app.allVideos.filter((video) => selectedTabIds.has(video.id));
    await closeVideoTabs(videos);
    selectedTabIds.clear();
    updateSelectionUI();
    fetchTabs();
  });

  document.getElementById("btn-stage-study-selected")?.addEventListener("click", () => {
    openStudySessionModal(Array.from(selectedTabIds));
  });

  document.getElementById("btn-stage-study-header")?.addEventListener("click", () => {
    openStudySessionModal();
  });

  document.getElementById("planner")?.addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-budget]");
    if (!chip) return;
    app.planBudgetMinutes = chip.dataset.budget === "all" ? null : Number(chip.dataset.budget);
    app.lastTabListFingerprint = "";
    render();
  });

  document.getElementById("btn-start-plan")?.addEventListener("click", () => {
    if (plannedTabIds.size === 0) return;
    openStudySessionModal(Array.from(plannedTabIds));
  });

  const onFacetClick = (event: Event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-pile-create]")) {
      openAddSectionModal();
      return;
    }
    if (target.closest(".sidebar-item")) return;
    const button = target.closest<HTMLElement>("[data-facet-kind]");
    if (!button) return;
    const kind = button.dataset.facetKind as FacetKind;
    const value = button.dataset.facetValue ?? "";
    toggleFacet(kind, value);
  };
  document.getElementById("facet-rail")?.addEventListener("click", onFacetClick);
  document.getElementById("time-bar")?.addEventListener("click", onFacetClick);
  document.getElementById("time-bar-rest")?.addEventListener("click", onFacetClick);
  document.getElementById("facet-clear")?.addEventListener("click", () => toggleFacet("all"));
  document.addEventListener("keydown", handleDeskKeydown);
}

export function wireViewControls() {
  const searchInput = document.getElementById("search-input") as HTMLInputElement | null;
  const searchClearBtn = document.getElementById("search-clear-btn") as HTMLButtonElement | null;

  function updateSearchClearBtnVisibility() {
    if (searchInput && searchClearBtn) {
      searchClearBtn.classList.toggle("hidden", searchInput.value === "");
    }
  }

  searchInput?.addEventListener("input", (event) => {
    const value = (event.target as HTMLInputElement).value;
    updateSearchClearBtnVisibility();
    if (searchDebounceTimeout != null) clearTimeout(searchDebounceTimeout);
    searchDebounceTimeout = setTimeout(() => {
      searchDebounceTimeout = null;
      app.searchQuery = value;
      render();
    }, SEARCH_DEBOUNCE_MS);
  });

  document.getElementById("tab-list")?.addEventListener("click", (event) => {
    if ((event.target as Element).closest('[data-empty-action="clear-search"]')) searchClearBtn?.click();
  });

  searchClearBtn?.addEventListener("click", () => {
    if (searchInput) {
      searchInput.value = "";
      updateSearchClearBtnVisibility();
    }
    if (searchDebounceTimeout != null) clearTimeout(searchDebounceTimeout);
    app.searchQuery = "";
    render();
  });

  document.getElementById("view-list")?.addEventListener("click", () => {
    app.groupingMode = "none";
    saveSettings();
    render();
  });
  document.getElementById("view-channel")?.addEventListener("click", () => {
    app.groupingMode = "channel";
    saveSettings();
    render();
  });
  document.getElementById("view-language")?.addEventListener("click", () => {
    app.groupingMode = "language";
    saveSettings();
    render();
  });

  document.getElementById("layout-list")?.addEventListener("click", () => {
    app.layoutMode = "list";
    saveSettings();
    render();
  });
  document.getElementById("layout-grid")?.addEventListener("click", () => {
    app.layoutMode = "grid";
    saveSettings();
    render();
  });

  document.getElementById("btn-filter-duplicates")?.addEventListener("click", () => {
    if (app.showDuplicatesOnly) {
      app.showDuplicatesOnly = false;
    } else {
      const summary = summarizeDuplicates(app.scopeVideoIdCounts);
      if (summary.duplicateVideoCount === 0) return;
      app.showDuplicatesOnly = true;
    }
    render();
  });

  document.getElementById("btn-save-session")?.addEventListener("click", async () => {
    await saveVideosAsSession(app.allVideos);
  });

  document.getElementById("select-all-checkbox")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const inSessionView = app.selectedSession != null;
    const tabElements = document.querySelectorAll("#tab-list [data-session-tab-url]");
    const idElements = document.querySelectorAll("#tab-list [data-id]");
    const visibleUrls = inSessionView ? Array.from(tabElements).map((el) => (el as HTMLElement).getAttribute("data-session-tab-url")!) : [];
    const visibleIds = inSessionView ? [] : Array.from(idElements).map((el) => parseInt((el as HTMLElement).dataset.id || "0", 10));
    const checkbox = document.getElementById("select-all-checkbox") as HTMLInputElement;
    const allSelected = inSessionView
      ? visibleUrls.every((url) => selectedSessionTabUrls.has(url))
      : visibleIds.every((id) => selectedTabIds.has(id));
    if (allSelected) {
      if (inSessionView) visibleUrls.forEach((url) => selectedSessionTabUrls.delete(url));
      else visibleIds.forEach((id) => selectedTabIds.delete(id));
    } else {
      if (inSessionView) visibleUrls.forEach((url) => selectedSessionTabUrls.add(url));
      else visibleIds.forEach((id) => selectedTabIds.add(id));
    }
    updateSelectionUI();
  });
}
