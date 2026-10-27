import {
  getSavedSessions,
  mergeIntoSession,
  duplicateSession,
  deleteSession,
  renameSession,
  setSessionPinned,
} from "../../utils/storage";
import { buildTabsFromVideos } from "../../utils/sessions";
import { app } from "./state";
import { showConfirm, showNameSessionModal } from "./dialogs";
import { render } from "./render";
import { orderedSections, reloadSelectedSessionFromStorage } from "./sections";
import { loadSessionInNewWindow, saveVideosAsSession } from "./session-actions";
import { refreshSavedSessionsSidebar } from "./sessions-sidebar";
import { selectedSessionTabUrls } from "./state";
import { showToast } from "./toast";

export function wireSessionContextMenu() {
  document.getElementById("ctx-save")?.addEventListener("click", async () => {
    const context = app.sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (!context || (context.type !== "all" && context.type !== "window")) return;
    const videosToSave =
      context.type === "all" ? app.allVideos : app.allVideos.filter((video) => video.windowId === context.windowId);
    const windowLabel =
      context.type === "window"
        ? app.windowGroups.find((g) => g.id === context.windowId)?.label
        : undefined;
    await saveVideosAsSession(videosToSave, windowLabel);
  });

  document.getElementById("ctx-add-to-session")?.addEventListener("click", async () => {
    const context = app.sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const liveSecs = orderedSections(app.liveTabSectionsState.sections);
    const { tabs, sections } = buildTabsFromVideos(
      app.allVideos,
      app.liveTabSectionsState.assignments,
      liveSecs,
      { excludeHidden: true }
    );
    if (tabs.length === 0) {
      showToast("No YouTube tabs to add.");
      return;
    }
    const sessions = await getSavedSessions();
    const session = sessions.find((s) => s.id === context.sessionId);
    if (!session) return;
    const confirmed = await showConfirm({
      title: "Add to session",
      message: `Add ${tabs.length} tab${tabs.length === 1 ? "" : "s"} to "${session.name}"?`,
      confirmLabel: "Add",
    });
    if (!confirmed) return;
    try {
      const merged = await mergeIntoSession(context.sessionId, tabs, sections.length > 0 ? sections : undefined);
      app.lastSavedSessionsFingerprint = "";
      await refreshSavedSessionsSidebar();
      if (app.selectedSession?.id === context.sessionId) await reloadSelectedSessionFromStorage();
      showToast(merged ? `Added tabs to "${merged.name}"` : "Could not update session.");
      render();
    } catch (error) {
      console.error("Add to session failed:", error);
      showToast(error instanceof Error ? error.message : "Could not add tabs.");
    }
  });

  document.getElementById("ctx-duplicate-session")?.addEventListener("click", async () => {
    const context = app.sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const sessions = await getSavedSessions();
    const session = sessions.find((s) => s.id === context.sessionId);
    if (!session) return;
    try {
      const copy = await duplicateSession(context.sessionId);
      app.lastSavedSessionsFingerprint = "";
      await refreshSavedSessionsSidebar();
      showToast(copy ? `Duplicated as "${copy.name}"` : "Could not duplicate session.");
    } catch (error) {
      console.error("Duplicate session failed:", error);
      showToast(error instanceof Error ? error.message : "Could not duplicate session.");
    }
  });

  document.getElementById("ctx-open-tabs")?.addEventListener("click", async () => {
    const context = app.sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type === "session" && context.sessionId) {
      await loadSessionInNewWindow(context.sessionId);
    }
  });

  document.getElementById("ctx-rename-session")?.addEventListener("click", async () => {
    const context = app.sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const sessions = await getSavedSessions();
    const session = sessions.find((saved) => saved.id === context.sessionId);
    if (!session) return;
    const name = await showNameSessionModal(session.name, "Rename session");
    if (name === null) return;
    const trimmed = name.trim();
    const nextName = trimmed.length > 0 ? trimmed : "Untitled";
    if (nextName === session.name) return;
    try {
      await renameSession(context.sessionId, nextName);
      await reloadSelectedSessionFromStorage();
      await refreshSavedSessionsSidebar();
      showToast(`Renamed to "${nextName}"`);
      render();
    } catch (error) {
      console.error("Rename session failed:", error);
      showToast("Could not rename session.");
    }
  });

  document.getElementById("ctx-pin")?.addEventListener("click", async () => {
    const context = app.sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const sessions = await getSavedSessions();
    const session = sessions.find((saved) => saved.id === context.sessionId);
    if (!session) return;
    await setSessionPinned(context.sessionId, !session.pinned);
    app.lastSavedSessionsFingerprint = "";
    refreshSavedSessionsSidebar();
  });

  document.getElementById("ctx-delete")?.addEventListener("click", async () => {
    const context = app.sidebarContextTarget;
    document.getElementById("sidebar-context-menu")?.classList.add("hidden");
    if (context?.type !== "session" || !context.sessionId) return;
    const confirmed = await showConfirm({
      title: "Delete session",
      message: "Delete this saved session?",
      confirmLabel: "Delete",
      confirmDanger: true,
    });
    if (confirmed) {
      const deletedId = context.sessionId;
      await deleteSession(deletedId);
      if (app.selectedSession?.id === deletedId) {
        app.selectedSession = null;
        selectedSessionTabUrls.clear();
        app.currentWindowId = "all";
        render();
      }
      app.lastSavedSessionsFingerprint = "";
      refreshSavedSessionsSidebar();
    }
  });

  document.getElementById("session-sidebar-search")?.addEventListener("input", (event) => {
    app.sessionSidebarSearch = (event.target as HTMLInputElement).value;
    app.lastSavedSessionsFingerprint = "";
    void refreshSavedSessionsSidebar();
  });
  document.getElementById("session-sidebar-search")?.addEventListener("keydown", (event) => {
    const input = event.target as HTMLInputElement;
    if (event.key !== "Escape" || input.value === "") return;
    event.stopPropagation();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
