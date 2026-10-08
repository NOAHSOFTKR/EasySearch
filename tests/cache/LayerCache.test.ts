import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CacheFetcher, type CacheGetOptions, CacheStack, DiskLayer, MemoryLayer } from "layercache";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EasySearch, type LayerCacheLike } from "../../src/index.js";

interface Post {
  id: number;
  title: string;
}

const posts: Post[] = [
  { id: 1, title: "안녕하세요" },
  { id: 2, title: "니아 TTS 봇" },
  { id: 3, title: "검색 라이브러리" },
  { id: 4, title: "니아" },
];

const stacks: CacheStack[] = [];
function memoryStack(): CacheStack {
  const stack = new CacheStack([new MemoryLayer({ maxSize: 1000 })]);
  stacks.push(stack);
  return stack;
}

/** Records which cache keys had to run their fetcher (i.e. missed). */
function recordFetches(cache: CacheStack): string[] {
  const fetched: string[] = [];
  const get = cache.get.bind(cache);
  cache.get = (<V>(key: string, fetcher?: CacheFetcher<V>, options?: CacheGetOptions) =>
    get<V>(
      key,
      fetcher &&
        (async (ctx) => {
          fetched.push(key);
          return fetcher(ctx);
        }),
      options,
    )) as typeof cache.get;
  return fetched;
}

const isResultKey = (key: string) => key.includes(":result:");
const isDataKey = (key: string) => key.endsWith(":data");

afterEach(async () => {
  await Promise.all(stacks.splice(0).map((stack) => stack.disconnect()));
});

describe("custom CacheStack injection", () => {
  it("accepts a real CacheStack and caches the data load and the results", async () => {
    const cache = memoryStack();
    const fetched = recordFetches(cache);
    const load = vi.fn(async () => posts);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { useLayerCache: true, cache } });

    const first = await es.search("니아");
    const second = await es.search("니아");
    expect(second).toEqual(first);
    expect(first.map((r) => r.item.id)).toEqual([4, 2]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetched.filter(isDataKey)).toHaveLength(1);
    expect(fetched.filter(isResultKey)).toHaveLength(1);
    expect(cache.getMetrics().hits).toBeGreaterThan(0);
  });

  it("enables caching when `cache` is given without useLayerCache, and can be turned off explicitly", async () => {
    const cache = memoryStack();
    const fetched = recordFetches(cache);
    await new EasySearch({ data: posts, keys: ["title"], advancedSettings: { cache } }).search("니아");
    expect(fetched).toHaveLength(1);

    await new EasySearch({ data: posts, keys: ["title"], advancedSettings: { cache, useLayerCache: false } }).search(
      "니아",
    );
    expect(fetched).toHaveLength(1);
  });

  it("returns the original item objects from cached results", async () => {
    const cache = memoryStack();
    const es = new EasySearch({ data: async () => posts, keys: ["title"], advancedSettings: { cache } });
    await es.search("니아");
    const [cached] = await es.search("니아");
    expect(cached?.item).toBe(posts[3]);
  });

  it("does not cache the load of a static array, only results", async () => {
    const cache = memoryStack();
    const fetched = recordFetches(cache);
    const es = new EasySearch({ data: posts, keys: ["title"], advancedSettings: { cache } });
    await es.search("니아");
    expect(fetched.some(isDataKey)).toBe(false);
    expect(fetched.filter(isResultKey)).toHaveLength(1);
  });

  it("never disconnects an injected cache", async () => {
    const cache = memoryStack();
    const disconnect = vi.spyOn(cache, "disconnect");
    const es = new EasySearch({ data: posts, keys: ["title"], advancedSettings: { cache } });
    await es.search("니아");
    await es.dispose();
    expect(disconnect).not.toHaveBeenCalled();
  });
});

