import { popup } from "./state";
import { renderPopupLanguages } from "./languages";
import { bindNowPlayingCardEvents } from "./now-playing-card";
import { app, goToSettings, openManager, render } from "./render";
import { getYouTubeTabs } from "./tabs";
import { getQueueVideos, saveStorage } from "./videos";

export function setupApp() {
  // Check if the dashboard shell is actually present, not just "not empty"
  // logic: if 'stat-total' exists, we are in the dashboard view.
  if (document.getElementById("stat-total")) return;

  app.innerHTML = `
    <div class="flex flex-col h-popup max-h-popup w-full bg-surface overflow-hidden">
      <header data-v-header class="shrink-0 px-4 pt-2.5 pb-0.5">
        <div class="flex items-center gap-1">
          <span class="font-display text-[18px] font-medium text-text-primary leading-none flex-1 min-w-0 truncate">Study Harvester</span>
          <button id="refresh-tabs" type="button" class="popup-icon group/refresh" title="Refresh tabs" aria-label="Refresh tabs"><span class="group-active/refresh:rotate-180 transition-transform duration-500 flex"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg></span></button>
          <button id="go-to-settings" type="button" class="popup-icon" title="Settings" aria-label="Settings"><svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg></button>
        </div>
        <div class="mt-2 flex flex-col gap-1.5">
          <div class="flex items-baseline justify-between gap-3">
            <div class="font-display text-[32px] leading-none tracking-[-0.02em] text-text-primary"><span id="stat-remaining">0 min</span> <span id="stat-remaining-suffix" class="text-text-muted">left</span></div>
            <span id="stat-watched" class="text-[12px] text-text-secondary tabular-nums whitespace-nowrap"><span id="stat-watched-pct" class="font-semibold text-text-primary">0 %</span> watched</span>
          </div>
          <div class="popup-langs" role="table" aria-label="Time by language">
            <div class="popup-langs-row popup-langs-head" role="row">
              <span id="stat-video-count" class="col-span-2 truncate normal-case tracking-normal text-[12px] font-normal text-text-secondary" role="cell">0 videos</span>
              <span class="text-right" role="columnheader">Left</span>
              <span class="text-right" role="columnheader">Today</span>
            </div>
            <div id="popup-langs-body" class="contents"></div>
          </div>
          <span id="stat-total" class="hidden"></span>
        </div>
      </header>

      <section id="site-block" class="hidden shrink-0 px-3 pt-2.5"></section>

      <section id="now-playing" class="hidden shrink-0 px-3 pt-2">
        <div id="np-card" class="np-card" data-np-tab-id="">
          <div class="flex gap-3">
            <button type="button" class="np-thumb-btn relative shrink-0 w-[6.5rem] aspect-video rounded-lg overflow-hidden bg-surface-hover border-0 p-0 cursor-pointer" title="Open tab" aria-label="Open tab">
              <img class="np-thumb w-full h-full object-cover hidden" alt="" width="104" height="58" />
              <div class="absolute bottom-0 left-0 right-0 h-[3px] bg-black/40">
                <div class="np-progress h-full bg-accent transition-[width] duration-500" style="width: 0%"></div>
              </div>
            </button>
            <div class="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
              <div class="np-kicker text-[10px] font-semibold uppercase tracking-[0.1em] text-accent">Playing now</div>
              <button type="button" class="np-title font-display text-left text-[15px] font-medium leading-tight text-text-primary line-clamp-2 border-0 bg-transparent p-0 cursor-pointer hover:text-accent transition-colors" title="Open tab"></button>
              <p class="np-channel text-[12px] text-text-muted truncate m-0"></p>
            </div>
          </div>
          <div class="mt-2 flex items-center gap-2">
            <button type="button" class="np-play-pause w-8 h-8 shrink-0 flex items-center justify-center rounded-full bg-accent text-on-accent border-0 cursor-pointer hover:bg-accent-hover active:scale-95 transition-colors" title="Play or pause" aria-label="Play or pause"></button>
            <button type="button" class="np-next w-7 h-7 shrink-0 flex items-center justify-center rounded-full border border-border bg-surface text-text-primary cursor-pointer hover:bg-surface-hover active:scale-95 transition-colors" title="Play the next video" aria-label="Play the next video"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4"/><rect x="16" y="4" width="3" height="16" rx="1"/></svg></button>
            <span class="np-time text-[12px] text-text-secondary tabular-nums min-w-0 truncate"></span>
            <div class="ml-auto flex items-center gap-1.5 shrink-0">
              <svg class="np-volume-icon shrink-0 text-text-muted" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              <div class="w-14 flex items-center h-3">
                <input type="range" class="np-volume ui-range w-full" min="0" max="100" value="0" aria-label="Volume" />
              </div>
            </div>
            <button type="button" class="np-go-to-tab popup-icon w-7 h-7 text-accent hover:text-accent-hover" title="Go to tab" aria-label="Go to tab"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></button>
          </div>
        </div>
        <p id="np-also-playing" class="hidden px-1 pt-1.5 text-[11px] text-text-muted truncate m-0"></p>
      </section>

      <div id="up-next-divider" class="flex items-center gap-3 px-4 pt-2.5 pb-0.5 shrink-0">
        <span class="font-display text-[17px] font-medium text-text-primary flex-1">Up next <span id="up-next-count" class="font-sans text-[11px] font-normal text-text-muted ml-1"></span></span>
        <span class="inline-flex gap-0.5 rounded-lg border border-border bg-surface p-0.5" role="group" aria-label="Order">
          <button id="sort-order" type="button" class="theme-option theme-option--small" aria-pressed="true">Tab order</button>
          <button id="sort-duration" type="button" class="theme-option theme-option--small" aria-pressed="false">Longest first</button>
        </span>
      </div>

      <div id="video-list" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"></div>

      <footer class="shrink-0 px-3 py-2.5 border-t border-border bg-surface flex items-center gap-2">
        <button id="popup-stage-study" type="button" class="flex-1 h-[38px] rounded-[10px] border-0 bg-accent text-on-accent text-[13px] font-semibold flex items-center justify-center gap-2 cursor-pointer hover:bg-accent-hover transition-colors active:scale-[0.98] disabled:opacity-45 disabled:cursor-default disabled:hover:bg-accent disabled:active:scale-100" title="Start a focused study session from this window's tabs">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Start study session
        </button>
        <button id="open-manager" type="button" class="h-[38px] px-3.5 rounded-[10px] border border-border bg-surface-elevated text-text-primary text-[13px] font-medium cursor-pointer hover:bg-surface-hover transition-colors" title="Open the full desk">Open desk</button>
        <button id="popup-reading-list" type="button" class="h-[38px] px-3 rounded-[10px] border border-border bg-surface-elevated text-text-secondary text-[12px] font-medium cursor-pointer hover:bg-surface-hover transition-colors flex items-center gap-1.5" title="Open reading list on the desk" aria-label="Reading list">
          Reading <span id="popup-reading-count" class="tabular-nums">0</span>
        </button>
      </footer>
    </div>
  `;

  renderPopupLanguages();
  document.getElementById("go-to-settings")?.addEventListener("click", goToSettings);
  document.getElementById("open-manager")?.addEventListener("click", () => {
    void openManager();
  });
  document.getElementById("popup-reading-list")?.addEventListener("click", () => {
    void openManager("?view=reading-list");
  });
  document.getElementById("popup-stage-study")?.addEventListener("click", async () => {
    const queueVideos = getQueueVideos();
    if (queueVideos.length === 0) return;
    const orderedTabIds = queueVideos.map((video) => video.id);
    try {
      const response = await browser.runtime.sendMessage({
        action: "stage-focused-study-queue",
        payload: {
          orderedTabIds,
          stashDistractionTabs: false,
          playbackSpeed: 1.0,
        },
      });
      if (response?.success) {
        window.close();
      }
    } catch (error) {
      console.warn("Failed to stage study queue from popup:", error);
    }
  });
  document.getElementById("refresh-tabs")?.addEventListener("click", getYouTubeTabs);
  document.getElementById("sort-order")?.addEventListener("click", () => {
    popup.sortByDuration = false;
    saveStorage();
    render();
  });
  document.getElementById("sort-duration")?.addEventListener("click", () => {
    popup.sortByDuration = true;
    saveStorage();
    render();
  });

  bindNowPlayingCardEvents();

  document.getElementById("video-list")?.addEventListener("click", async (event) => {
    const target = event.target as HTMLElement;
    const button = target.closest("button");
    if (!button) return;
    const item = button.closest<HTMLElement>("[data-id]");
    const tabId = item ? parseInt(item.dataset.id || "0", 10) : 0;
    if (!tabId) return;
    const video = popup.videoData.find((entry) => entry.id === tabId);
    if (!video) return;

    if (button.classList.contains("jump-btn")) {
      await browser.tabs.update(tabId, { active: true });
      return;
    }
    if (button.classList.contains("toggle-btn")) {
      video.excluded = !video.excluded;
      render();
      saveStorage();
      return;
    }
    if (button.classList.contains("wake-up-btn")) {
      button.innerText = "Waking…";
      (button as HTMLButtonElement).disabled = true;
      await browser.tabs.update(tabId, { active: true });
      setTimeout(getYouTubeTabs, 1500);
    }
  });
}
