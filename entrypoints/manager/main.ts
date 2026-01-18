import "./style.css";
import {
  VideoData,
  loadStorage,
  saveStorage as saveStorageUtil,
  normalizeYoutubeUrl,
  CachedMetadata,
  requestMetadataUpdate
} from "../../utils/storage";


interface WindowGroup {
  id: number;
  tabs: VideoData[];
  duration: number;
  label: string;
}

let allVideos: VideoData[] = [];
let windowGroups: WindowGroup[] = [];
let currentWindowId: number | 'all' = 'all';
let selectedTabIds = new Set<number>();
let metadataCache: Record<string, CachedMetadata> = {};


let searchQuery = "";
let groupingMode: 'none' | 'channel' = 'none';
let layoutMode: 'list' | 'grid' = 'list';
let thumbnailQuality: 'standard' | 'high' = 'high';
let isSettingsOpen = false;

let sortOption: string = 'duration-desc';
let collapsedGroups = new Set<string>();

function formatTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
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

function parseTimeParam(url: string): number {
  try {
    const urlObj = new URL(url);
    const timeParam = urlObj.searchParams.get("t") || urlObj.searchParams.get("time_continue");
    if (!timeParam) return 0;
    if (timeParam.match(/[hms]/)) {
      const h = parseInt(timeParam.match(/(\d+)h/)?.[1] || "0");
      const m = parseInt(timeParam.match(/(\d+)m/)?.[1] || "0");
      const s = parseInt(timeParam.match(/(\d+)s/)?.[1] || "0");
      return h * 3600 + m * 60 + s;
    }
    return parseInt(timeParam) || 0;
  } catch {
    return 0;
  }
}

async function fetchTabs() {
  const storage = await loadStorage();
  metadataCache = storage.metadataCache;
  const excludedUrls = storage.excludedUrls;
  thumbnailQuality = storage.thumbnailQuality;
  groupingMode = storage.groupingMode;
  layoutMode = storage.layoutMode;
  sortOption = storage.sortOption;

  const allTabs = await browser.tabs.query({});
  const youtubeTabs = allTabs.filter(tab => {
    if (!tab.url) return false;
    try {
      const url = new URL(tab.url);
      return (
        (url.hostname.endsWith("youtube.com") || url.hostname === "youtube.com") &&
        (url.pathname.startsWith("/watch") || url.pathname.startsWith("/shorts"))
      );
    } catch {
      return false;
    }
  });

  allVideos = youtubeTabs.map((tab, index) => {
    const url = tab.url!;
    const normalizedUrl = normalizeYoutubeUrl(url);
    const cached = metadataCache[normalizedUrl];
    
    return {
      id: tab.id || 0,
      title: cached?.title || tab.title?.replace(" - YouTube", "") || "YouTube Video",
      channelName: cached?.channelName || "",
      seconds: cached?.seconds || 0,
      currentTime: cached?.currentTime || parseTimeParam(url),
      excluded: excludedUrls.includes(url),
      index: index,
      url: url,
      suspended: tab.discarded || false,
      active: tab.active,
      isLive: cached?.isLive || false,
      windowId: tab.windowId
    };
  });


  const groups = new Map<number, VideoData[]>();
  allVideos.forEach(video => {
    const wid = video.windowId;
    if (wid === undefined) return;
    if (!groups.has(wid)) groups.set(wid, []);
    groups.get(wid)!.push(video);
  });

  const windows = await browser.windows.getAll();
  windowGroups = windows
    .filter(w => groups.has(w.id!))
    .map((w, i) => {
      const tabs = groups.get(w.id!) || [];
      const duration = tabs.reduce((acc, v) => acc + v.seconds, 0);
      return {
        id: w.id!,
        tabs,
        duration,
        label: `Window ${i + 1}`
      };
    })
    .sort((a, b) => b.tabs.length - a.tabs.length);

  render();
  probeTabs();
}

