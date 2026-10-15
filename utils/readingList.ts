/**
 * Chrome Reading List API integration and type definitions.
 */

export interface ReadingListItem {
  id: string;
  title: string;
  url: string;
  creationTime: number;
}

interface ChromeReadingListEntry {
  title: string;
  url: string;
  hasBeenRead: boolean;
  creationTime: number;
  lastUpdateTime: number;
}

interface ChromeWithReadingList {
  readingList?: {
    query: (queryInfo: { hasBeenRead?: boolean; url?: string }) => Promise<ChromeReadingListEntry[]>;
    removeEntry: (entryInfo: { url: string }) => Promise<void>;
    addEntry?: (entryInfo: { title: string; url: string; hasBeenRead: boolean }) => Promise<void>;
  };
}

/** Stable id for a reading-list row. Agents pass this id; the URL stays on the extension side. */
export function readingListItemId(url: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `rl_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function assignReadingListIds(
  items: Array<Omit<ReadingListItem, "id">>
): ReadingListItem[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const baseId = readingListItemId(item.url);
    const seenCount = seen.get(baseId) ?? 0;
    seen.set(baseId, seenCount + 1);
    return {
      ...item,
      id: seenCount === 0 ? baseId : `${baseId}_${seenCount + 1}`,
    };
  });
}

function getChromeReadingListApi() {
  const globalObject = globalThis as unknown as { chrome?: ChromeWithReadingList };
  return globalObject.chrome?.readingList;
}

export async function queryReadingList(hasBeenRead = false): Promise<ReadingListItem[]> {
  const readingListApi = getChromeReadingListApi();
  if (!readingListApi) {
    return [];
  }

  try {
    const entries = await readingListApi.query({ hasBeenRead });
    return assignReadingListIds(
      entries.map((entry) => ({
        title: entry.title,
        url: entry.url,
        creationTime: entry.creationTime,
      }))
    );
  } catch (error) {
    console.warn("[ReadingList] Failed to query reading list entries:", error);
    return [];
  }
}

/** Removes a row only when `id` matches an item currently on the unread reading list. */
export async function removeReadingListItemById(id: string): Promise<boolean> {
  const trimmedId = id.trim();
  if (!trimmedId || trimmedId.includes("://") || trimmedId.includes("/")) {
    return false;
  }

  const items = await queryReadingList(false);
  const match = items.find((item) => item.id === trimmedId);
  if (!match) {
    return false;
  }

  return removeReadingListItem(match.url);
}

export async function removeReadingListItem(url: string): Promise<boolean> {
  const readingListApi = getChromeReadingListApi();
  if (!readingListApi) {
    return false;
  }

  try {
    await readingListApi.removeEntry({ url });
    return true;
  } catch (error) {
    console.warn(`[ReadingList] Failed to remove entry for url "${url}":`, error);
    return false;
  }
}
