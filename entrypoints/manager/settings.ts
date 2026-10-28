import { savePrefs, clearCache, exportSessionsJson, importSessionsJson } from "../../utils/storage";
import { focusKeyOf, saveFocusLanguages } from "../../utils/focusLanguages";
import { languageCodeOf, languageFlagHtml } from "../../utils/languageFlags";
import { formatMinutesWords, type TimeSummaryResponse } from "../../utils/timeUi";
import { app } from "./state";
import { showConfirm } from "./dialogs";
import { DETECTING_LANGUAGE, UNKNOWN_LANGUAGE } from "./facets";
import { render } from "./render";
import { refreshSavedSessionsSidebar } from "./sessions-sidebar";
import { fetchTabs, storeState } from "./tabs";
import { renderTimePanel } from "./time/panel";
import { showToast } from "./toast";
import { escapeHtml } from "./util";

/** How far back the language list looks for languages you have watched. */
const FOCUS_CANDIDATE_DAYS = 90;
let watchedLanguages: { label: string; seconds: number }[] = [];
let displayNames: Intl.DisplayNames | null = null;

function languageDisplayName(label: string): string {
  const code = languageCodeOf(label);
  let name = label;
  if (code) {
    try {
      displayNames ??= new Intl.DisplayNames([navigator.language, "en"], { type: "language" });
      name = displayNames.of(code) ?? label;
    } catch {}
  }
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}

function focusCandidates(): { key: string; label: string; seconds: number }[] {
  const byKey = new Map<string, { key: string; label: string; seconds: number }>();
  const add = (label: string, seconds: number) => {
    if (!label || label === UNKNOWN_LANGUAGE || label === DETECTING_LANGUAGE) return;
    const key = focusKeyOf(label);
    const row = byKey.get(key) ?? { key, label, seconds: 0 };
    row.seconds += seconds;
    byKey.set(key, row);
  };
  for (const row of watchedLanguages) add(row.label, row.seconds);
  for (const video of app.allVideos) {
    const label = video.languageName ? video.languageName.split("(")[0].trim() : video.language ? video.language.toUpperCase() : "";
    add(label, 0);
  }
  for (const key of app.focusLanguages) add(key, 0);
  return [...byKey.values()].sort((first, second) => second.seconds - first.seconds || languageDisplayName(first.label).localeCompare(languageDisplayName(second.label)));
}

function renderFocusLanguageList(): void {
  const list = document.getElementById("focus-language-list");
  if (!list) return;
  const chosen = new Set(app.focusLanguages);
  const candidates = focusCandidates();
  const keys = candidates.map((row) => row.key).join("|");
  // Ticking a box only flips checks, so focus stays on the box and the list doesn't jump.
  if (list.dataset.keys === keys && list.childElementCount > 0) {
    for (const box of list.querySelectorAll<HTMLInputElement>("input[data-focus-key]")) box.checked = chosen.has(box.dataset.focusKey ?? "");
  } else {
    list.dataset.keys = keys;
    list.innerHTML = candidates.length
    ? candidates
        .map((row) => {
          const name = languageDisplayName(row.label);
          return `<label class="focus-language-option" title="${escapeHtml(row.seconds >= 60 ? `${name}: ${formatMinutesWords(row.seconds)} in the last ${FOCUS_CANDIDATE_DAYS} days` : name)}">
            <input type="checkbox" class="ui-check" data-focus-key="${escapeHtml(row.key)}"${chosen.has(row.key) ? " checked" : ""} />
            ${languageFlagHtml(row.label, "lang-flag lang-flag--sm shrink-0")}<span class="truncate">${escapeHtml(name)}</span>
          </label>`;
        })
        .join("")
    : `<p class="text-xs text-text-muted m-0">Languages show up here once you watch something.</p>`;
  }
  document.getElementById("focus-languages-clear")?.classList.toggle("hidden", chosen.size === 0);
  const hint = document.getElementById("focus-languages-hint");
  if (hint) {
    hint.textContent =
      chosen.size === 0
        ? "Pick the ones you care about. The rest is still counted, as Other."
        : "Only these get their own rows and colours on the Time page, the desk and the popup. The rest is counted as Other.";
  }
}

async function loadWatchedLanguages(): Promise<void> {
  try {
    const data = (await browser.runtime.sendMessage({ action: "get-time-summary", days: FOCUS_CANDIDATE_DAYS })) as TimeSummaryResponse | undefined;
    watchedLanguages = data?.watch?.byLanguage.map((row) => ({ label: row.label, seconds: row.seconds })) ?? [];
  } catch {
    watchedLanguages = [];
  }
  renderFocusLanguageList();
}

export function applyFocusLanguages(keys: string[]): void {
  app.focusLanguages = keys;
  app.lastFacetRailHtml = "";
  app.lastTabListFingerprint = "";
  app.lastSavedSessionsFingerprint = "";
  render();
  void refreshSavedSessionsSidebar();
  if (app.isTimeView) void renderTimePanel();
  renderFocusLanguageList();
}

