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
}

export interface CachedMetadata {
  seconds: number;
  title: string;
  channelName: string;
  currentTime: number;
  isLive: boolean;
  timestamp: number;
}

export async function saveStorage(
  videoData: VideoData[],
  sortByDuration: boolean,
  smartSync: boolean
): Promise<void> {
  if (!browser.storage?.local) return;
  const excludedUrls = videoData.filter((video) => video.excluded).map((video) => video.url);
  await browser.storage.local.set({
    sortByDuration,
    excludedUrls,
    smartSync,
  });
}

export async function loadStorage(): Promise<{
  sortByDuration: boolean;
  excludedUrls: string[];
  smartSync: boolean;
  metadataCache: Record<string, CachedMetadata>;
}> {
  if (!browser.storage?.local) {
    console.warn("Storage API not available.");
    return { sortByDuration: false, excludedUrls: [], smartSync: true, metadataCache: {} };
  }
  const data = await browser.storage.local.get(["sortByDuration", "excludedUrls", "smartSync", "metadataCache"]);
  return {
    sortByDuration: Boolean(data.sortByDuration),
    excludedUrls: (data.excludedUrls as string[]) || [],
    smartSync: data.smartSync !== undefined ? Boolean(data.smartSync) : true,
    metadataCache: (data.metadataCache as Record<string, CachedMetadata>) || {},
  };
}

export async function updateMetadataCache(
  url: string,
  metadata: Omit<CachedMetadata, "timestamp">
) {
  if (!url) return;
  const data = await browser.storage.local.get("metadataCache");
  const cache = (data.metadataCache as Record<string, CachedMetadata>) || {};

  cache[url] = {
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
