import { describe, expect, it, vi } from "vitest";
import { DataLoadError, EasySearch, type SearchResult } from "../../src/index.js";

interface Post {
  id: number;
  title: string;
  content?: string;
  author?: { name: string };
  tags?: string[];
}

const posts: Post[] = [
  { id: 1, title: "안녕하세요", content: "첫 인사", author: { name: "노아" }, tags: ["greeting"] },
  { id: 2, title: "니아 TTS 봇", content: "디스코드 음성 봇", author: { name: "니아" }, tags: ["bot", "tts"] },
  { id: 3, title: "검색 라이브러리", content: "니아 검색 예제", author: { name: "노아" }, tags: ["search"] },
  { id: 4, title: "Café guide", content: "coffee and dessert", author: { name: "Zoë" }, tags: ["food"] },
];

const ids = (results: SearchResult<Post>[]) => results.map((r) => r.item.id);

function deferred<V>() {
  let resolve!: (value: V) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("data sources", () => {
  it("searches a static array", async () => {
    const es = new EasySearch({ data: posts, keys: ["title"] });
    expect(ids(await es.search("니아"))).toEqual([2]);
  });

  it("searches data returned by a sync function", async () => {
    const es = new EasySearch({ data: () => posts, keys: ["title"] });
    expect(ids(await es.search("검색"))).toEqual([3]);
  });

  it("searches data returned by an async function, loading lazily on first search", async () => {
    const load = vi.fn(async () => posts);
    const es = new EasySearch({ data: load, keys: ["title"] });
    expect(load).not.toHaveBeenCalled();
    expect(ids(await es.search("니아"))).toEqual([2]);
    expect(ids(await es.search("검색"))).toEqual([3]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("searches a DataProvider object", async () => {
    const provider = { load: vi.fn(() => Promise.resolve(posts)) };
    const es = new EasySearch({ data: provider, keys: ["title"] });
    expect(ids(await es.search("café"))).toEqual([4]);
    expect(provider.load).toHaveBeenCalledTimes(1);
  });

  it("searches primitive items without keys", async () => {
    const es = new EasySearch({ data: ["니아 TTS 봇", "검색 라이브러리"] });
    const results = await es.search("검색");
    expect(results.map((r) => r.item)).toEqual(["검색 라이브러리"]);
    expect(results[0]?.matches).toEqual([{ key: "", type: "prefix" }]);
  });

  it("searches every top-level string/number field when keys are omitted", async () => {
    const es = new EasySearch({ data: posts });
    expect(ids(await es.search("음성"))).toEqual([2]); // content
    expect(ids(await es.search("3", { mode: "exact" }))).toEqual([3]); // id
    expect(await es.search("노아")).toEqual([]); // nested author.name is not discovered
  });

  it("returns the original item objects", async () => {
    const es = new EasySearch({ data: posts, keys: ["title"] });
    const [result] = await es.search("니아");
    expect(result?.item).toBe(posts[1]);
    expect(result?.refIndex).toBe(1);
  });
});

describe("data source errors", () => {
  it("rejects with DataLoadError and keeps the cause", async () => {
    const cause = new Error("db down");
    const es = new EasySearch({ data: async () => Promise.reject(cause), keys: ["title"] });
    const error = await es.search("니아").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DataLoadError);
    expect((error as Error).cause).toBe(cause);
  });

  it("rejects when the source does not return an array", async () => {
    const es = new EasySearch({ data: (() => ({ rows: [] })) as never, keys: ["title"] });
    await expect(es.search("니아")).rejects.toThrow(/must return an array, got object/);
  });

  it("retries the source on the next search after a failure", async () => {
    const load = vi.fn<() => Promise<Post[]>>().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(posts);
    const es = new EasySearch({ data: load, keys: ["title"] });
    await expect(es.search("니아")).rejects.toBeInstanceOf(DataLoadError);
    expect(ids(await es.search("니아"))).toEqual([2]);
  });

  it("throws on stale data by default, and serves it with fallbackToStaleOnError", async () => {
    let fail = false;
    const load = async () => {
      if (fail) throw new Error("db down");
      return posts;
    };
    const strict = new EasySearch({ data: load, keys: ["title"], advancedSettings: { reloadOnSearch: true } });
    await strict.search("니아");
    fail = true;
    await expect(strict.search("니아")).rejects.toBeInstanceOf(DataLoadError);

    fail = false;
    const onError = vi.fn();
    const lenient = new EasySearch({
      data: load,
      keys: ["title"],
      advancedSettings: { reloadOnSearch: true, fallbackToStaleOnError: true, onError },
    });
    await lenient.search("니아");
    fail = true;
    expect(ids(await lenient.search("니아"))).toEqual([2]);
    expect(onError).toHaveBeenCalledWith(expect.any(DataLoadError));
  });

  it("does not fall back when there is no previous data", async () => {
    const es = new EasySearch({
      data: async () => Promise.reject(new Error("db down")),
      keys: ["title"],
      advancedSettings: { fallbackToStaleOnError: true },
    });
    await expect(es.search("니아")).rejects.toBeInstanceOf(DataLoadError);
  });

  it("reload() rejects on failure and keeps the previous data", async () => {
    let data = posts;
    let fail = false;
    const es = new EasySearch({
      data: async () => {
        if (fail) throw new Error("db down");
        return data;
      },
      keys: ["title"],
    });
    await es.search("니아");
    fail = true;
    data = [];
    await expect(es.reload()).rejects.toBeInstanceOf(DataLoadError);
    expect(ids(await es.search("니아"))).toEqual([2]);
  });
});

describe("search modes", () => {
  const es = new EasySearch({ data: posts, keys: ["title", "content", "author.name", "tags"] });

  it("exact: whole value equality only", async () => {
    expect(ids(await es.search("니아", { mode: "exact" }))).toEqual([2]); // author.name
    expect(ids(await es.search("TTS 봇", { mode: "exact" }))).toEqual([]); // only part of the title
    expect(ids(await es.search("tts", { mode: "exact" }))).toEqual([2]); // tags element
  });

  it("partial (default): prefix, word and substring matches", async () => {
    const results = await es.search("니아");
    expect(ids(results)).toEqual([2, 3]);
    expect(results[0]?.matches).toEqual([
      { key: "title", type: "prefix" },
      { key: "author.name", type: "exact" },
    ]);
    expect(results[1]?.matches).toEqual([{ key: "content", type: "prefix" }]);
    expect(ids(await es.search("브러"))).toEqual([3]); // inside a word
  });

  it("partial does not tolerate typos, fuzzy does", async () => {
    expect(await es.search("검섹")).toEqual([]);
    const fuzzy = await es.search("검섹", { mode: "fuzzy" });
    expect(ids(fuzzy)).toEqual([3]);
    expect(fuzzy[0]?.matches.every((m) => m.type === "fuzzy")).toBe(true);
  });

  it("fuzzy still ranks exact and partial matches above typo matches", async () => {
    const data = [{ t: "serach engine" }, { t: "search" }, { t: "research" }];
    const search = new EasySearch({ data, keys: ["t"] });
    const results = await search.search("search", { mode: "fuzzy" });
    expect(results.map((r) => r.item.t)).toEqual(["search", "research", "serach engine"]);
    expect(results.map((r) => r.matches[0]?.type)).toEqual(["exact", "partial", "fuzzy"]);
  });

  it("fuzzy respects maxEdits", async () => {
    const search = new EasySearch({ data: [{ t: "library" }], keys: ["t"] });
    expect(await search.search("libary", { mode: "fuzzy", maxEdits: 0 })).toEqual([]);
    expect(await search.search("libary", { mode: "fuzzy", maxEdits: 1 })).toHaveLength(1);
  });

  it("multi-word queries require every word and prefer phrase matches", async () => {
    const data = [{ t: "니아 디스코드 봇" }, { t: "니아 봇" }, { t: "니아" }, { t: "봇 니아" }];
    const search = new EasySearch({ data, keys: ["t"] });
    const results = await search.search("니아 봇");
    expect(results.map((r) => r.item.t)).toEqual(["니아 봇", "봇 니아", "니아 디스코드 봇"]);
  });

  it("matches words across different fields", async () => {
    expect(ids(await es.search("검색 노아"))).toEqual([3]); // title + author.name
  });

  it("supports fuzzy words inside multi-word queries", async () => {
    expect(ids(await es.search("검섹 라이브러리", { mode: "fuzzy" }))).toEqual([3]);
  });

  it("handles queries without word characters by scanning values", async () => {
    const search = new EasySearch({ data: [{ t: "C++" }, { t: "C#" }], keys: ["t"] });
    expect((await search.search("++")).map((r) => r.item.t)).toEqual(["C++"]);
  });

  it("returns [] for blank queries without loading data", async () => {
    const load = vi.fn(() => posts);
    const search = new EasySearch({ data: load, keys: ["title"] });
    expect(await search.search("   ")).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
});

describe("Korean and Unicode", () => {
  it("matches Hangul regardless of NFC/NFD form", async () => {
    const es = new EasySearch({ data: [{ t: "니아 봇".normalize("NFD") }], keys: ["t"] });
    expect(await es.search("니아")).toHaveLength(1);
    expect(await es.search("니아".normalize("NFD"))).toHaveLength(1);
  });

  it("is case-insensitive and folds full-width forms", async () => {
    const es = new EasySearch({ data: [{ t: "니아 TTS 봇" }], keys: ["t"] });
    expect(await es.search("tts")).toHaveLength(1);
    expect(await es.search("ＴＴＳ")).toHaveLength(1);
  });

  it("ignores diacritics only when configured", async () => {
    const strict = new EasySearch({ data: posts, keys: ["title"] });
    expect(await strict.search("cafe")).toEqual([]);
    const loose = new EasySearch({ data: posts, keys: ["title"], advancedSettings: { ignoreDiacritics: true } });
    expect(ids(await loose.search("cafe"))).toEqual([4]);
  });

  it("uses jamo-level edit distance for Hangul typos", async () => {
    const es = new EasySearch({ data: [{ t: "니아" }, { t: "안녕" }], keys: ["t"] });
    expect((await es.search("니야", { mode: "fuzzy" })).map((r) => r.item.t)).toEqual(["니아"]);
  });

  it("searches emoji, CJK and other scripts", async () => {
    const es = new EasySearch({ data: [{ t: "東京 タワー 🗼" }, { t: "Привет мир" }], keys: ["t"] });
    expect(await es.search("タワー")).toHaveLength(1);
    expect(await es.search("🗼")).toHaveLength(1);
    expect(await es.search("МИР")).toHaveLength(1);
  });
});

describe("fields and weights", () => {
  it("searches only the configured keys", async () => {
    const es = new EasySearch({ data: posts, keys: ["title"] });
    expect(await es.search("음성")).toEqual([]);
  });

  it("supports dot-notation and array fields", async () => {
    const es = new EasySearch({ data: posts, keys: ["author.name", "tags"] });
    expect(ids(await es.search("노아"))).toEqual([1, 3]);
    expect(ids(await es.search("tts"))).toEqual([2]);
  });

  it("restricts a search to some keys with options.keys", async () => {
    const es = new EasySearch({ data: posts, keys: ["title", "content"] });
    expect(ids(await es.search("니아"))).toEqual([2, 3]);
    expect(ids(await es.search("니아", { keys: ["content"] }))).toEqual([3]);
    await expect(es.search("니아", { keys: ["tags" as "title"] })).rejects.toThrow(/not a configured key/);
  });

  it("applies field weights", async () => {
    const data = [
      { title: "other", content: "니아" },
      { title: "니아", content: "other" },
    ];
    const titleFirst = new EasySearch({
      data,
      keys: [
        { name: "title", weight: 3 },
        { name: "content", weight: 1 },
      ],
    });
    expect((await titleFirst.search("니아")).map((r) => r.item.title)).toEqual(["니아", "other"]);
    const contentFirst = new EasySearch({
      data,
      keys: [
        { name: "title", weight: 1 },
        { name: "content", weight: 3 },
      ],
    });
    expect((await contentFirst.search("니아")).map((r) => r.item.title)).toEqual(["other", "니아"]);
  });

  it("rewards matches in several fields", async () => {
    const data = [{ a: "니아", b: "x" }, { a: "니아", b: "니아 봇" }];
    const es = new EasySearch({ data, keys: ["a", "b"] });
    const results = await es.search("니아");
    expect(results.map((r) => r.item.b)).toEqual(["니아 봇", "x"]);
  });

  it("validates key configuration", () => {
    expect(() => new EasySearch({ data: posts, keys: [] })).toThrow(/non-empty/);
    expect(() => new EasySearch({ data: posts, keys: [{ name: "title", weight: 0 }] })).toThrow(/weight/);
    expect(() => new EasySearch({ data: posts, keys: ["title", "title"] })).toThrow(/duplicate/);
    expect(() => new EasySearch({ data: posts, keys: ["author..name" as "title"] })).toThrow(/empty path/);
    expect(() => new EasySearch({ data: posts, keys: ["constructor.name" as "title"] })).toThrow(/not allowed/);
  });
});

describe("ranking, sorting and limits", () => {
  const data = [
    { id: 1, t: "디스코드니아" }, // partial
    { id: 2, t: "니아 봇" }, // prefix
    { id: 3, t: "봇 니아" }, // word
    { id: 4, t: "니아" }, // exact
    { id: 5, t: "니아 봇" }, // prefix, same score as id 2
  ];
  const es = new EasySearch({ data, keys: ["t"] });

  it("orders by relevance: exact > prefix > word > partial, ties in data order", async () => {
    const results = await es.search("니아");
    expect(results.map((r) => r.item.id)).toEqual([4, 2, 5, 3, 1]);
    expect(results.map((r) => r.matches[0]?.type)).toEqual(["exact", "prefix", "prefix", "word", "partial"]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it("is deterministic across repeated searches", async () => {
    const first = await es.search("니아");
    for (let i = 0; i < 5; i++) expect(await es.search("니아")).toEqual(first);
  });

  it("limits the number of results", async () => {
    expect((await es.search("니아", { limit: 2 })).map((r) => r.item.id)).toEqual([4, 2]);
    expect(await es.search("니아", { limit: 0 })).toEqual([]);
    expect(await es.search("니아", { limit: 100 })).toHaveLength(5);
  });

  it("sorts in data order or with a comparator", async () => {
    expect((await es.search("니아", { sort: "original" })).map((r) => r.item.id)).toEqual([1, 2, 3, 4, 5]);
    const byIdDesc = await es.search("니아", { sort: (a, b) => b.item.id - a.item.id, limit: 3 });
    expect(byIdDesc.map((r) => r.item.id)).toEqual([5, 4, 3]);
    const stable = await es.search("니아", { sort: () => 0 });
    expect(stable.map((r) => r.item.id)).toEqual([1, 2, 3, 4, 5]);
  });

  it("filters before limiting", async () => {
    const results = await es.search("니아", { filter: (item) => item.id % 2 === 1, limit: 2 });
    expect(results.map((r) => r.item.id)).toEqual([5, 3]);
  });

  it("validates search options", async () => {
    await expect(es.search("니아", { limit: -1 })).rejects.toThrow(RangeError);
    await expect(es.search("니아", { limit: 1.5 })).rejects.toThrow(RangeError);
    await expect(es.search("니아", { mode: "regex" as "exact" })).rejects.toThrow(/unknown search mode/);
    await expect(es.search("니아", { sort: "date" as "original" })).rejects.toThrow(/unknown sort/);
    await expect(es.search("니아", { maxEdits: -1 })).rejects.toThrow(RangeError);
    await expect(es.search(42 as unknown as string)).rejects.toThrow(TypeError);
  });
});

describe("reload and invalidate", () => {
  it("reload() calls the source again and rebuilds the index", async () => {
    let data: Post[] = [posts[0]!];
    const load = vi.fn(async () => data);
    const es = new EasySearch({ data: load, keys: ["title"] });
    expect(await es.search("니아")).toEqual([]);
    data = posts;
    expect(await es.search("니아")).toEqual([]); // still the loaded data
    await es.reload();
    expect(ids(await es.search("니아"))).toEqual([2]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reload() re-reads a mutated static array", async () => {
    const data = [{ t: "a" }];
    const es = new EasySearch({ data, keys: ["t"] });
    expect(await es.search("니아")).toEqual([]);
    data.push({ t: "니아" });
    expect(await es.search("니아")).toEqual([]);
    await es.reload();
    expect(await es.search("니아")).toHaveLength(1);
  });

  it("invalidate() makes the next search load again", async () => {
    const load = vi.fn(async () => posts);
    const es = new EasySearch({ data: load, keys: ["title"] });
    await es.search("니아");
    await es.invalidate();
    expect(load).toHaveBeenCalledTimes(1);
    await es.search("니아");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloadOnSearch: true loads before every search", async () => {
    let data: Post[] = [];
    const load = vi.fn(async () => data);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { reloadOnSearch: true } });
    expect(await es.search("니아")).toEqual([]);
    data = posts;
    expect(ids(await es.search("니아"))).toEqual([2]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("concurrency", () => {
  it("shares one load between concurrent searches", async () => {
    const gate = deferred<Post[]>();
    const load = vi.fn(() => gate.promise);
    const es = new EasySearch({ data: load, keys: ["title"] });
    const searches = [es.search("니아"), es.search("검색"), es.search("니아")];
    gate.resolve(posts);
    const [a, b, c] = await Promise.all(searches);
    expect(load).toHaveBeenCalledTimes(1);
    expect(ids(a!)).toEqual([2]);
    expect(ids(b!)).toEqual([3]);
    expect(c).toEqual(a);
  });

  it("shares one load between concurrent searches with reloadOnSearch", async () => {
    const gate = deferred<Post[]>();
    const load = vi.fn(() => gate.promise);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { reloadOnSearch: true } });
    const searches = Promise.all([es.search("니아"), es.search("니아")]);
    gate.resolve(posts);
    await searches;
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a reload started during a slow load wins, even if the slow load finishes last", async () => {
    const slow = deferred<Post[]>();
    const fast = deferred<Post[]>();
    const load = vi.fn<() => Promise<Post[]>>().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const es = new EasySearch({ data: load, keys: ["title"] });

    const firstSearch = es.search("니아");
    const reload = es.reload();
    fast.resolve(posts);
    await reload;
    slow.resolve([]); // older data arrives after the reload
    await firstSearch;
    expect(ids(await es.search("니아"))).toEqual([2]);
  });

  it("a search after invalidate() does not reuse a load that started before it", async () => {
    const before = deferred<Post[]>();
    const load = vi.fn<() => Promise<Post[]>>().mockReturnValueOnce(before.promise).mockResolvedValue(posts);
    const es = new EasySearch({ data: load, keys: ["title"] });

    const early = es.search("니아");
    await es.invalidate();
    const late = es.search("니아");
    expect(ids(await late)).toEqual([2]);
    before.resolve([]);
    // The outdated load finishes last: it is dropped and its caller gets the newer data.
    expect(ids(await early)).toEqual([2]);
    expect(ids(await es.search("니아"))).toEqual([2]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("index and data consistency", () => {
  it("results always come from a single data load", async () => {
    let version = 0;
    const load = async () => {
      version++;
      return Array.from({ length: 50 }, (_, i) => ({ id: i, t: `니아 ${version}` }));
    };
    const es = new EasySearch({ data: load, keys: ["t"], advancedSettings: { reloadOnSearch: true } });
    const results = await Promise.all(Array.from({ length: 10 }, () => es.search("니아")));
    for (const list of results) {
      expect(list).toHaveLength(50);
      expect(new Set(list.map((r) => r.item.t)).size).toBe(1);
      for (const r of list) expect(r.item.id).toBe(r.refIndex);
    }
  });

  it("deduplicates by idKey with first-occurrence-wins", async () => {
    const data = [
      { id: 1, t: "니아 1" },
      { id: 1, t: "니아 2" },
      { id: 2, t: "니아 3" },
    ];
    const es = new EasySearch({ data, keys: ["t"], advancedSettings: { idKey: "id" } });
    const results = await es.search("니아");
    expect(results.map((r) => [r.item.t, r.refIndex])).toEqual([
      ["니아 1", 0],
      ["니아 3", 2],
    ]);
  });
});

describe("lifecycle and validation", () => {
  it("rejects invalid data sources and settings", () => {
    expect(() => new EasySearch({ data: 42 as never })).toThrow(/data/);
    expect(() => new EasySearch({ data: posts, advancedSettings: { cacheTtl: 0 } })).toThrow(/cacheTtl/);
    expect(() => new EasySearch({ data: posts, advancedSettings: { cacheKey: "" } })).toThrow(/cacheKey/);
    expect(() => new EasySearch({ data: posts, advancedSettings: { cacheKey: "a\nb" } })).toThrow(/cacheKey/);
    expect(() => new EasySearch({ data: posts, advancedSettings: { cache: {} as never } })).toThrow(/CacheStack/);
  });

  it("cannot be used after dispose()", async () => {
    const es = new EasySearch({ data: posts, keys: ["title"] });
    await es.search("니아");
    await es.dispose();
    await es.dispose();
    await expect(es.search("니아")).rejects.toThrow(/disposed/);
    await expect(es.reload()).rejects.toThrow(/disposed/);
  });

  it("keeps working when the onError hook throws", async () => {
    let fail = false;
    const es = new EasySearch({
      data: async () => {
        if (fail) throw new Error("db down");
        return posts;
      },
      keys: ["title"],
      advancedSettings: {
        reloadOnSearch: true,
        fallbackToStaleOnError: true,
        onError: () => {
          throw new Error("hook failed");
        },
      },
    });
    await es.search("니아");
    fail = true;
    expect(ids(await es.search("니아"))).toEqual([2]);
  });
});
