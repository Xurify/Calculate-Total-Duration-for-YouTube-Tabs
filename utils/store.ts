import { getVideoIdFromUrl } from "./format";
import type { CachedMetadata, UserPrefs } from "./storage";
import { normalizeYoutubeUrl, toDurableMetadata } from "./storage";

export interface StoreState {
  prefs: UserPrefs;
  metadataCache: Record<string, CachedMetadata>;
}

export const METADATA_CACHE_MAX = 300;

export type MetadataBatchEntry = {
  url: string;
  metadata: Omit<CachedMetadata, "timestamp">;
};

/** Apply a batch of metadata updates to an in-memory cache (background-owned). */
export function applyMetadataBatchToCache(
  cache: Record<string, CachedMetadata>,
  batch: Map<string, MetadataBatchEntry>
): void {
  for (const [normalizedUrl, { url, metadata }] of batch) {
    const existing = cache[normalizedUrl];
    const durable = toDurableMetadata(metadata);
    const shouldUpdateDuration = durable.seconds > 0 || !existing || durable.isLive;
    const isPlaceholderTitle =
      !durable.title || durable.title === "YouTube Video" || durable.title === "YouTube";
    const shouldUpdateTitle =
      !isPlaceholderTitle ||
      !existing?.title ||
      existing.title === "YouTube Video" ||
      existing.title === "YouTube";
    const videoId = durable.videoId ?? getVideoIdFromUrl(url) ?? undefined;
    cache[normalizedUrl] = {
      ...(existing || {}),
      ...durable,
      videoId: videoId ?? existing?.videoId,
      seconds: shouldUpdateDuration ? durable.seconds : existing?.seconds ?? 0,
      title: shouldUpdateTitle ? durable.title : existing?.title ?? durable.title,
      timestamp: Date.now(),
    };
  }
  const keys = Object.keys(cache);
  if (keys.length > METADATA_CACHE_MAX) {
    const sortedKeys = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
    const toRemove = sortedKeys.slice(0, keys.length - METADATA_CACHE_MAX);
    toRemove.forEach((key) => delete cache[key]);
  }
}

export function normalizeMetadataBatch(
  batch: Map<string, { url: string; metadata: Omit<CachedMetadata, "timestamp"> }>
): Map<string, MetadataBatchEntry> {
  const normalized = new Map<string, MetadataBatchEntry>();
  for (const [, entry] of batch) {
    normalized.set(normalizeYoutubeUrl(entry.url), entry);
  }
  return normalized;
}

/** Read the authoritative store snapshot from the background service worker. */
export async function fetchStoreState(): Promise<StoreState> {
  const response = await browser.runtime.sendMessage({ action: "get-store-state" });
  if (!response?.prefs || !response.metadataCache) {
    throw new Error("Failed to load store state from background");
  }
  return {
    prefs: response.prefs as UserPrefs,
    metadataCache: response.metadataCache as Record<string, CachedMetadata>,
  };
}

/** Patch prefs via background store (optimistic UI should update local state first). */
export async function patchStorePrefs(updates: Partial<UserPrefs>): Promise<void> {
  await browser.runtime.sendMessage({ action: "update-prefs", updates });
}

/** Clear metadata cache via background store. */
export async function clearStoreMetadataCache(): Promise<void> {
  await browser.runtime.sendMessage({ action: "clear-metadata-cache" });
}

export interface StoreUpdatedMessage {
  action: "store-updated";
  prefs?: UserPrefs;
  metadataCache?: Record<string, CachedMetadata>;
}

export function isStoreUpdatedMessage(message: unknown): message is StoreUpdatedMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as StoreUpdatedMessage).action === "store-updated"
  );
}

export function applyStorePatch(
  state: StoreState,
  patch: { prefs?: UserPrefs; metadataCache?: Record<string, CachedMetadata> }
): void {
  if (patch.prefs) state.prefs = patch.prefs;
  if (patch.metadataCache) state.metadataCache = patch.metadataCache;
}
