import "./style.css";
import packageJson from "../../package.json";
import {
  VideoData,
  loadStorage,
  saveStorage as saveStorageUtil,
  requestMetadataUpdate,
  normalizeYoutubeUrl,
  clearCache
} from "../../utils/storage";

const VERSION_NUMBER = packageJson.version;

let videoData: VideoData[] = [];
let sortByDuration = false;
let smartSync = true;
let currentView: "dashboard" | "settings" = "dashboard";

async function saveStorage(): Promise<void> {
  await saveStorageUtil(videoData, sortByDuration, smartSync);
}

function parseTimeParam(url: string): number {
  try {
    const urlObj = new URL(url);
    const timeParam = urlObj.searchParams.get("t") || urlObj.searchParams.get("time_continue");
    if (!timeParam) return 0;

    // Handle "1h2m3s" format
    if (timeParam.match(/[hms]/)) {
      const h = parseInt(timeParam.match(/(\d+)h/)?.[1] || "0");
      const m = parseInt(timeParam.match(/(\d+)m/)?.[1] || "0");
      const s = parseInt(timeParam.match(/(\d+)s/)?.[1] || "0");
      return h * 3600 + m * 60 + s;
    }

    // Handle simple seconds
    return parseInt(timeParam) || 0;
  } catch (e) {
    return 0;
  }
}

function formatTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds].map((value) => (value < 10 ? "0" + value : value)).join(":");
}

