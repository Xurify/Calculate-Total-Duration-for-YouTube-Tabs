import { savePrefs, clearCache, exportSessionsJson, importSessionsJson } from "../../utils/storage";
import { app } from "./state";
import { showConfirm } from "./dialogs";
import { render } from "./render";
import { refreshSavedSessionsSidebar } from "./sessions-sidebar";
import { fetchTabs, storeState } from "./tabs";
import { showToast } from "./toast";
import { escapeHtml } from "./util";

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
  document.getElementById("btn-settings")?.addEventListener("click", () => {
    app.isSettingsOpen = true;
    render();
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