async function probeTabs() {
  const activeTabPromises = allVideos.map(async (video) => {
      if (video.suspended) return;
      
      const hasValidMetadata = video.seconds > 0 && video.title !== "YouTube Video";

      try {
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
            } catch {}

            if (!isLive) {
              const liveBadge = document.querySelector(".ytp-live-badge") as HTMLElement;
              if (liveBadge && !liveBadge.hasAttribute("disabled") && getComputedStyle(liveBadge).display !== "none") {
                isLive = true;
              }
            }

            return {
              duration: isLive ? 0 : duration || videoElement?.duration || 0,
              currentTime,
              channelName: channel,
              title: document.title.replace(" - YouTube", "").trim(),
              isLive,
              skipMetadata: false
            };
          },
        });

        if (results[0]?.result) {
          const result = results[0].result;
          
          if (result.skipMetadata) {
             video.currentTime = result.currentTime || 0;
          } else {
             const duration = result.duration || 0;
             if (duration > 0 || result.isLive) {
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
             }
          }
          // Re-render (could be debounced)
          render();
        }
      } catch (e) {
        // Ignore errors (permissions, closed tabs, etc)
      }
  });

  await Promise.all(activeTabPromises);
}

// Helper to save current settings state
async function saveSettings() {
    // We need to pass all arguments to match signature, but we can rely on current global state
    // To do this safely without re-reading storage every time (which we do in loadStorage anyway), 
    // we should ideally keep a local state object.
    // However, saveStorageUtil needs videoData for excludedUrls. 
    // We will just pass empty videoData since saveStorage filters it. 
    // WAIT: saveStorage OVERWRITES excludedUrls if we pass empty list?
    // Let's check storage.ts.  
    // "const excludedUrls = videoData.filter((video) => video.excluded).map((video) => video.url);"
    // "await browser.storage.local.set(data);" - and data includes excludedUrls.
    // This wipes excluded URLs if we pass []. 
    // CRITICAL FIX: We need to read current storage or pass allVideos.
    
    // Better approach: Update saveStorage in storage.ts to only update provided keys? 
    // Or just pass allVideos here.
    
    const s = await loadStorage(); // Reload to get other fields like smartSync
    // We save all current global state
    await saveStorageUtil(
        allVideos, 
        s.sortByDuration, 
        s.smartSync, 
        thumbnailQuality, 
        layoutMode, 
        groupingMode, 
        sortOption
    );
}

function renderSidebar() {

  const container = document.getElementById("window-list");
  if (!container) return;
  
  const totalDuration = allVideos.reduce((acc, v) => acc + v.seconds, 0);
  const totalTabs = allVideos.length;

  document.getElementById("global-stats-count")!.innerText = 
    `${totalTabs} videos · ${formatTime(totalDuration)}`;

  let html = `
    <button class="w-full text-left px-3 py-2 rounded-md mb-1 flex items-center justify-between transition-colors ${currentWindowId === 'all' ? 'bg-surface-hover text-text-primary' : 'text-text-muted hover:bg-surface-hover/50 hover:text-text-secondary'}" onclick="selectWindow('all')">
      <span class="text-xs font-semibold">All Windows</span>
      <span class="text-[10px] bg-surface-elevated border border-border px-1.5 rounded-full">${totalTabs}</span>
    </button>
    <div class="h-px bg-border my-2 mx-2"></div>
  `;

  windowGroups.forEach(group => {
    const isActive = currentWindowId === group.id;
    html += `
      <button class="w-full text-left px-3 py-2 rounded-md mb-1 flex items-center justify-between transition-colors ${isActive ? 'bg-surface-hover text-text-primary' : 'text-text-muted hover:bg-surface-hover/50 hover:text-text-secondary'}" onclick="selectWindow(${group.id})">
        <div class="truncate pr-2">
            <div class="text-xs font-semibold truncate">${group.label}</div>
            <div class="text-[10px] font-mono opacity-60">${formatTime(group.duration)}</div>
        </div>
        <span class="text-[10px] bg-surface-elevated border border-border px-1.5 rounded-full">${group.tabs.length}</span>
      </button>
    `;
  });

  container.innerHTML = html;
  
  container.innerHTML = html;
}

function sortVideos(videos: VideoData[]): VideoData[] {
  return [...videos].sort((a, b) => {
    switch (sortOption) {
      case 'index-asc': return a.index - b.index;
      case 'duration-desc': return b.seconds - a.seconds;
      case 'duration-asc': return a.seconds - b.seconds;
      case 'title-asc': return a.title.localeCompare(b.title);
      case 'channel-asc': return a.channelName.localeCompare(b.channelName);
      default: return 0;
    }
  });
}

