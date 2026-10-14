/**
 * Chrome Reading List API integration and type definitions.
 */

export interface ReadingListItem {
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
    return entries.map((entry) => ({
      title: entry.title,
      url: entry.url,
      creationTime: entry.creationTime,
    }));
  } catch (error) {
    console.warn("[ReadingList] Failed to query reading list entries:", error);
    return [];
  }
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
