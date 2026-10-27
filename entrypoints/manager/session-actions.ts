import { closeAllCustomSelects } from "./custom-select";
import {
  VideoData,
  normalizeYoutubeUrl,
  getSavedSessions,
  saveSession,
  replaceSession,
  mergeIntoSession,
  type SavedSessionTab,
  type SavedSession,
  type SessionSection,
} from "../../utils/storage";
import { formatDurationWords } from "../../utils/format";
import {
  buildTabsFromVideos,
  countItemsByVideoId,
  findSimilarSession,
  sessionsOverlapScore,
  sessionVideoIds,
  sessionTotalSeconds,
  suggestSessionName,
  summarizeDuplicates,
  videoIdFromTabUrl,
  type SaveSessionPayload,
} from "../../utils/sessions";
import { app } from "./state";
import { orderedSections, partitionSessionTabsBySection } from "./sections";
import { AUTO_SESSION_NAME, refreshSavedSessionsSidebar, sessionDisplayName } from "./sessions-sidebar";
import { createTabsBatched, filterUrlsMissingOnly, getOpenVideoIds } from "./tab-actions";
import { plural } from "./time/html";
import { showToast } from "./toast";

interface RestoreSessionOptions {
  target: "new" | "current";
  missingOnly: boolean;
  bySections: boolean;
}

async function restoreSession(session: SavedSession, options: RestoreSessionOptions): Promise<number> {
  const tabs = session.tabs ?? [];
  if (tabs.length === 0) return 0;

  const openIds = options.missingOnly ? await getOpenVideoIds() : null;

  if (options.bySections && orderedSections(session.sections).length > 0) {
    const secs = orderedSections(session.sections);
    const { blocks, unsorted } = partitionSessionTabsBySection(tabs, secs);
    const groups: SavedSessionTab[][] = blocks.map((b) => b.tabs);
    if (unsorted.length > 0) groups.push(unsorted);

    let opened = 0;
    for (const group of groups) {
      let urls = group.map((t) => normalizeYoutubeUrl(t.url)).filter((u) => u.length > 0);
      if (openIds) urls = filterUrlsMissingOnly(urls, openIds);
      if (urls.length === 0) continue;

      if (options.target === "current") {
        const currentWin = await browser.windows.getCurrent();
        opened += await createTabsBatched(urls, currentWin.id);
        continue;
      }

      const win = await browser.windows.create({ url: urls[0] });
      if (!win?.id) continue;
      opened += 1;
      if (urls.length > 1) opened += await createTabsBatched(urls.slice(1), win.id);
    }
    return opened;
  }

  let urls = tabs.map((t) => normalizeYoutubeUrl(t.url)).filter((u) => u.length > 0);
  if (openIds) urls = filterUrlsMissingOnly(urls, openIds);
  if (urls.length === 0) return 0;

  if (options.target === "current") {
    const currentWin = await browser.windows.getCurrent();
    return createTabsBatched(urls, currentWin.id);
  }

  const win = await browser.windows.create({ url: urls[0] });
  if (!win?.id) return 0;
  if (urls.length === 1) return 1;
  return 1 + (await createTabsBatched(urls.slice(1), win.id));
}

