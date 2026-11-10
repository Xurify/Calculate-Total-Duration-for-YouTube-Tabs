import { dateKeyOf } from "./dateKey";

/**
 * A log kept as several storage keys, one per shard, instead of one key holding all of it.
 * Chrome hands the old and the new value of a changed key to every storage.onChanged listener, so the size
 * of a key is what each write costs. With one key per log, a few seconds of watching rewrote the whole year.
 * Only the background writes these logs: the cache of what storage holds would go stale with a second writer.
 */

export interface ShardedEntry {
  id: string;
  startedAt: number;
}

/**
 * Names the shard an entry is stored in: the local day it started. It reads startedAt alone because that is
 * the one field that never changes while an entry grows; an entry that moved shard would be written twice.
 * A day keeps the shard being written to a few kilobytes; a month would already be hundreds.
 */
export function shardOf(startedAt: number): string {
  return dateKeyOf(startedAt);
}

export function shardKey(logKey: string, startedAt: number): string {
  return `${logKey}:${shardOf(startedAt)}`;
}

/** The log's own key counts too: it is where the whole log lived before shards. */
function isShardKey(logKey: string, key: string): boolean {
  return key === logKey || key.startsWith(`${logKey}:`);
}

/** Every shard as one list, oldest first. An entry found twice is taken from the later list. */
export function mergeShards<Entry extends ShardedEntry>(lists: readonly (readonly Entry[])[]): Entry[] {
  const byId = new Map<string | symbol, Entry>();
  for (const list of lists) {
    for (const entry of list) {
      if (!entry || typeof entry !== "object") continue;
      // An entry without an id still has to survive, so it gets a key nothing else can share.
      byId.set(typeof entry.id === "string" && entry.id ? entry.id : Symbol(), entry);
    }
  }
  return [...byId.values()].sort((first, second) => first.startedAt - second.startedAt);
}

export interface SavePlan<Entry> {
  set: Record<string, Entry[]>;
  remove: string[];
  /** What storage holds once the plan is carried out: key → JSON of its entries. */
  stored: Map<string, string>;
}

/** Which keys to write and which to drop so storage matches `entries`, given what it holds now. */
export function planSave<Entry extends ShardedEntry>(
  logKey: string,
  entries: readonly Entry[],
  stored: ReadonlyMap<string, string>
): SavePlan<Entry> {
  const shards = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = shardKey(logKey, entry.startedAt);
    const shard = shards.get(key);
    if (shard) shard.push(entry);
    else shards.set(key, [entry]);
  }
  const set: Record<string, Entry[]> = {};
  const next = new Map<string, string>();
  for (const [key, shard] of shards) {
    const json = JSON.stringify(shard);
    next.set(key, json);
    if (stored.get(key) !== json) set[key] = shard;
  }
  return { set, remove: [...stored.keys()].filter((key) => !shards.has(key)), stored: next };
}

/** getKeys is optional here because older Chrome and Firefox builds do not have it, whatever the typings say. */
interface LocalArea {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  getKeys?: () => Promise<string[]>;
}

export function shardedLog<Entry extends ShardedEntry>(logKey: string): {
  load(): Promise<Entry[]>;
  save(entries: readonly Entry[]): Promise<void>;
} {
  let stored: Map<string, string> | null = null;

  async function read(): Promise<{ lists: Entry[][]; stored: Map<string, string> }> {
    const area = browser.storage.local as unknown as LocalArea;
    // getKeys returns names only. Where it is missing, every stored value has to come along to learn them.
    const everything = area.getKeys ? null : await area.get(null);
    const keys = (everything ? Object.keys(everything) : await area.getKeys!()).filter((key) => isShardKey(logKey, key));
    // The pre-shard key is read first, so a shard already written from it wins.
    keys.sort((first, second) => Number(second === logKey) - Number(first === logKey));
    const data = everything ?? (keys.length > 0 ? await area.get(keys) : {});
    const lists: Entry[][] = [];
    const found = new Map<string, string>();
    for (const key of keys) {
      const value = data[key];
      if (!Array.isArray(value)) continue;
      lists.push(value as Entry[]);
      found.set(key, JSON.stringify(value));
    }
    return { lists, stored: found };
  }

  return {
    async load() {
      const result = await read();
      stored = result.stored;
      return mergeShards(result.lists);
    },
    async save(entries) {
      stored ??= (await read()).stored;
      const plan = planSave(logKey, entries, stored);
      // Written before anything is dropped: a crash in between leaves an entry twice, never missing.
      if (Object.keys(plan.set).length > 0) await browser.storage.local.set(plan.set);
      if (plan.remove.length > 0) await browser.storage.local.remove(plan.remove);
      stored = plan.stored;
    },
  };
}
