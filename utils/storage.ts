export interface VideoData {
  id: number;
  title: string;
  channelName: string;
  seconds: number;
  currentTime: number;
  excluded: boolean;
  index: number;
  url: string;
  suspended: boolean;
  active: boolean;
  isLive: boolean;
  windowId?: number;
}

export interface CachedMetadata {
  seconds: number;
  title: string;
  channelName: string;
  currentTime: number;
  isLive: boolean;
  timestamp: number;
}

export function normalizeYoutubeUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    if (!urlObj.hostname.includes("youtube.com") && !urlObj.hostname.includes("youtu.be")) return url;

    // Handle youtu.be shortlinks
    if (urlObj.hostname.includes("youtu.be")) {
      const videoId = urlObj.pathname.slice(1);
      return videoId ? `https://www.youtube.com/watch?v=${videoId}` : url;
    }

    // Handle standard watch URLs
    const videoId = urlObj.searchParams.get("v");
    if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;

    // Handle shorts (convert to watch URL for unified cache)
    if (urlObj.pathname.startsWith("/shorts/")) {
      const shortId = urlObj.pathname.split("/")[2];
      if (shortId) return `https://www.youtube.com/watch?v=${shortId}`;
    }

    return url;
  } catch {
    return url;
  }
}

export async function requestMetadataUpdate(
  url: string,
  metadata: Omit<CachedMetadata, "timestamp">
): Promise<void> {
  await browser.runtime.sendMessage({
    action: "update-cache",
    url,
    metadata,
  }).catch(() => {});
}

export async function saveStorage(
  videoData: VideoData[],
  sortByDuration: boolean,
  thumbnailQuality?: 'standard' | 'high',
  layoutMode?: 'list' | 'grid',
  groupingMode?: 'none' | 'channel',
  sortOption?: string
): Promise<void> {
  if (!browser.storage?.local) return;
  
  const current = await browser.storage.local.get(["excludedUrls"]);
  let excludedUrls = (current.excludedUrls as string[]) || [];
  
  if (videoData.length > 0) {
    excludedUrls = videoData.filter((video) => video.excluded).map((video) => video.url);
  }

  const data: any = {
    sortByDuration,
    excludedUrls,
  };
  if (thumbnailQuality) data.thumbnailQuality = thumbnailQuality;
  if (layoutMode) data.layoutMode = layoutMode;
  if (groupingMode) data.groupingMode = groupingMode;
  if (sortOption) data.sortOption = sortOption;
  
  await browser.storage.local.set(data);
}

export async function loadStorage(): Promise<{
  sortByDuration: boolean;
  excludedUrls: string[];
  thumbnailQuality: 'standard' | 'high';
  layoutMode: 'list' | 'grid';
  groupingMode: 'none' | 'channel';
  sortOption: string;
  metadataCache: Record<string, CachedMetadata>;
}> {
  if (!browser.storage?.local) {
    console.warn("Storage API not available.");
    return { 
      sortByDuration: false, 
      excludedUrls: [], 
      thumbnailQuality: 'high', 
      layoutMode: 'grid', 
      groupingMode: 'none', 
      sortOption: 'duration-desc', 
      metadataCache: {} 
    };
  }
  const data = await browser.storage.local.get([
    "sortByDuration", 
    "excludedUrls", 
    "thumbnailQuality", 
    "layoutMode", 
    "groupingMode", 
    "sortOption", 
    "metadataCache"
  ]);
  return {
    sortByDuration: Boolean(data.sortByDuration),
    excludedUrls: (data.excludedUrls as string[]) || [],
    thumbnailQuality: (data.thumbnailQuality as 'standard' | 'high') || 'high',
    layoutMode: (data.layoutMode as 'list' | 'grid') || 'grid',
    groupingMode: (data.groupingMode as 'none' | 'channel') || 'none',
    sortOption: (data.sortOption as string) || 'duration-desc',
    metadataCache: (data.metadataCache as Record<string, CachedMetadata>) || {},
  };
}



export async function updateMetadataCache(
  url: string,
  metadata: Omit<CachedMetadata, "timestamp">
) {
  const normalizedUrl = normalizeYoutubeUrl(url);
  const data = await browser.storage.local.get("metadataCache");
  const cache = (data.metadataCache as Record<string, CachedMetadata>) || {};

  cache[normalizedUrl] = {
    ...metadata,
    timestamp: Date.now(),
  };

  // Keep cache size reasonable (last 200 videos)
  const keys = Object.keys(cache);
  if (keys.length > 200) {
    const sortedKeys = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
    delete cache[sortedKeys[0]];
  }

  await browser.storage.local.set({ metadataCache: cache });
}

export async function clearCache(): Promise<void> {
  if (!browser.storage?.local) return;
  await browser.storage.local.set({ metadataCache: {} });
}