describe("cache keys", () => {
  it("keeps results of different search options apart", async () => {
    const cache = memoryStack();
    const fetched = recordFetches(cache);
    const es = new EasySearch({ data: posts, keys: ["title"], advancedSettings: { cache } });

    expect((await es.search("니아")).map((r) => r.item.id)).toEqual([4, 2]);
    expect((await es.search("니아", { limit: 1 })).map((r) => r.item.id)).toEqual([4]);
    expect((await es.search("니아", { sort: "original" })).map((r) => r.item.id)).toEqual([2, 4]);
    expect((await es.search("니아", { mode: "exact" })).map((r) => r.item.id)).toEqual([4]);
    expect(await es.search("검섹")).toEqual([]);
    expect((await es.search("검섹", { mode: "fuzzy" })).map((r) => r.item.id)).toEqual([3]);
    expect(await es.search("검섹", { mode: "fuzzy", maxEdits: 0 })).toEqual([]);
    // Same normalized query and options: served from the cache.
    expect((await es.search("  니아 ")).map((r) => r.item.id)).toEqual([4, 2]);

    expect(new Set(fetched.filter(isResultKey)).size).toBe(7);
    expect(fetched.filter(isResultKey)).toHaveLength(7);
  });

  it("bypasses the result cache for filter functions and custom comparators", async () => {
    const cache = memoryStack();
    const fetched = recordFetches(cache);
    const es = new EasySearch({ data: posts, keys: ["title"], advancedSettings: { cache } });
    expect((await es.search("니아", { filter: (p) => p.id === 2 })).map((r) => r.item.id)).toEqual([2]);
    expect((await es.search("니아", { sort: (a, b) => a.item.id - b.item.id })).map((r) => r.item.id)).toEqual([2, 4]);
    expect(fetched).toHaveLength(0);
  });

  it("isolates instances that share a CacheStack by default", async () => {
    const cache = memoryStack();
    const a = new EasySearch({ data: async () => posts, keys: ["title"], advancedSettings: { cache } });
    const b = new EasySearch({
      data: async () => [{ id: 9, title: "니아 다른 데이터" }],
      keys: ["title"],
      advancedSettings: { cache },
    });
    expect((await a.search("니아")).map((r) => r.item.id)).toEqual([4, 2]);
    expect((await b.search("니아")).map((r) => r.item.id)).toEqual([9]);
  });

  it("shares cached data between instances with the same cacheKey", async () => {
    const cache = memoryStack();
    const loadA = vi.fn(async () => posts);
    const loadB = vi.fn(async () => posts);
    const settings = { cache, cacheKey: "posts" };
    const a = new EasySearch({ data: loadA, keys: ["title"], advancedSettings: settings });
    const b = new EasySearch({ data: loadB, keys: ["title"], advancedSettings: settings });
    await a.search("니아");
    expect((await b.search("니아")).map((r) => r.item.id)).toEqual([4, 2]);
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).not.toHaveBeenCalled();
  });

  it("does not share results between same-cacheKey instances with different key configurations", async () => {
    const cache = memoryStack();
    const data = async () => [{ id: 1, title: "x", body: "니아" }];
    const settings = { cache, cacheKey: "shared" };
    const byTitle = new EasySearch({ data, keys: ["title"], advancedSettings: settings });
    const byBody = new EasySearch({ data, keys: ["body"], advancedSettings: settings });
    expect(await byTitle.search("니아")).toEqual([]);
    expect(await byBody.search("니아")).toHaveLength(1);
  });

  it("skips the result cache for queries that would exceed LayerCache's key length limit", async () => {
    const cache = memoryStack();
    const onError = vi.fn();
    const long = "니아".repeat(600);
    const es = new EasySearch({ data: [{ t: long }], keys: ["t"], advancedSettings: { cache, onError } });
    expect(await es.search(long)).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("escapes control characters in queries", async () => {
    const cache = memoryStack();
    const onError = vi.fn();
    const es = new EasySearch({ data: [{ t: "a\u007fb" }], keys: ["t"], advancedSettings: { cache, onError } });
    expect(await es.search("a\u007fb")).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("invalidation and reload", () => {
  it("invalidate() deletes this instance's entries and reloads on the next search", async () => {
    const cache = memoryStack();
    let data = posts;
    const load = vi.fn(async () => data);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { cache, cacheKey: "posts" } });
    await es.search("니아");
    expect(await cache.has("easysearch:posts:data")).toBe(true);

    data = [{ id: 7, title: "니아 새 글" }];
    await es.invalidate();
    expect(await cache.has("easysearch:posts:data")).toBe(false);
    expect((await es.search("니아")).map((r) => r.item.id)).toEqual([7]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reload() bypasses the cached data and writes the fresh data back", async () => {
    const cache = memoryStack();
    let data = posts;
    const settings = { cache, cacheKey: "posts" };
    const a = new EasySearch({ data: async () => data, keys: ["title"], advancedSettings: settings });
    await a.search("니아");
    data = [{ id: 8, title: "니아 갱신" }];
    await a.reload();
    expect((await a.search("니아")).map((r) => r.item.id)).toEqual([8]);

    // Another instance (think: another process on a shared cache) sees the reloaded data.
    const loadB = vi.fn(async () => posts);
    const b = new EasySearch({ data: loadB, keys: ["title"], advancedSettings: settings });
    expect((await b.search("니아")).map((r) => r.item.id)).toEqual([8]);
    expect(loadB).not.toHaveBeenCalled();
  });

  it("reloadOnSearch with a cache only calls the source when the cached data expired", async () => {
    const cache = memoryStack();
    const load = vi.fn(async () => posts);
    const es = new EasySearch({
      data: load,
      keys: ["title"],
      advancedSettings: { cache, reloadOnSearch: true, cacheTtl: 40 },
    });
    await es.search("니아");
    await es.search("검색");
    expect(load).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await es.search("니아");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloadOnSearch picks up data reloaded by another instance", async () => {
    const cache = memoryStack();
    let data = posts;
    const settings = { cache, cacheKey: "posts" };
    const writer = new EasySearch({ data: async () => data, keys: ["title"], advancedSettings: settings });
    const reader = new EasySearch({
      data: async () => data,
      keys: ["title"],
      advancedSettings: { ...settings, reloadOnSearch: true },
    });
    expect((await reader.search("니아")).map((r) => r.item.id)).toEqual([4, 2]);
    data = [{ id: 5, title: "니아 5" }];
    await writer.reload();
    expect((await reader.search("니아")).map((r) => r.item.id)).toEqual([5]);
  });
});

describe("concurrency with a cache", () => {
  it("deduplicates concurrent identical searches", async () => {
    const cache = memoryStack();
    const fetched = recordFetches(cache);
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return posts;
    });
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { cache } });
    const results = await Promise.all(Array.from({ length: 10 }, () => es.search("니아")));
    for (const list of results) expect(list.map((r) => r.item.id)).toEqual([4, 2]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetched.filter(isResultKey)).toHaveLength(1);
  });

  it("deduplicates concurrent loads of instances sharing a cacheKey (LayerCache stampede prevention)", async () => {
    const cache = memoryStack();
    const load = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return posts;
    });
    const settings = { cache, cacheKey: "posts" };
    const instances = Array.from({ length: 5 }, () => new EasySearch({ data: load, keys: ["title"], advancedSettings: settings }));
    await Promise.all(instances.map((es) => es.search("니아")));
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("cache failures", () => {
  const broken = (): LayerCacheLike => ({
    get: async () => Promise.reject(new Error("redis down")),
    set: async () => Promise.reject(new Error("redis down")),
    delete: async () => Promise.reject(new Error("redis down")),
    invalidateByTag: async () => Promise.reject(new Error("redis down")),
  });

  it("searches without the cache and reports the error", async () => {
    const onError = vi.fn();
    const load = vi.fn(async () => posts);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { cache: broken(), onError } });
    expect((await es.search("니아")).map((r) => r.item.id)).toEqual([4, 2]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "redis down" }));
    await es.reload();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("propagates data source errors thrown inside the cache fetcher without calling the source twice", async () => {
    const cache = memoryStack();
    const onError = vi.fn();
    const load = vi.fn(async () => Promise.reject(new Error("db down")));
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { cache, onError } });
    await expect(es.search("니아")).rejects.toThrow(/failed to load/);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("invalidate() rejects when the cache cannot be cleared, but local data is still invalidated", async () => {
    const load = vi.fn(async () => posts);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { cache: broken(), onError: () => {} } });
    await es.search("니아");
    await expect(es.invalidate()).rejects.toThrow("redis down");
    await es.search("니아");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("ignores malformed cache entries", async () => {
    const cache = memoryStack();
    await cache.set("easysearch:posts:data", { unexpected: true });
    const onError = vi.fn();
    const load = vi.fn(async () => posts);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { cache, cacheKey: "posts", onError } });
    expect((await es.search("니아")).map((r) => r.item.id)).toEqual([4, 2]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("malformed") }));
  });
});

