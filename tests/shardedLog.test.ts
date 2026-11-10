import { describe, expect, test } from "bun:test";
import { sameLimitWarningsShown, type LimitWarningsShown } from "../utils/languageLimits";
import { mergeShards, planSave, shardedLog, shardKey, shardOf } from "../utils/shardedLog";

const KEY = "watchLog";
const at = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
const entry = (id: string, startedAt: number, playedSeconds = 60) => ({ id, startedAt, playedSeconds });

/** Storage as it stands after `entries` were saved into an empty one. */
const storedAfter = (entries: ReturnType<typeof entry>[]) => planSave(KEY, entries, new Map()).stored;

describe("shardOf", () => {
  test("gives two moments of one local day the same shard", () => {
    expect(shardOf(at(11, 10, 0))).toBe(shardOf(at(11, 10, 23)));
  });

  test("keeps this week apart from two months ago", () => {
    expect(shardOf(at(11, 10))).not.toBe(shardOf(at(9, 3)));
  });
});

describe("planSave", () => {
  test("writes every shard and drops the single key the log used to live in", () => {
    const entries = [entry("a", at(9, 3)), entry("b", at(11, 10))];
    const plan = planSave(KEY, entries, new Map([[KEY, JSON.stringify(entries)]]));
    expect(Object.values(plan.set).flat()).toEqual(entries);
    expect(plan.remove).toEqual([KEY]);
    expect(plan.stored.has(KEY)).toBe(false);
  });

  test("writes nothing when nothing changed", () => {
    const entries = [entry("a", at(9, 3)), entry("b", at(11, 10))];
    const plan = planSave(KEY, entries, storedAfter(entries));
    expect(plan.set).toEqual({});
    expect(plan.remove).toEqual([]);
  });

  test("a few more seconds today leave an old shard unwritten", () => {
    const old = entry("a", at(9, 3));
    const today = entry("b", at(11, 10));
    const stored = storedAfter([old, today]);
    today.playedSeconds += 15;
    const plan = planSave(KEY, [old, today], stored);
    expect(plan.set[shardKey(KEY, today.startedAt)]).toEqual([today]);
    expect(Object.keys(plan.set)).toHaveLength(1);
  });

  test("drops a shard whose entries are all gone", () => {
    const old = entry("a", at(9, 3));
    const today = entry("b", at(11, 10));
    const stored = storedAfter([old, today]);
    const kept = shardKey(KEY, today.startedAt);
    const plan = planSave(KEY, [today], stored);
    expect(plan.remove).toEqual([...stored.keys()].filter((key) => key !== kept));
    expect([...plan.stored]).toEqual([[kept, JSON.stringify([today])]]);
  });

  test("clearing the log drops every key", () => {
    const entries = [entry("a", at(9, 3)), entry("b", at(11, 10))];
    const stored = storedAfter(entries);
    const plan = planSave(KEY, [], stored);
    expect(plan.set).toEqual({});
    expect(plan.remove.sort()).toEqual([...stored.keys()].sort());
  });
});

describe("mergeShards", () => {
  test("returns one list, oldest first", () => {
    const merged = mergeShards([[entry("b", at(11, 10))], [entry("a", at(9, 3))]]);
    expect(merged.map((each) => each.id)).toEqual(["a", "b"]);
  });

  test("takes an entry found twice from the later list", () => {
    const merged = mergeShards([[entry("a", at(11, 10), 60)], [entry("a", at(11, 10), 75)]]);
    expect(merged).toEqual([entry("a", at(11, 10), 75)]);
  });

  test("keeps entries that have no id", () => {
    const nameless = { startedAt: at(11, 10) } as ReturnType<typeof entry>;
    expect(mergeShards([[nameless, { ...nameless }]])).toHaveLength(2);
  });
});

/** storage.local in memory. Values go through JSON, as they do on their way into Chrome's store. */
function fakeStorage(initial: Record<string, unknown>, withGetKeys: boolean) {
  const data = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const writes: string[][] = [];
  const local = {
    async get(keys: string[] | null) {
      const wanted = keys ?? [...data.keys()];
      return Object.fromEntries(wanted.filter((key) => data.has(key)).map((key) => [key, JSON.parse(data.get(key)!)]));
    },
    async set(items: Record<string, unknown>) {
      writes.push(Object.keys(items));
      for (const [key, value] of Object.entries(items)) data.set(key, JSON.stringify(value));
    },
    async remove(keys: string[]) {
      for (const key of keys) data.delete(key);
    },
    ...(withGetKeys ? { getKeys: async () => [...data.keys()] } : {}),
  };
  (globalThis as unknown as { browser: unknown }).browser = { storage: { local } };
  return { keys: () => [...data.keys()], writes };
}

describe.each([true, false])("shardedLog (getKeys available: %p)", (withGetKeys) => {
  const entries = [entry("a", at(9, 3)), entry("b", at(11, 10))];

  test("moves a log out of its single key without losing an entry", async () => {
    const storage = fakeStorage({ [KEY]: entries, timeLog: [entry("other", at(11, 1))], watchLogSettings: true }, withGetKeys);
    const log = shardedLog<ReturnType<typeof entry>>(KEY);
    const loaded = await log.load();
    expect(loaded).toEqual(entries);
    await log.save(loaded);
    expect(storage.keys()).not.toContain(KEY);
    expect(storage.keys()).toContain("timeLog");
    expect(storage.keys()).toContain("watchLogSettings");
    expect(await shardedLog<ReturnType<typeof entry>>(KEY).load()).toEqual(entries);
  });

  test("does not write again when nothing changed since the load", async () => {
    const storage = fakeStorage({}, withGetKeys);
    await shardedLog<ReturnType<typeof entry>>(KEY).save(entries);
    const log = shardedLog<ReturnType<typeof entry>>(KEY);
    await log.save(await log.load());
    expect(storage.writes).toHaveLength(1);
  });

  test("clears a log it never loaded", async () => {
    const storage = fakeStorage({ [KEY]: entries, timeLog: [] }, withGetKeys);
    await shardedLog<ReturnType<typeof entry>>(KEY).save([]);
    expect(storage.keys()).toEqual(["timeLog"]);
  });

  test("reads an entry once when a crash left it in the old key and in a shard", async () => {
    const grown = { ...entries[1], playedSeconds: 90 };
    fakeStorage({ [shardKey(KEY, grown.startedAt)]: [grown], [KEY]: entries }, withGetKeys);
    expect(await shardedLog<ReturnType<typeof entry>>(KEY).load()).toEqual([entries[0], grown]);
  });
});

describe("sameLimitWarningsShown", () => {
  test("ignores the order of the levels", () => {
    const first: LimitWarningsShown = { day: "2026-11-10", levels: { sk: "near", et: "over" } };
    const second: LimitWarningsShown = { day: "2026-11-10", levels: { et: "over", sk: "near" } };
    expect(sameLimitWarningsShown(first, second)).toBe(true);
  });

  test("sees a new day, a new level and a dropped level", () => {
    const shown: LimitWarningsShown = { day: "2026-11-10", levels: { sk: "near" } };
    expect(sameLimitWarningsShown(null, shown)).toBe(false);
    expect(sameLimitWarningsShown({ ...shown, day: "2026-11-09" }, shown)).toBe(false);
    expect(sameLimitWarningsShown({ ...shown, levels: { sk: "over" } }, shown)).toBe(false);
    expect(sameLimitWarningsShown({ ...shown, levels: { sk: "near", et: "near" } }, shown)).toBe(false);
  });
});