async function showRestoreSessionModal(session: SavedSession): Promise<RestoreSessionOptions | null> {
  closeAllCustomSelects();
  return new Promise((resolve) => {
    const modal = document.getElementById("restore-session-modal");
    const titleEl = document.getElementById("restore-session-title");
    const summaryEl = document.getElementById("restore-session-summary");
    const targetSelect = app.restoreTargetSelect;
    const missingOnly = document.getElementById("restore-missing-only") as HTMLInputElement;
    const bySections = document.getElementById("restore-by-sections") as HTMLInputElement;
    const cancelBtn = document.getElementById("restore-session-cancel");
    const confirmBtn = document.getElementById("restore-session-confirm");
    if (!modal || !targetSelect || !missingOnly || !bySections || !cancelBtn || !confirmBtn) {
      resolve(null);
      return;
    }
    if (titleEl) titleEl.textContent = `Open "${sessionDisplayName(session).title}"`;
    const tabCount = session.tabs?.length ?? 0;
    const duration = formatDurationWords(sessionTotalSeconds(session.tabs ?? []));
    if (summaryEl) summaryEl.textContent = `${plural(tabCount, "video")} · ${duration} to watch`;
    const hasSections = orderedSections(session.sections).length > 0;
    bySections.disabled = !hasSections;
    bySections.checked = false;
    missingOnly.checked = false;
    targetSelect.setValue("new");

    const close = (result: RestoreSessionOptions | null) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      modal.removeEventListener("click", onBackdrop);
    };
    const onCancel = () => close(null);
    const onConfirm = () =>
      close({
        target: targetSelect.getValue() === "current" ? "current" : "new",
        missingOnly: missingOnly.checked,
        bySections: bySections.checked && hasSections,
      });
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "restore-session-modal") close(null);
    };
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    modal.addEventListener("click", onBackdrop);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
  });
}

interface SaveSessionModalOptions {
  defaultName: string;
  tabs: SavedSessionTab[];
  tabCount: number;
  duplicateExtraTabs: number;
  sessions: SavedSession[];
  similarSession: SavedSession | null;
  similarScore: number;
}