describe("serializing layers (DiskLayer as a stand-in for a shared cache)", () => {
  let directory: string | undefined;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("shares data and results through a persistent layer between separate CacheStacks", async () => {
    directory = await mkdtemp(join(tmpdir(), "easysearch-"));
    const processStack = () => {
      const stack = new CacheStack([new MemoryLayer(), new DiskLayer({ directory: directory as string })]);
      stacks.push(stack);
      return stack;
    };
    const loadA = vi.fn(async () => posts);
    const a = new EasySearch({ data: loadA, keys: ["title"], advancedSettings: { cache: processStack(), cacheKey: "posts" } });
    const fromA = await a.search("니아");

    const cacheB = processStack();
    const fetchedB = recordFetches(cacheB);
    const loadB = vi.fn(async () => posts);
    const b = new EasySearch({ data: loadB, keys: ["title"], advancedSettings: { cache: cacheB, cacheKey: "posts" } });
    const fromB = await b.search("니아");

    expect(loadB).not.toHaveBeenCalled();
    expect(fetchedB).toHaveLength(0); // data and results both came from disk
    expect(fromB.map(({ refIndex, score, matches }) => ({ refIndex, score, matches }))).toEqual(
      fromA.map(({ refIndex, score, matches }) => ({ refIndex, score, matches })),
    );
    expect(fromB[0]?.item).toEqual(posts[3]); // deserialized copy of the data
  });
});