function formatCompact(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Global listener for background updates
browser.runtime.onMessage.addListener((message) => {
  if (message.action === "tab-synced") {
    const video = videoData.find((v) => v.id === message.tabId);
    if (video) {
      video.seconds = message.metadata.seconds;
      video.title = message.metadata.title;
      video.channelName = message.metadata.channelName;
      video.isLive = message.metadata.isLive || false;
      video.suspended = false;

      requestMetadataUpdate(video.url, {
        seconds: video.seconds,
        title: video.title,
        channelName: video.channelName,
        currentTime: video.currentTime,
        isLive: video.isLive,
      });
      render();
    }
  }
  if (message.action === "sync-error") {
    const syncAllButton = document.getElementById("sync-all") as HTMLButtonElement;
    if (syncAllButton) {
      syncAllButton.innerText = "Sync Failed (Rate Limited)";
      syncAllButton.disabled = true;
      syncAllButton.classList.add("text-red-500");
    }
  }
  if (message.action === "sync-complete") {
    const syncAllButton = document.getElementById("sync-all") as HTMLButtonElement;
    if (syncAllButton) {
      const unsyncedCount = videoData.filter((v) => v.suspended || v.seconds === 0).length;
      syncAllButton.innerText = unsyncedCount > 0 ? `Sync All (${unsyncedCount})` : "Synced";
      syncAllButton.disabled = unsyncedCount === 0;
      syncAllButton.classList.remove("text-red-500");
    }
    render();
  }
});

function getSortedVideos(): VideoData[] {
  return [...videoData].sort((a, b) => {
    if (sortByDuration) return b.seconds - a.seconds;
    return a.index - b.index;
  });
}

let renderTimeout: any = null;

const app = document.getElementById("app")!;

function setupApp() {
  // Check if the dashboard shell is actually present, not just "not empty"
  // logic: if 'stat-total' exists, we are in the dashboard view.
  if (document.getElementById("stat-total")) return;

  app.innerHTML = `
    <div data-v-header class="p-5 border-b border-border bg-gradient-to-b from-surface to-surface-elevated">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-2">
          <div id="smart-sync-indicator" class="w-2 h-2 rounded-full transition-colors duration-300"></div>
          <span id="smart-sync-text" class="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted"></span>
        </div>
        <div class="flex items-center -mr-2">
          <button id="open-manager" class="p-2 rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-all border-0 bg-transparent cursor-pointer" title="Open Dashboard">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>
          </button>
          <button id="go-to-settings" class="p-2 rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-all border-0 bg-transparent cursor-pointer group/settings">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="group-hover/settings:rotate-90 transition-transform duration-500"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>
          </button>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div class="text-[10px] uppercase tracking-wider text-text-muted mb-1 font-semibold">Remaining</div>
          <div id="stat-remaining" class="text-2xl font-bold tabular-nums text-accent">--:--</div>
        </div>
        <div>
          <div class="text-[10px] uppercase tracking-wider text-text-muted mb-1 font-semibold">Total Duration</div>
          <div id="stat-total" class="text-2xl font-bold tabular-nums text-text-primary">--:--</div>
        </div>
      </div>
      
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span id="stat-video-count" class="text-[11px] text-text-muted font-medium">0 videos</span>
          <button id="refresh-tabs" class="p-1.5 rounded-full hover:bg-surface-hover text-text-muted hover:text-accent transition-all border-0 cursor-pointer group/refresh" title="Refresh tabs">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="group-active/refresh:rotate-180 transition-transform duration-500"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"></path><path d="M8 16H3v5"></path></svg>
          </button>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] uppercase tracking-wider text-text-muted font-bold opacity-50">Sort by:</span>
          <div class="flex p-0.5 bg-surface-hover rounded-lg border border-border">
            <button id="sort-order" class="px-2.5 py-1 text-[10px] font-bold rounded-md cursor-pointer transition-all border-0">Tab</button>
            <button id="sort-duration" class="px-2.5 py-1 text-[10px] font-bold rounded-md cursor-pointer transition-all border-0">Length</button>
          </div>
        </div>
      </div>
    </div>

    <div id="unsynced-banner" class="hidden bg-amber-500/5 border-b border-amber-500/10 px-5 py-2.5 items-center justify-between animate-in slide-in-from-top duration-500">
      <div class="flex items-center gap-2">
        <div class="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></div>
        <span id="unsynced-text" class="text-[10px] font-bold text-amber-500 uppercase tracking-wider"></span>
      </div>
      <button id="sync-all" class="text-[10px] font-bold text-amber-500 hover:text-amber-400 transition-colors border-0 bg-transparent cursor-pointer p-0 underline decoration-2 underline-offset-4">
        Sync Now
      </button>
    </div>

    <div class="max-h-[340px] overflow-y-auto custom-scrollbar" id="video-list"></div>
  `;

  document.getElementById("go-to-settings")?.addEventListener("click", () => {
    currentView = "settings";
    render();
  });
  document.getElementById("open-manager")?.addEventListener("click", () => {
    browser.tabs.create({ url: browser.runtime.getURL("/manager.html") });
  });
  document.getElementById("refresh-tabs")?.addEventListener("click", getYouTubeTabs);
  document.getElementById("sort-order")?.addEventListener("click", () => {
    sortByDuration = false;
    saveStorage();
    render();
  });
  document.getElementById("sort-duration")?.addEventListener("click", () => {
    sortByDuration = true;
    saveStorage();
    render();
  });
  document.getElementById("sync-all")?.addEventListener("click", () => {
    const syncAllButton = document.getElementById("sync-all") as HTMLButtonElement;
    syncAllButton.innerText = "Syncing...";
    syncAllButton.disabled = true;
    browser.runtime
      .sendMessage({
        action: "sync-all",
        tabs: videoData.filter((v) => v.suspended || v.seconds === 0).map((v) => ({ id: v.id, url: v.url })),
      })
      .catch(() => {});
  });
}

function updateHeaderStats(totalSeconds: number, totalRemaining: number, videoCount: number, unsyncedCount: number) {
  const indicator = document.getElementById("smart-sync-indicator");
  const text = document.getElementById("smart-sync-text");
  if (indicator && text) {
    indicator.className = `w-2 h-2 rounded-full ${
      smartSync ? "bg-accent animate-pulse shadow-[0_0_8px_rgba(255,0,0,0.5)]" : "bg-text-muted opacity-50"
    }`;
    text.innerText = smartSync ? "Smart Sync Active" : "Smart Sync Paused";
  }

  document.getElementById("stat-remaining")!.innerText = formatTime(totalRemaining);
  document.getElementById("stat-total")!.innerText = formatTime(totalSeconds);
  document.getElementById("stat-video-count")!.innerText = `${videoCount} videos`;

  const banner = document.getElementById("unsynced-banner");
  if (banner) {
    if (unsyncedCount > 0 && !smartSync) {
      banner.classList.remove("hidden");
      banner.classList.add("flex");
      document.getElementById("unsynced-text")!.innerText = `${unsyncedCount} background tabs needing sync`;
    } else {
      banner.classList.add("hidden");
      banner.classList.remove("flex");
    }
  }

  const btnTab = document.getElementById("sort-order");
  const btnLen = document.getElementById("sort-duration");
  if (btnTab && btnLen) {
    btnTab.className = `px-2.5 py-1 text-[10px] font-bold rounded-md cursor-pointer transition-all border-0 ${
      !sortByDuration ? "bg-accent text-white shadow-sm" : "text-text-muted hover:text-text-secondary"
    }`;
    btnLen.className = `px-2.5 py-1 text-[10px] font-bold rounded-md cursor-pointer transition-all border-0 ${
      sortByDuration ? "bg-accent text-white shadow-sm" : "text-text-muted hover:text-text-secondary"
    }`;
  }
}

function updateVideoList(videos: VideoData[]) {
  const container = document.getElementById("video-list")!;
  const currentIds = new Set(videos.map((v) => v.id));

  // 1. Remove stale
  Array.from(container.children).forEach((child) => {
    const id = parseInt((child as HTMLElement).dataset.id || "0");
    if (!currentIds.has(id)) child.remove();
  });

  // 2. Create/Update
  videos.forEach((video) => {
    let item = document.getElementById(`video-item-${video.id}`);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;

    if (!item) {
      item = document.createElement("div");
      item.id = `video-item-${video.id}`;
      item.dataset.id = video.id.toString();
      item.style.viewTransitionName = `video-${video.id}`;
      item.className = "group relative py-4 pr-5 border-b border-border last:border-0 transition-all duration-300";
      item.innerHTML = `
           <div class="flex items-start justify-between gap-3 mb-2.5">
            <div class="flex-1 min-w-0">
              <div class="meta-channel text-[10px] text-accent font-semibold mb-0.5 truncate uppercase tracking-tighter"></div>
              <div class="meta-title text-[13px] text-text-primary font-medium leading-tight line-clamp-2 mb-1"></div>
            </div>
            <div class="meta-controls absolute top-4 right-5 flex gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity bg-surface-elevated/90 backdrop-blur-sm rounded-md p-1 pl-2 shadow-sm border border-border/50"></div>
          </div>
          <div class="flex items-center gap-3">
            <div class="flex-1 h-1 bg-surface-hover rounded-full overflow-hidden">
              <div class="meta-progress h-full bg-accent transition-all duration-700 rounded-full" style="width: 0%"></div>
            </div>
            <div class="meta-time text-[10px] text-text-muted font-medium tabular-nums whitespace-nowrap"></div>
          </div>
          `;

      container.appendChild(item);
    }

    const activeClasses = video.active ? "bg-accent/[0.03] border-l-4 border-l-accent pl-[17px]" : "pl-5";
    item.className = `group relative py-4 pr-5 border-b border-border last:border-0 transition-all duration-300 ${activeClasses} ${
      video.excluded ? "opacity-40 grayscale" : "opacity-100"
    }`;

    (item.querySelector(".meta-channel") as HTMLElement).innerText =
      video.channelName || (video.suspended ? "Suspended Tab" : "YouTube");
    (item.querySelector(".meta-title") as HTMLElement).innerText = video.title;
    (item.querySelector(".meta-title") as HTMLElement).title = video.title;
    (item.querySelector(".meta-progress") as HTMLElement).style.width = `${watchedPercent}%`;

    const timeEl = item.querySelector(".meta-time") as HTMLElement;
    if (video.isLive) {
      timeEl.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-red-500/20 text-red-500 text-[9px] font-bold">🔴 LIVE</span>`;
    } else if (video.seconds > 0) {
      timeEl.innerHTML = `
            <span class="${watchedPercent > 0 ? "text-text-secondary" : ""}">${formatCompact(video.currentTime)}</span>
            <span class="mx-0.5 opacity-30">/</span>
            <span>${formatCompact(video.seconds)}</span>
          `;
    } else if (video.suspended) {
      timeEl.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 text-[9px] font-bold">SUSPENDED</span>`;
    } else {
      timeEl.innerHTML = `<span class="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 text-[9px] font-bold uppercase tracking-tighter">Loading...</span>`;
    }

    // Re-render controls if state changed (simplified for now, just always refresh to be safe or optimize later)
    const controls = item.querySelector(".meta-controls") as HTMLElement;
    controls.innerHTML = `
          <button class="shrink-0 p-1.5 rounded bg-surface-hover text-text-muted border-0 cursor-pointer transition-all hover:bg-accent hover:text-white jump-btn" title="Jump to tab">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
          </button>
          ${
            video.suspended
              ? `<button class="shrink-0 text-[10px] px-2 py-1 rounded bg-amber-500 text-white border-0 cursor-pointer transition-all hover:bg-amber-600 font-bold wake-up-btn">Wake up</button>`
              : ""
          }
          <button class="shrink-0 text-[10px] px-2 py-1 rounded bg-surface-hover text-text-muted border-0 cursor-pointer transition-all hover:bg-accent hover:text-white toggle-btn">${
            video.excluded ? "Show" : "Hide"
          }</button>
      `;

    // Simplified Listeners (re-attached to new DOM nodes inside controls)
    controls.querySelector(".jump-btn")?.addEventListener("click", () => {
      browser.tabs.update(video.id, { active: true });
    });
    controls.querySelector(".toggle-btn")?.addEventListener("click", () => {
      video.excluded = !video.excluded;
      saveStorage();
      render();
    });
    controls.querySelector(".wake-up-btn")?.addEventListener("click", async (event) => {
      const wakeUpButton = event.currentTarget as HTMLButtonElement;
      wakeUpButton.innerText = "Waking...";
      wakeUpButton.disabled = true;
      await browser.tabs.update(video.id, { active: true });
      setTimeout(getYouTubeTabs, 1500);
    });

    container.appendChild(item);
  });
}

function render(): void {
  if (renderTimeout) return;

  renderTimeout = setTimeout(() => {
    renderTimeout = null;

    if (videoData.length === 0) {
      app.innerHTML = `
          <div class="p-8 text-center">
            <div class="text-4xl mb-4 opacity-40">📺</div>
            <div class="text-sm text-text-secondary mb-1">No videos open</div>
            <div class="text-xs text-text-muted">Open YouTube videos to start tracking</div>
          </div>
        `;
      return;
    }

    if (currentView === "settings") {
      app.innerHTML = `
          <div data-v-header class="p-5 border-b border-border bg-gradient-to-b from-surface to-surface-elevated">
            <div class="flex items-center gap-3 mb-6">
              <button id="back-to-dashboard" class="p-2 -ml-2 rounded-full hover:bg-surface-hover text-text-muted hover:text-text-primary transition-all border-0 bg-transparent cursor-pointer">
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
              </button>
              <h2 class="text-sm font-bold uppercase tracking-widest text-text-primary m-0">Settings</h2>
            </div>
            <div class="space-y-6">
              <div class="flex items-center justify-between group">
                <div>
                  <div class="text-[13px] font-semibold text-text-primary mb-0.5">Smart Sync</div>
                  <div class="text-[11px] text-text-muted leading-tight pr-4">Automatically fetch video durations for suspended tabs in the background.</div>
                </div>
                <label class="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" id="smart-sync-toggle" class="sr-only peer" ${smartSync ? "checked" : ""}>
                  <div class="w-9 h-5 bg-surface-hover rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-text-muted peer-checked:after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent border border-border"></div>
                </label>
              </div>

              <div class="pt-4 border-t border-border">
                <button id="btn-clear-cache" class="w-full text-left p-3 rounded-lg border border-border bg-surface-hover/20 hover:bg-red-500/10 hover:border-red-500 group/clear transition-all cursor-pointer">
                  <div class="flex items-center justify-between">
                    <div>
                      <div class="text-[12px] font-semibold group-hover/clear:text-red-500 transition-colors">Clear Metadata Cache</div>
                      <div class="text-[10px] text-text-muted">Reset all stored titles and durations</div>
                    </div>
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5 text-text-muted group-hover/clear:text-red-500 transition-colors" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </div>
                </button>
              </div>
            </div>
            <div class="mt-8 pt-6 border-t border-border/50 text-center">
              <div class="text-[10px] text-text-muted font-medium mb-1 opacity-40 uppercase tracking-tighter">Calculate Total Duration for YouTube Tabs v${VERSION_NUMBER}</div>
            </div>
          </div>
        `;
      document.getElementById("back-to-dashboard")!.addEventListener("click", () => {
        currentView = "dashboard";
        render();
      });
      document.getElementById("smart-sync-toggle")!.addEventListener("change", (e) => {
        smartSync = (e.target as HTMLInputElement).checked;
        saveStorage();
        if (smartSync) getYouTubeTabs();
      });

      document.getElementById("btn-clear-cache")?.addEventListener("click", async () => {
        if (confirm("Are you sure you want to clear all cached metadata?")) {
            await clearCache();
            getYouTubeTabs();
            currentView = "dashboard";
            render();
        }
      });
      return;
    }

    setupApp();

    const includedVideos = videoData.filter((video) => !video.excluded);
    const totalSeconds = includedVideos.reduce((sum, video) => sum + video.seconds, 0);
    const totalWatched = includedVideos.reduce((sum, video) => sum + video.currentTime, 0);
    const totalRemaining = Math.max(0, totalSeconds - totalWatched);

    // Only count videos that WE HAVE NOT successfully fetched data for yet.
    // Suspended tabs with 0 seconds are the only ones that truly need a background sync.
    const pendingSyncCount = videoData.filter((v) => v.suspended && v.seconds === 0).length;

    updateHeaderStats(totalSeconds, totalRemaining, includedVideos.length, pendingSyncCount);
    updateVideoList(getSortedVideos());
  }, 0);
}

function showLoading(): void {
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="p-8 text-center">
      <div class="w-5 h-5 border-2 border-border border-t-accent rounded-full animate-spin mx-auto mb-3"></div>
      <div class="text-xs text-text-muted">Scanning tabs...</div>
    </div>
  `;
}

async function getYouTubeTabs(): Promise<void> {
  showLoading();

  try {
    const { sortByDuration: savedSort, excludedUrls, smartSync: savedSmartSync, metadataCache } = await loadStorage();
    sortByDuration = savedSort;
    smartSync = savedSmartSync;

    // Query ALL tabs and filter manually to avoid API quirks
    const allTabs = await browser.tabs.query({});
    const tabs = allTabs.filter((tab) => {
      if (!tab.url) return false;
      try {
        const url = new URL(tab.url);
        return (
          (url.hostname.endsWith("youtube.com") || url.hostname === "youtube.com") &&
          (url.pathname.startsWith("/watch") || url.pathname.startsWith("/shorts")) &&
          !tab.url.includes("exclude_blobs")
        );
      } catch {
        return false;
      }
    });

    // Initialize videoData immediately with basic tab info and cached metadata
    videoData = tabs.map((tab, index) => {
      const url = tab.url!;
      const normalizedUrl = normalizeYoutubeUrl(url);
      const cached = metadataCache[normalizedUrl];

        let initialTitle = tab.title || "YouTube Video";
        initialTitle = initialTitle.replace(/^\(\d+\)\s*/g, "");
        initialTitle = initialTitle.replace(" - YouTube", "").trim();

        return {
          id: tab.id || 0,
          title: cached?.title || initialTitle,
          channelName: cached?.channelName || "",
          seconds: cached?.seconds || 0,
          currentTime: cached?.currentTime || parseTimeParam(url),
          excluded: excludedUrls.includes(url),
          index: index,
          url: url,
          suspended: tab.discarded || false,
          active: tab.active,
          isLive: cached?.isLive || false,
        };
    });

    // Render immediately so user sees the list with whatever we have (cached or basic)
    render();

    // Trigger Smart Sync for any suspended tabs that aren't in cache
    const unsyncedVideos = videoData.filter((v) => v.suspended && v.seconds === 0);
    if (smartSync && unsyncedVideos.length > 0 && currentView === "dashboard") {
      console.log(`[Popup] Triggering smart sync for ${unsyncedVideos.length} tabs`);
      browser.runtime
        .sendMessage({
          action: "sync-all",
          tabs: unsyncedVideos.map((v) => ({ id: v.id, url: v.url })),
        })
        .catch(() => {});
    }

    const activeTabPromises = videoData.map(async (video) => {
      if (video.suspended) return;

      // STALE-WHILE-REVALIDATE LOGIC
      // If we have a valid duration and title, we only NEED to probe for currentTime
      const hasValidMetadata = video.seconds > 0 && 
                               video.title !== "YouTube Video" && 
                               video.title !== "YouTube" && 
                               !/^\(\d+\)\s*/.test(video.title);
      
      try {
        console.log(`[Popup] Probing tab ${video.id} (Metadata: ${hasValidMetadata ? 'Cached' : 'Missing'})`);
        const results = await browser.scripting.executeScript({
          target: { tabId: video.id },
          world: "MAIN",
          args: [hasValidMetadata],
          func: (hasMetadata: boolean) => {
            const videoElement = document.querySelector("video");
            const currentTime = videoElement ? videoElement.currentTime : 0;

            if (hasMetadata) {
              return { currentTime, skipMetadata: true };
            }

            const channel =
              (document.querySelector("#upload-info #channel-name a") as HTMLElement)?.innerText ||
              (document.querySelector(".ytd-video-owner-renderer #channel-name a") as HTMLElement)?.innerText ||
              "";

            let duration = 0;
            let isLive = false;

            try {
              // @ts-ignore
              const playerResponse = window.ytInitialPlayerResponse;
              const videoDetails = playerResponse?.videoDetails;

              if (videoDetails) {
                isLive = videoDetails.isLive === true;
                const liveDetails = playerResponse?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails;
                if (liveDetails && !liveDetails.endTimestamp) isLive = true;

                const lengthSeconds = parseInt(videoDetails.lengthSeconds) || 0;
                if (lengthSeconds > 0) {
                  isLive = false;
                  duration = lengthSeconds;
                }
              }

              if (!isLive) {
                const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
                if (liveBadge && !liveBadge.hasAttribute("disabled") && getComputedStyle(liveBadge).display !== "none") {
                  isLive = true;
                }
              }

              // Consolidate title extraction
              let title = videoDetails?.title || 
                (document.querySelector("h1.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
                (document.querySelector("h1.title.ytd-video-primary-info-renderer") as HTMLElement)?.innerText ||
                (document.querySelector(".ytd-video-primary-info-renderer h1") as HTMLElement)?.innerText ||
                (document.querySelector("ytd-video-primary-info-renderer #container h1") as HTMLElement)?.innerText ||
                document.title;

              // Clean title: remove any notification prefixes like "(1) " or "(1030) "
              title = title.replace(/^\(\d+\)\s*/g, "");
              title = title.replace(" - YouTube", "").trim();

              return {
                duration: isLive ? 0 : duration || videoElement?.duration || 0,
                currentTime,
                channelName: channel || videoDetails?.author || "",
                title: title || "YouTube Video",
                isLive,
                skipMetadata: false
              };
            } catch (error) {
               // Fallback if playerResponse access fails or other error
               return {
                 duration: videoElement?.duration || 0,
                 currentTime,
                 channelName: channel,
                 title: document.title.replace(/^\(\d+\)\s*/g, "").replace(" - YouTube", "").trim() || "YouTube Video",
                 isLive: false,
                 skipMetadata: false
               };
            }
          },
        });

        if (results[0]?.result) {
          const result = results[0].result;
          
          if (result.skipMetadata) {
            // Only update currentTime
            video.currentTime = result.currentTime || 0;
            render();
          } else {
            const duration = result.duration || 0;
            if (duration === 0 && !result.isLive) {
              if (smartSync) {
                browser.runtime.sendMessage({
                  action: "sync-all",
                  tabs: [{ id: video.id, url: video.url }],
                }).catch(() => {});
              }
            } else {
              video.title = result.title || video.title;
              video.channelName = result.channelName || video.channelName;
              video.seconds = duration;
              video.currentTime = result.currentTime || 0;
              video.isLive = result.isLive || false;

              requestMetadataUpdate(video.url, {
                seconds: video.seconds,
                title: video.title,
                channelName: video.channelName,
                currentTime: video.currentTime,
                isLive: video.isLive,
              });
              render();
            }
          }
        }
      } catch (error: any) {
        // If script fails, it might be restricted or unloaded.
        // We only warn for unexpected errors; permission errors are expected on unrefreshed tabs
        const errorMsg = error?.message || "";
        const isExpectedError =
          errorMsg.includes("permissions") ||
          errorMsg.includes("Cannot access") ||
          errorMsg.includes("Extension context invalidated");

        if (!isExpectedError) {
          console.warn(`Failed to probe tab ${video.id}:`, error);
        }

        // Mark as suspended so it gets picked up by Smart Sync if enabled
        video.suspended = true;
        render();

        // FAILSAFE: If Smart Sync is on, immediately try to fetch this failed tab in background
        if (smartSync) {
          browser.runtime
            .sendMessage({
              action: "sync-all",
              tabs: [{ id: video.id, url: video.url }],
            })
            .catch(() => {});
        }
      }
    });
    // Wait for active tabs to finish processing (optional, just for cleanup)
    await Promise.all(activeTabPromises);
  } catch (error: any) {
    console.error("Error scanning tabs:", error);
    const app = document.getElementById("app")!;
    app.innerHTML = `
      <div class="p-8 text-center">
        <div class="text-2xl mb-3 opacity-40">⚠️</div>
        <div class="text-sm text-text-secondary mb-1">Something went wrong</div>
        <div class="text-[10px] text-accent font-mono break-all px-4">${error?.message || "Unknown error"}</div>
        <div class="text-[10px] text-text-muted mt-4">Try refreshing your YouTube tabs</div>
      </div>
    `;
  }
}

document.addEventListener("DOMContentLoaded", getYouTubeTabs);