function extractVideoId(url: string): string | null {
  const match = url.match(/(?:v=|\/)([\w-]{11})(?:&|\?|\/|$)/);
  return match ? match[1] : null;
}



function renderMain() {
  const container = document.getElementById("tab-list");
  const headerTitle = document.getElementById("current-view-title");
  const headerStats = document.getElementById("current-view-stats");

  const btnSettings = document.getElementById("btn-settings");
  if (btnSettings) {
      if (isSettingsOpen) btnSettings.classList.add('text-accent', 'bg-surface-hover');
      else btnSettings.classList.remove('text-accent', 'bg-surface-hover');
  }

  const settingsModal = document.getElementById("settings-modal");
  if (settingsModal) {
      if (isSettingsOpen) {
          settingsModal.classList.remove("hidden", "fade-out");
          settingsModal.classList.add("flex", "animate-in", "fade-in");
      } else {
          settingsModal.classList.add("hidden");
          settingsModal.classList.remove("flex", "animate-in", "fade-in");
      }
      
      const btnQualityStd = document.getElementById("quality-standard");
      const btnQualityHigh = document.getElementById("quality-high");
      
      if (btnQualityStd && btnQualityHigh) {
          if (thumbnailQuality === 'standard') {
              btnQualityStd.classList.add('text-accent', 'bg-surface-hover');
              btnQualityStd.classList.remove('text-text-muted');
              btnQualityHigh.classList.remove('text-accent', 'bg-surface-hover');
              btnQualityHigh.classList.add('text-text-muted');
          } else {
              btnQualityHigh.classList.add('text-accent', 'bg-surface-hover');
              btnQualityHigh.classList.remove('text-text-muted');
              btnQualityStd.classList.remove('text-accent', 'bg-surface-hover');
              btnQualityStd.classList.add('text-text-muted');
          }
      }
  }
  const btnGroupNone = document.getElementById('view-list'); // "None" button
  const btnGroupChannel = document.getElementById('view-channel');
  
  if (btnGroupNone && btnGroupChannel) {
    if (groupingMode === 'none') {
        btnGroupNone.classList.add('text-accent', 'bg-surface-hover');
        btnGroupNone.classList.remove('text-text-muted');
        btnGroupChannel.classList.remove('text-accent', 'bg-surface-hover');
        btnGroupChannel.classList.add('text-text-muted');
    } else {
        btnGroupChannel.classList.add('text-accent', 'bg-surface-hover');
        btnGroupChannel.classList.remove('text-text-muted');
        btnGroupNone.classList.remove('text-accent', 'bg-surface-hover');
        btnGroupNone.classList.add('text-text-muted');
    }
  }

  // Layout Toggles
  const btnLayoutList = document.getElementById('layout-list');
  const btnLayoutGrid = document.getElementById('layout-grid');
  
  if (btnLayoutList && btnLayoutGrid) {
      if (layoutMode === 'list') {
          btnLayoutList.classList.add('text-accent', 'bg-surface-hover');
          btnLayoutList.classList.remove('text-text-muted');
          btnLayoutGrid.classList.remove('text-accent', 'bg-surface-hover');
          btnLayoutGrid.classList.add('text-text-muted');
      } else {
          btnLayoutGrid.classList.add('text-accent', 'bg-surface-hover');
          btnLayoutGrid.classList.remove('text-text-muted');
          btnLayoutList.classList.remove('text-accent', 'bg-surface-hover');
          btnLayoutList.classList.add('text-text-muted');
      }
  }

  if (!container || !headerTitle || !headerStats) return;

  let videosToShow: VideoData[] = [];
  
  if (currentWindowId === 'all') {
    headerTitle.innerText = "All Windows";
    videosToShow = allVideos;
  } else {
    const group = windowGroups.find(g => g.id === currentWindowId);
    if (group) {
      headerTitle.innerText = group.label;
      videosToShow = group.tabs;
    }
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    videosToShow = videosToShow.filter(v => 
      v.title.toLowerCase().includes(q) || 
      v.channelName.toLowerCase().includes(q)
    );
  }

  const duration = videosToShow.reduce((acc, v) => acc + v.seconds, 0);
  headerStats.innerText = `${videosToShow.length} videos · ${formatTime(duration)} total duration`;

  if (videosToShow.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center h-full opacity-40">
        <div class="text-4xl mb-4">📺</div>
        <div>No videos found</div>
      </div>
    `;
    return;
  }

  if (groupingMode === 'none') {
      const sortedVideos = sortVideos(videosToShow);
      if (layoutMode === 'grid') {
          container.innerHTML = renderVideoGrid(sortedVideos);
      } else {
          container.innerHTML = renderVideoList(sortedVideos);
      }
  } else {
      const channels = new Map<string, VideoData[]>();
      videosToShow.forEach(video => {
          const name = video.channelName || "Unknown Channel";
          if (!channels.has(name)) channels.set(name, []);
          channels.get(name)!.push(video);
      });

      let sortedGroups = Array.from(channels.entries());
      
      if (sortOption === 'channel-asc') {
          sortedGroups.sort((a, b) => a[0].localeCompare(b[0]));
      } else if (sortOption === 'duration-desc') {
           sortedGroups.sort((a, b) => {
               const durA = a[1].reduce((acc, v) => acc + v.seconds, 0);
               const durB = b[1].reduce((acc, v) => acc + v.seconds, 0);
               return durB - durA;
           });
      } else if (sortOption === 'duration-asc') {
            sortedGroups.sort((a, b) => {
               const durA = a[1].reduce((acc, v) => acc + v.seconds, 0);
               const durB = b[1].reduce((acc, v) => acc + v.seconds, 0);
               return durA - durB;
           });
      }
      
      container.innerHTML = sortedGroups.map(([channel, videos]) => {
          const isCollapsed = collapsedGroups.has(channel);
          const groupDuration = videos.reduce((acc, v) => acc + v.seconds, 0);
          const sortedGroupVideos = sortVideos(videos);
          
          const allSelected = videos.every(v => selectedTabIds.has(v.id));
          const someSelected = !allSelected && videos.some(v => selectedTabIds.has(v.id));

          return `
            <div class="mb-4">
                <div class="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-hover/30 group/header select-none">
                    <button class="p-1 rounded hover:bg-surface-hover text-text-muted transition-transform duration-200 group-toggle ${isCollapsed ? '-rotate-90' : ''}" data-group="${channel}">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </button>
                    
                     <!-- Group Checkbox -->
                    <div class="relative flex items-center justify-center w-4 h-4 cursor-pointer group-selection-toggle" data-group="${channel}">
                      <input type="checkbox" class="peer appearance-none w-3.5 h-3.5 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${allSelected ? 'checked' : ''} ${someSelected ? 'indeterminate' : ''}>
                       <svg class="absolute w-2 h-2 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                       <div class="absolute inset-0 flex items-center justify-center pointer-events-none opacity-0 ${someSelected && !allSelected ? 'opacity-100' : ''}">
                          <div class="w-2 h-0.5 bg-accent"></div>
                       </div>
                    </div>

                    <div class="flex-1 font-medium text-sm text-text-primary truncate cursor-pointer group-toggle" data-group="${channel}">${channel}</div>
                    <div class="text-[10px] text-text-muted font-mono flex items-center gap-2">
                        <span>${videos.length} videos</span>
                        <span class="w-px h-3 bg-border"></span>
                        <span>${formatTime(groupDuration)}</span>
                    </div>
                </div>
                
                <div class="space-y-1 ml-12 border-l border-border pl-2 mt-1 ${isCollapsed ? 'hidden' : ''}">
                    ${layoutMode === 'grid' ? renderVideoGrid(sortedGroupVideos) : renderVideoList(sortedGroupVideos)}
                </div>
            </div>
          `;
      }).join('');
      
      // Fix indeterminate states visually since HTML attribute doesn't set property
      setTimeout(() => {
           document.querySelectorAll('input[type="checkbox"]').forEach((el: any) => {
               if (el.hasAttribute('indeterminate')) el.indeterminate = true;
           });
      }, 0);
  }
}

function renderVideoList(videos: VideoData[]): string {
  return videos.map(video => {
    const isSelected = selectedTabIds.has(video.id);
    const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
    
    return `
      <div class="group flex items-center gap-4 p-3 rounded-lg border border-transparent hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? 'bg-surface-hover border-border' : ''}" data-id="${video.id}">
        <div class="relative flex items-center justify-center w-5 h-5 cursor-pointer selection-toggle">
          <input type="checkbox" class="peer appearance-none w-4 h-4 rounded border border-text-muted/40 checked:bg-accent checked:border-accent transition-colors cursor-pointer" ${isSelected ? 'checked' : ''}>
          <svg class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>

        <div class="flex-1 min-w-0 cursor-pointer video-click-target">
           <div class="flex items-baseline gap-2 mb-1">
             <h3 class="text-sm font-medium text-text-primary truncate" title="${video.title}">${video.title}</h3>
             <span class="text-[10px] text-text-muted truncate uppercase tracking-tight">${video.channelName}</span>
           </div>
           
           <div class="flex items-center gap-3 w-full max-w-md bg-surface-elevated/50 py-1 px-2 rounded-md">
             <div class="text-xs font-mono text-text-secondary whitespace-nowrap">
                <span class="${watchedPercent > 0 ? "text-text-primary" : "text-text-muted"}">${formatCompact(video.currentTime)}</span>
                <span class="mx-0.5 opacity-30">/</span>
                <span>${formatCompact(video.seconds)}</span>
             </div>
             <div class="flex-1 h-1 bg-surface rounded-full overflow-hidden">
                <div class="h-full bg-accent opacity-80" style="width: ${watchedPercent}%"></div>
             </div>
           </div>
        </div>

        <div class="opacity-0 group-hover:opacity-100 flex items-center gap-2 transition-opacity">
           <button class="p-1.5 hover:bg-surface text-text-muted hover:text-white rounded transition-colors jump-btn" title="Go to Tab">
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
           </button>
           <button class="p-1.5 hover:bg-red-500/10 text-text-muted hover:text-red-500 rounded transition-colors close-btn" title="Close Tab">
             <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
           </button>
        </div>
      </div>
    `;
  }).join('');
}

function renderVideoGrid(videos: VideoData[]): string {
    if (videos.length === 0) return '';

    const cardsHtml = videos.map(video => {
        const isSelected = selectedTabIds.has(video.id);
        const watchedPercent = video.seconds > 0 ? (video.currentTime / video.seconds) * 100 : 0;
        const videoId = extractVideoId(video.url);
        const thumbQuality = thumbnailQuality === 'high' ? 'hqdefault.jpg' : 'mqdefault.jpg';
        const thumbnailUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/${thumbQuality}` : '';

        return `
            <div class="group relative flex flex-col rounded-lg border border-transparent overflow-hidden hover:border-border hover:bg-surface-hover/50 transition-all ${isSelected ? 'bg-surface-hover border-border ring-1 ring-accent/50' : ''}" data-id="${video.id}">
                
                <!-- Thumbnail Area -->
                <div class="relative w-full aspect-video bg-surface-elevated/50 overflow-hidden video-click-target cursor-pointer">
                    ${thumbnailUrl 
                        ? `<img src="${thumbnailUrl}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy" alt="" />`
                        : `<div class="w-full h-full flex items-center justify-center text-text-muted/20"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="12" cy="12" r="3"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg></div>`
                    }
                    
                    <!-- Duration Badge -->
                    <div class="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 rounded text-[10px] font-mono font-medium text-white backdrop-blur-sm">
                        ${video.isLive ? 'LIVE' : formatCompact(video.seconds)}
                    </div>

                    <!-- Progress Bar (Overlay at bottom of thumb) -->
                    ${watchedPercent > 0 ? `
                    <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-surface/30">
                        <div class="h-full bg-accent" style="width: ${watchedPercent}%"></div>
                    </div>` : ''}

                    <!-- Selection Checkbox (Top Left) -->
                    <div class="absolute top-2 left-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'opacity-100' : ''} selection-toggle">
                        <input type="checkbox" class="appearance-none w-4 h-4 rounded border border-white/60 checked:bg-accent checked:border-accent bg-black/40 backdrop-blur-sm transition-colors cursor-pointer" ${isSelected ? 'checked' : ''}>
                        ${isSelected ? `<svg class="absolute top-0 left-0 w-4 h-4 text-white pointer-events-none p-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>` : ''}
                    </div>

                    <!-- Hover Actions (Top Right) -->
                    <div class="absolute top-1 right-1 flex gap-1 transform translate-x-2 opacity-0 group-hover:translate-x-0 group-hover:opacity-100 transition-all duration-200">
                         <button class="p-1.5 hover:bg-black/60 bg-black/40 text-white rounded-md backdrop-blur-sm transition-colors jump-btn" title="Go to Tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                         </button>
                         <button class="p-1.5 hover:bg-red-500/80 bg-black/40 text-white rounded-md backdrop-blur-sm transition-colors close-btn" title="Close Tab">
                             <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                         </button>
                    </div>
                </div>

                <!-- Info Area -->
                <div class="p-2 video-click-target cursor-pointer">
                    <h3 class="text-xs font-medium text-text-primary line-clamp-2 leading-snug mb-1 min-h-[2.5em]" title="${video.title}">${video.title}</h3>
                    <div class="flex items-center justify-between text-[10px] text-text-muted">
                        <span class="truncate hover:text-text-secondary transition-colors">${video.channelName}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    return `<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 p-1">${cardsHtml}</div>`;
}

function updateSelectionUI() {
  const bar = document.getElementById("selection-actions");
  const count = document.getElementById("selection-count");
  
  if (selectedTabIds.size > 0) {
    bar?.classList.remove('hidden');
    bar?.classList.add('flex');
    if (count) count.innerText = `${selectedTabIds.size} selected`;
  } else {
    bar?.classList.add('hidden');
    bar?.classList.remove('flex');
  }




  document.querySelectorAll('#tab-list [data-id]').forEach(el => {
    const id = parseInt((el as HTMLElement).dataset.id || "0");
    const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const isSel = selectedTabIds.has(id);
    if (checkbox) checkbox.checked = isSel;
    

    if (layoutMode === 'list') {
       if (isSel) el.classList.add('bg-surface-hover', 'border-border');
       else el.classList.remove('bg-surface-hover', 'border-border');
    } else {
       // Grid mode selection styling
       if (isSel) el.classList.add('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');
       else el.classList.remove('bg-surface-hover', 'border-border', 'ring-1', 'ring-accent/50');
       
       const selToggle = el.querySelector('.selection-toggle');
       if (selToggle) {
          if (isSel) selToggle.classList.add('opacity-100');
          else selToggle.classList.remove('opacity-100');
       }
    }
  });

}


function setupListeners() {
  document.getElementById("btn-refresh")?.addEventListener("click", () => {
    fetchTabs();
  });

  document.getElementById("btn-close-selected")?.addEventListener("click", async () => {
    const ids = Array.from(selectedTabIds);
    if (confirm(`Close ${ids.length} tabs?`)) {
      await browser.tabs.remove(ids);
      selectedTabIds.clear();
      updateSelectionUI();
      fetchTabs();
    }
  });


  document.getElementById("window-list")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn) return;
    

  });

  document.getElementById("search-input")?.addEventListener("input", (e) => {
    searchQuery = (e.target as HTMLInputElement).value;
    render();
  });

  document.getElementById("view-list")?.addEventListener("click", () => {
      groupingMode = "none";
      saveSettings();
      render();
  });
  document.getElementById("view-channel")?.addEventListener("click", () => {
      groupingMode = "channel";
      saveSettings();
      render();
  });

  document.getElementById("layout-list")?.addEventListener("click", () => {
      layoutMode = "list";
      saveSettings();
      render();
  });
  document.getElementById("layout-grid")?.addEventListener("click", () => {
      layoutMode = "grid";
      saveSettings();
      render();
  });

  document.getElementById("btn-settings")?.addEventListener("click", () => {
      isSettingsOpen = true;
      render();
  });
  document.getElementById("close-settings")?.addEventListener("click", () => {
      isSettingsOpen = false;
      render();
  });

  document.getElementById("quality-standard")?.addEventListener("click", () => {
      thumbnailQuality = "standard";
      saveSettings();
      render();
  });

  document.getElementById("quality-high")?.addEventListener("click", () => {
      thumbnailQuality = "high";
      saveSettings();
      render();
  });

  document.getElementById("sort-select")?.addEventListener("change", (e) => {
      sortOption = (e.target as HTMLSelectElement).value;
      saveSettings();
      render();
  });
}