async function showSaveSessionModal(options: SaveSessionModalOptions): Promise<SaveSessionPayload | null> {
  closeAllCustomSelects();
  return new Promise((resolve) => {
    const modal = document.getElementById("save-session-modal");
    const input = document.getElementById("save-session-input") as HTMLInputElement;
    const summaryEl = document.getElementById("save-session-summary");
    const targetSelect = app.saveSessionTargetSelect;
    const hintEl = document.getElementById("save-session-duplicate-hint");
    const cancelBtn = document.getElementById("save-session-cancel");
    const confirmBtn = document.getElementById("save-session-confirm");
    const modeInputs = modal?.querySelectorAll('input[name="save-session-mode"]') as NodeListOf<HTMLInputElement> | undefined;
    if (!modal || !input || !targetSelect || !cancelBtn || !confirmBtn || !modeInputs) {
      resolve(null);
      return;
    }

    // An automatic "Session 10/27/26, 12:26 AM" name is shown by what it holds on the Saved sessions page,
    // so the field offers that name as its placeholder instead of a timestamp nobody will see again.
    const autoTitle = AUTO_SESSION_NAME.test(options.defaultName)
      ? sessionDisplayName({ id: "", name: options.defaultName, savedAt: Date.now(), tabs: options.tabs }).title
      : null;
    input.value = autoTitle ? "" : options.defaultName;
    input.placeholder = autoTitle ?? "Session name";
    const summaryParts = [`Saving ${options.tabCount} tab${options.tabCount === 1 ? "" : "s"} from this view`];
    if (options.duplicateExtraTabs > 0) {
      summaryParts.push(
        `${options.duplicateExtraTabs} duplicate tab${options.duplicateExtraTabs === 1 ? "" : "s"} will be merged into one entry per video`
      );
    }
    if (summaryEl) summaryEl.textContent = summaryParts.join(" · ");

    targetSelect.setOptions(
      options.sessions.map((s) => ({
        value: s.id,
        label: `${sessionDisplayName(s).title} (${plural(s.tabs?.length ?? 0, "video")})`,
      }))
    );

    const incomingIds = sessionVideoIds(options.tabs);
    const currentMode = () => [...modeInputs].find((r) => r.checked)?.value ?? "new";
    /** Says what the chosen action does to the chosen session, so a merge that adds nothing or a replace that drops videos isn't a surprise. */
    const syncHint = () => {
      if (!hintEl) return;
      const mode = currentMode();
      const target = mode === "new" ? options.similarSession : options.sessions.find((s) => s.id === targetSelect.getValue());
      if (!target) {
        hintEl.classList.add("hidden");
        return;
      }
      const name = sessionDisplayName(target).title;
      const targetIds = sessionVideoIds(target.tabs ?? []);
      let already = 0;
      for (const id of incomingIds) if (targetIds.has(id)) already += 1;
      const fresh = incomingIds.size - already;
      const dropped = targetIds.size - already;
      let text: string;
      if (mode === "replace") {
        text = dropped > 0
          ? `"${name}" loses ${plural(dropped, "video")} that aren't on the desk now.`
          : `"${name}" keeps all its videos and gets ${plural(fresh, "new one")}.`;
      } else if (mode === "merge") {
        text = fresh === 0
          ? `All ${plural(incomingIds.size, "video")} are already in "${name}", so merging changes nothing.`
          : `${already} of ${incomingIds.size} are already in "${name}". Merging adds ${plural(fresh, "new video")}.`;
      } else {
        text = `These videos are mostly saved already, in "${name}".`;
      }
      hintEl.textContent = text;
      hintEl.classList.remove("hidden");
    };

    const syncTargetVisibility = () => {
      const mode = currentMode();
      const showTarget = mode === "replace" || mode === "merge";
      confirmBtn.textContent = mode === "replace" ? "Replace session" : mode === "merge" ? "Merge" : "Save";
      targetSelect.setHidden(!showTarget || options.sessions.length === 0);
      if (showTarget && options.similarSession) {
        targetSelect.setValue(options.similarSession.id);
      } else if (showTarget && options.sessions[0]) {
        targetSelect.setValue(options.sessions[0].id);
      }
      syncHint();
    };
    app.onSaveSessionTargetChange = syncHint;

    if (options.similarSession) {
      // Merge keeps everything in both lists, so a wrong guess costs nothing.
      const mergeRadio = [...modeInputs].find((r) => r.value === "merge");
      if (mergeRadio) mergeRadio.checked = true;
      targetSelect.setValue(options.similarSession.id);
    } else {
      const newRadio = [...modeInputs].find((r) => r.value === "new");
      if (newRadio) newRadio.checked = true;
    }
    syncTargetVisibility();

    const close = (result: SaveSessionPayload | null) => {
      modal.classList.add("hidden");
      modal.classList.remove("flex", "items-center", "justify-center");
      modeInputs.forEach((r) => r.removeEventListener("change", syncTargetVisibility));
      app.onSaveSessionTargetChange = null;
      resolve(result);
      cancelBtn.removeEventListener("click", onCancel);
      confirmBtn.removeEventListener("click", onConfirm);
      modal.removeEventListener("click", onBackdrop);
      input.removeEventListener("keydown", onKeydown);
    };
    const onCancel = () => close(null);
    const onConfirm = () => {
      const mode = ([...modeInputs].find((r) => r.checked)?.value ?? "new") as SaveSessionPayload["mode"];
      const name = input.value.trim() || options.defaultName;
      if ((mode === "replace" || mode === "merge") && !targetSelect.getValue()) {
        showToast("Choose a session to update.");
        return;
      }
      close({
        name,
        mode,
        targetSessionId: mode === "new" ? undefined : targetSelect.getValue(),
      });
    };
    const onBackdrop = (event: MouseEvent) => {
      if ((event.target as HTMLElement).id === "save-session-modal") close(null);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(null);
      if (event.key === "Enter") onConfirm();
    };
    modeInputs.forEach((r) => r.addEventListener("change", syncTargetVisibility));
    cancelBtn.addEventListener("click", onCancel);
    confirmBtn.addEventListener("click", onConfirm);
    modal.addEventListener("click", onBackdrop);
    input.addEventListener("keydown", onKeydown);
    modal.classList.remove("hidden");
    modal.classList.add("flex", "items-center", "justify-center");
    requestAnimationFrame(() => input.focus());
  });
}

