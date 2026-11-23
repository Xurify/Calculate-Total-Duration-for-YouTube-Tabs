import { popup } from "./state";
import { bindNowPlayingCardEvents } from "./now-playing-card";
import { app, openManager, render } from "./render";
import { getYouTubeTabs } from "./tabs";
import { getQueueVideos, saveStorage } from "./videos";

export function setupApp() {
  // Rebuilding the shell would reset the list's scroll position, so it only happens once.
  if (document.getElementById("stat-remaining")) return;

  app.innerHTML = `
    <div class="flex flex-col h-popup max-h-popup w-full bg-surface overflow-hidden">
      <header class="shrink-0 px-4 pt-5 pb-4">
        <div class="font-display text-[30px] leading-none tracking-[-0.02em] text-text-primary"><span id="stat-remaining">0 min</span> <span id="stat-remaining-suffix" class="text-text-muted">left</span></div>
        <p id="stat-summary" class="m-0 mt-2 text-[13px] text-text-muted tabular-nums"></p>
      </header>

      <section id="site-block" class="hidden shrink-0 px-3 pt-2.5"></section>

      <section id="now-playing" class="hidden shrink-0 px-3 pt-2">
        <div id="np-card" class="np-card" data-np-tab-id="">
          <div class="flex gap-3">
            <button type="button" class="np-thumb-btn relative shrink-0 w-[6.5rem] aspect-video rounded-lg overflow-hidden bg-surface-hover border-0 p-0 cursor-pointer" title="Open tab" aria-label="Open tab">
              <img class="np-thumb w-full h-full object-cover hidden" alt="" width="104" height="58" />
            </button>
            <div class="flex-1 min-w-0 flex flex-col justify-between gap-1.5">
              <button type="button" class="np-title font-display text-left text-[15px] font-medium leading-tight text-text-primary line-clamp-2 border-0 bg-transparent p-0 cursor-pointer hover:text-accent transition-colors" title="Open tab"></button>
              <div class="flex items-center gap-2">
                <p class="np-time flex-1 min-w-0 truncate text-[12px] text-text-secondary tabular-nums m-0"></p>
                <button type="button" class="np-play-pause w-9 h-9 shrink-0 flex items-center justify-center rounded-full bg-primary text-on-primary border-0 cursor-pointer hover:bg-primary-hover active:scale-95 transition-colors" title="Play or pause" aria-label="Play or pause"></button>
                <button type="button" class="np-next w-9 h-9 shrink-0 flex items-center justify-center rounded-full border border-border bg-surface text-text-primary cursor-pointer hover:bg-surface-hover active:scale-95 transition-colors" title="Play the next video" aria-label="Play the next video"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 4 15 12 5 20 5 4"/><rect x="16" y="4" width="3" height="16" rx="1"/></svg></button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <h2 id="up-next-divider" class="m-0 shrink-0 px-4 pt-3 pb-1 text-[12px] font-semibold text-text-muted">Up next</h2>

      <div id="video-list" class="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 pb-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent"></div>

      <footer class="shrink-0 px-3 py-2.5 border-t border-border bg-surface flex items-center gap-2">
        <button id="popup-stage-study" type="button" class="flex-1 h-[38px] rounded-md border-0 bg-primary text-on-primary text-[13px] font-semibold flex items-center justify-center gap-2 cursor-pointer hover:bg-primary-hover transition-colors active:scale-[0.98] disabled:opacity-45 disabled:cursor-default disabled:hover:bg-primary disabled:active:scale-100" title="Start a focused study session from this window's tabs">
          <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Start study session
        </button>
        <button id="open-manager" type="button" class="h-[38px] px-4 rounded-md border border-border bg-transparent text-text-primary text-[13px] font-medium cursor-pointer hover:bg-surface-hover transition-colors" title="Open the full desk">Open desk</button>
      </footer>
    </div>
  `;

  document.getElementById("open-manager")?.addEventListener("click", () => {
    void openManager();
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