function render() {
  renderSidebar();
  renderMain();
  updateSelectionUI();
  attachDynamicListeners();
}

function attachDynamicListeners() {
  // Sidebar clicks
  const winList = document.getElementById("window-list");
  if (winList) {


  document.querySelectorAll('#window-list button').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
         const isAll = idx === 0;
         if (isAll) {
             currentWindowId = 'all';
         } else {
             const winGroup = windowGroups[idx - 1]; // -1 because of All button
             if (winGroup) currentWindowId = winGroup.id;
         }
         render();
      });
  });


  }


  const tabList = document.getElementById("tab-list");
  if (tabList) {

    tabList.querySelectorAll('.selection-toggle').forEach(el => {
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const row = el.closest('[data-id]') as HTMLElement;
            const id = parseInt(row.dataset.id || "0");
            if (selectedTabIds.has(id)) selectedTabIds.delete(id);
            else selectedTabIds.add(id);
            updateSelectionUI();
        });
    });

    tabList.querySelectorAll('.video-click-target').forEach(el => {
        el.addEventListener('click', async (e) => {
             const row = el.closest('[data-id]') as HTMLElement;
             const id = parseInt(row.dataset.id || "0");
             const video = allVideos.find(v => v.id === id);
             if (video) {
                 await browser.tabs.update(video.id, { active: true });
                 await browser.windows.update(video.windowId as number, { focused: true });
             }
        });
    });


    tabList.querySelectorAll('.jump-btn').forEach(el => {
        el.addEventListener('click', async (e) => {
             e.stopPropagation();
             const row = el.closest('[data-id]') as HTMLElement;
             const id = parseInt(row.dataset.id || "0");
             const video = allVideos.find(v => v.id === id);
             if (video) {
                 await browser.tabs.update(video.id, { active: true });
                 await browser.windows.update(video.windowId as number, { focused: true });
             }
        });
    });


    tabList.querySelectorAll('.close-btn').forEach(el => {
        el.addEventListener('click', async (e) => {
             e.stopPropagation();
             const row = el.closest('[data-id]') as HTMLElement;
             const id = parseInt(row.dataset.id || "0");
             await browser.tabs.remove(id);
             row.remove();
             setTimeout(fetchTabs, 100);
        });
    });

    tabList.querySelectorAll('.group-toggle').forEach(el => {
        el.addEventListener('click', (e) => {
             const groupName = (el as HTMLElement).dataset.group;
             if (groupName) {
                 if (collapsedGroups.has(groupName)) collapsedGroups.delete(groupName);
                 else collapsedGroups.add(groupName);
                 render();
             }
        });
    });


    tabList.querySelectorAll('.group-selection-toggle').forEach(el => {
        el.addEventListener('click', (e) => {
             e.stopPropagation();
             const groupName = (el as HTMLElement).dataset.group;
             if (groupName) {
                 let scopeVideos = allVideos;
                 if (currentWindowId !== 'all') {
                     scopeVideos = allVideos.filter(v => v.windowId === currentWindowId);
                 }
                 
                 const videosInGroup = scopeVideos.filter(video => 
                    (video.channelName || "Unknown Channel") === groupName
                 );
                 
                 const allSel = videosInGroup.every(video => selectedTabIds.has(video.id));
                 
                 videosInGroup.forEach(v => {
                     if (allSel) selectedTabIds.delete(v.id);
                     else selectedTabIds.add(v.id);
                 });
                 
                 updateSelectionUI();
                 render();
             }
        });
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
    setupListeners();
    fetchTabs();
    
    browser.tabs.onRemoved.addListener(fetchTabs);
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete' || changeInfo.title) fetchTabs();
    });
});