async function executeSaveSession(
  payload: SaveSessionPayload,
  tabs: SavedSessionTab[],
  sections: SessionSection[]
): Promise<void> {
  const secs = sections.length > 0 ? sections : undefined;
  if (payload.mode === "replace" && payload.targetSessionId) {
    const updated = await replaceSession(payload.targetSessionId, payload.name, tabs, secs);
    if (!updated) throw new Error("Session not found");
    showToast(`Updated "${payload.name}" (${plural(tabs.length, "video")})`);
    return;
  }
  if (payload.mode === "merge" && payload.targetSessionId) {
    const merged = await mergeIntoSession(payload.targetSessionId, tabs, secs);
    if (!merged) throw new Error("Session not found");
    showToast(`Merged into "${merged.name}"`);
    return;
  }
  await saveSession(payload.name, tabs, secs);
  const shownName = sessionDisplayName({ id: "", name: payload.name, savedAt: Date.now(), tabs }).title;
  showToast(`Saved "${shownName}" (${plural(tabs.length, "video")})`);
}

export async function saveVideosAsSession(videos: VideoData[], windowLabel?: string): Promise<void> {
  const liveSecs = orderedSections(app.liveTabSectionsState.sections);
  const { tabs, sections } = buildTabsFromVideos(
    videos,
    app.liveTabSectionsState.assignments,
    liveSecs,
    { excludeHidden: true }
  );
  if (tabs.length === 0) {
    showToast("No YouTube tabs to save.");
    return;
  }
  const sessions = await getSavedSessions();
  const similar = findSimilarSession(sessions, tabs);
  const similarScore = similar ? sessionsOverlapScore(tabs, similar.tabs ?? []) : 0;
  const includedVideos = videos.filter((video) => !video.excluded);
  const duplicateExtraTabs = summarizeDuplicates(countItemsByVideoId(includedVideos, (video) => video.url)).extraTabCount;
  const defaultName = suggestSessionName(tabs, windowLabel, sections);
  const payload = await showSaveSessionModal({
    defaultName,
    tabs,
    tabCount: tabs.length,
    duplicateExtraTabs,
    sessions,
    similarSession: similar,
    similarScore,
  });
  if (!payload) return;
  try {
    await executeSaveSession(payload, tabs, sections);
    app.lastSavedSessionsFingerprint = "";
    await refreshSavedSessionsSidebar();
  } catch (error) {
    console.error("Save session failed:", error);
    showToast(error instanceof Error ? error.message : "Could not save session.");
  }
}

export async function loadSessionInNewWindow(sessionId: string) {
  const sessions = await getSavedSessions();
  const session = sessions.find((saved) => saved.id === sessionId);
  if (!session) return;
  const options = await showRestoreSessionModal(session);
  if (!options) return;
  try {
    const opened = await restoreSession(session, options);
    showToast(opened > 0 ? `Opened ${opened} tab${opened === 1 ? "" : "s"}` : "All tabs from this session are already open.");
  } catch (error) {
    console.error("Restore session failed:", error);
    showToast("Could not open session tabs.");
  }
}

export function openSessionVideoInNewTab(url: string) {
  return browser.tabs.create({ url });
}

export async function openOrFocusSessionVideo(url: string) {
  const normalizedTargetUrl = normalizeYoutubeUrl(url);
  const allTabs = await browser.tabs.query({});
  const existingTab = allTabs.find((tab) => {
    if (!tab.url) return false;
    return normalizeYoutubeUrl(tab.url) === normalizedTargetUrl;
  });

  if (existingTab?.id != null) {
    await browser.tabs.update(existingTab.id, { active: true });
    if (existingTab.windowId != null) {
      await browser.windows.update(existingTab.windowId, { focused: true });
    }
    return;
  }

  return browser.tabs.create({ url });
}

export async function focusLiveVideoTab(video: VideoData) {
  await browser.tabs.update(video.id, { active: true });
  if (video.windowId != null) {
    await browser.windows.update(video.windowId, { focused: true });
  }
}

export function sessionTabMatchesUrl(tab: SavedSessionTab, url: string): boolean {
  const a = videoIdFromTabUrl(tab.url ?? "");
  const b = videoIdFromTabUrl(url);
  if (a && b) return a === b;
  return (tab.url ?? "") === url;
}