export function openSettings(scrollToId?: string): void {
  app.isSettingsOpen = true;
  render();
  renderFocusLanguageList();
  void loadWatchedLanguages();
  if (scrollToId) document.getElementById(scrollToId)?.scrollIntoView({ block: "nearest" });
}

export function saveSettings(): void {
  void savePrefs({
    thumbnailQuality: app.thumbnailQuality,
    layoutMode: app.layoutMode,
    groupingMode: app.groupingMode,
    sortOption: app.sortOption,
  }).catch((error) => {
    console.warn("Failed to save settings:", error);
  });
}

export function wireSettings() {
  document.getElementById("btn-settings")?.addEventListener("click", () => openSettings());

  document.getElementById("focus-language-list")?.addEventListener("change", (event) => {
    const box = event.target;
    if (!(box instanceof HTMLInputElement) || !box.dataset.focusKey) return;
    const key = box.dataset.focusKey;
    const next = box.checked ? [...app.focusLanguages, key] : app.focusLanguages.filter((each) => each !== key);
    applyFocusLanguages(next);
    void saveFocusLanguages(next);
  });
  document.getElementById("focus-languages-clear")?.addEventListener("click", () => {
    applyFocusLanguages([]);
    void saveFocusLanguages([]);
  });
  const closeSettings = () => {
    if (!app.isSettingsOpen) return;
    app.isSettingsOpen = false;
    render();
    document.getElementById("btn-settings")?.focus();
  };
  document.getElementById("close-settings")?.addEventListener("click", closeSettings);
  document.getElementById("settings-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && app.isSettingsOpen && !document.querySelector("#confirm-modal:not(.hidden), #shortcuts-modal:not(.hidden)")) closeSettings();
  });

  document.getElementById("quality-standard")?.addEventListener("click", () => {
    app.thumbnailQuality = "standard";
    saveSettings();
    render();
  });

  document.getElementById("quality-high")?.addEventListener("click", () => {
    app.thumbnailQuality = "high";
    saveSettings();
    render();
  });

  document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
    const confirmed = await showConfirm({
      title: "Clear video details?",
      message: "Saved titles and lengths are forgotten and load again from open tabs. Sessions, history and settings stay.",
      confirmLabel: "Clear",
      confirmDanger: true,
    });
    if (confirmed) {
      await clearCache();
      storeState.metadataCache = {};
      await fetchTabs();
      app.isSettingsOpen = false;
      document.getElementById("settings-modal")?.classList.add("hidden");
    }
  });

  document.getElementById("btn-export-sessions")?.addEventListener("click", async () => {
    try {
      const json = await exportSessionsJson();
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `youtube-tab-sessions-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      showToast("Sessions exported.");
    } catch (error) {
      console.error("Export failed:", error);
      showToast("Could not export sessions.");
    }
  });

  document.getElementById("import-sessions-file")?.addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const merge = await showConfirm({
        title: "Import sessions",
        message: "Merge imported sessions with your existing saved sessions?",
        confirmLabel: "Merge",
        cancelLabel: "Not now",
      });
      if (!merge) {
        const replace = await showConfirm({
          title: "Replace all sessions?",
          message: "Replace every saved session with only the sessions from this file? This cannot be undone.",
          confirmLabel: "Replace all",
          confirmDanger: true,
        });
        if (!replace) return;
        const count = await importSessionsJson(text, "replace");
        app.lastSavedSessionsFingerprint = "";
        await refreshSavedSessionsSidebar();
        showToast(`Replaced with ${count} imported session${count === 1 ? "" : "s"}.`);
        return;
      }
      const count = await importSessionsJson(text, "merge");
      app.lastSavedSessionsFingerprint = "";
      await refreshSavedSessionsSidebar();
      showToast(`Imported ${count} session${count === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("Import failed:", error);
      showToast(error instanceof Error ? error.message : "Could not import sessions.");
    }
  });

  document.getElementById("btn-perf-refresh")?.addEventListener("click", async () => {
    const container = document.getElementById("dev-perf-list");
    if (!container) return;
    container.innerHTML = "<span class='text-text-muted/70'>Fetching…</span>";
    const rows: string[] = [];
    for (const video of app.allVideos) {
      try {
        const stats = await browser.tabs.sendMessage(video.id, { action: "get-perf-stats" }) as {
          totalMutations?: number;
          totalReads?: number;
          ratio?: string;
          debounceMs?: number;
        } | undefined;
        if (stats && typeof stats.totalMutations === "number") {
          const title = video.title.slice(0, 20) + (video.title.length > 20 ? "…" : "");
          rows.push(`Tab ${video.id} · ${title} · mut: ${stats.totalMutations} read: ${stats.totalReads ?? "—"} ratio: ${stats.ratio ?? "—"}`);
        } else {
          rows.push(`Tab ${video.id} · (no content script)`);
        }
      } catch {
        rows.push(`Tab ${video.id} · (unavailable)`);
      }
    }
    if (rows.length === 0) {
      container.innerHTML = "<span class='text-text-muted/70'>No YouTube tabs open</span>";
    } else {
      container.innerHTML = rows.map((row) => `<div class="truncate" title="${escapeHtml(row)}">${escapeHtml(row)}</div>`).join("");
    }
  });
}
