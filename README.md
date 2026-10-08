# EasySearch

Lightweight, dependency-free TypeScript search for your own data. Point it at an
array, a function, or a database query, then call `es.search(query)`.

- Exact, partial (prefix / word / substring) and typo-tolerant fuzzy search
- Relevance ranking with per-field weights and stable ordering
- Korean-aware: NFC/NFD-insensitive, jamo-level typo tolerance (`니야` → `니아`)
- Lazy loading, `reload()`, `invalidate()`, reload-on-search and failure policies
- Optional caching through [LayerCache](https://github.com/flyingsquirrel0419/layercache) (memory, Redis, disk)
- Typed keys: only paths that exist on your data, including `author.name`
- ESM and CommonJS, Node.js 20+

```ts
import { EasySearch } from "@noahsoft/easy-search";

const es = new EasySearch({
  data: () => getPosts(),
  keys: ["title", "content"],
  advancedSettings: {
    useLayerCache: true,
    reloadOnSearch: false,
  },
});

const results = await es.search("니아");
// [{ item: { id: 2, title: "니아 TTS 봇", ... }, refIndex: 1, score: 0.83, matches: [{ key: "title", type: "prefix" }] }, ...]
```

## Installation

```bash
npm install @noahsoft/easy-search
# only if you enable caching:
npm install layercache
```

`layercache` is an optional peer dependency. Without it, everything except
`useLayerCache: true` (without your own `cache`) works.

## Data sources

```ts
// A static array
new EasySearch({ data: [{ id: 1, title: "안녕하세요" }], keys: ["title"] });

// A sync or async function
new EasySearch({ data: () => fetch("/api/posts").then((r) => r.json() as Promise<Post[]>), keys: ["title"] });

// An object with load()
new EasySearch({ data: { load: () => repository.findAll() }, keys: ["title"] });

// Strings directly
new EasySearch({ data: ["니아 TTS 봇", "검색 라이브러리"] });
```

Data is loaded on the first `search()`, not in the constructor. The item type is
inferred from `data`, so `results[i].item` keeps your type.

### Databases

EasySearch does not talk to databases itself; pass a function that does.

```ts
// Prisma
const es = new EasySearch({
  data: () => prisma.post.findMany({ select: { id: true, title: true, content: true, author: { select: { name: true } } } }),
  keys: [{ name: "title", weight: 3 }, "content", "author.name"],
  advancedSettings: { idKey: "id" },
});

// node-postgres
const es2 = new EasySearch({
  data: async () => (await pool.query<Post>("SELECT id, title, content FROM posts")).rows,
  keys: ["title", "content"],
});
```

Errors thrown by the data source reject `search()` / `reload()` with a
`DataLoadError` whose `cause` is the original error.

## Keys and weights

```ts
keys: [
  { name: "title", weight: 3 }, // matches in the title count three times as much
  "content",                     // weight 1
  "author.name",                 // nested field (dot notation)
  "tags",                        // string[] fields: each element is searched
  "comments.body",               // arrays of objects are traversed
]
```

Keys are type-checked: only paths to `string`, `number`, `bigint` (or arrays of
them) are accepted. Without `keys`, primitive items are searched directly and
objects by every top-level string/number property.

## Searching

```ts
const results = await es.search("니아", {
  mode: "fuzzy",       // "exact" | "partial" (default) | "fuzzy"
  limit: 20,
  sort: "relevance",   // "relevance" (default) | "original" | (a, b) => number
  keys: ["title"],     // search a subset of the configured keys
  filter: (post) => post.published,
  maxEdits: 1,         // fuzzy edit budget (default depends on query length)
});

for (const { item, refIndex, score, matches } of results) {
  // matches: [{ key: "title", type: "exact" | "prefix" | "word" | "partial" | "fuzzy" }]
}
```

| mode | finds |
| --- | --- |
| `exact` | the whole field value equals the query |
| `partial` | `exact` + values starting with the query + words starting with it + any substring |
| `fuzzy` | `partial` + words within a small edit distance (typos, transpositions) |

Ranking within one field: exact > prefix > word start > substring > fuzzy, with
shorter values ranking higher inside each level. An item's score is its best
weighted field plus 10% of its other matching fields. Equal scores keep the data
order. Multi-word queries require every word to match (in any field); a match of
the whole phrase ranks above matches of the separate words. `exact` and `prefix`
in `matches` describe the whole query, so a field matched by only one word of a
multi-word query is reported as `word`.

Text is compared after Unicode NFKC normalization and lower-casing, so
`"ＴＴＳ"`, `"tts"` and `"TTS"` match each other and decomposed (NFD) Hangul
matches composed Hangul. Set `advancedSettings.ignoreDiacritics: true` to make
`"cafe"` match `"café"`. Fuzzy search compares Hangul per jamo, so `"검섹"` finds
`"검색"`.

A query that is empty after normalization returns `[]`.

## Reloading data

```ts
await es.search("니아"); // loads on first use, then reuses the index
await es.reload();       // calls the data source again (bypassing the cache), writes the cache, rebuilds the index
await es.invalidate();   // marks data invalid and deletes this instance's cache entries; the next search
                         // loads from the data source (not from the cache)
```

| `advancedSettings` | default | meaning |
| --- | --- | --- |
| `reloadOnSearch` | `false` | `true`: load data before every search (through the cache when enabled) |
| `fallbackToStaleOnError` | `false` | when a search-triggered load fails, search the previous data and report the error to `onError` |
| `onError` | — | receives errors EasySearch recovered from (cache failures, stale fallbacks) |
| `idKey` | — | drop later items with an already seen id (first occurrence wins) |
| `ignoreDiacritics` | `false` | `"cafe"` matches `"café"` |

`reload()` always rejects on failure and keeps the previous data. Concurrent
searches share one load; if loads overlap, the most recently started one wins.

## Caching with LayerCache

EasySearch does not implement a cache. With `useLayerCache`, it stores **the
loaded data** and **search results** in a LayerCache `CacheStack`.

```ts
// In-memory CacheStack created for you (requires `npm install layercache`)
const es = new EasySearch({
  data: () => getPosts(),
  keys: ["title"],
  advancedSettings: { useLayerCache: true, cacheTtl: 60_000 },
});

// ...
await es.dispose(); // disconnects the CacheStack EasySearch created
```

Bring your own stack for Redis or disk layers:

```ts
import { CacheStack, MemoryLayer, RedisLayer } from "layercache";
import Redis from "ioredis";

const customCacheStack = new CacheStack([
  new MemoryLayer({ ttl: 60_000, maxSize: 1_000 }),
  new RedisLayer({ client: new Redis(), ttl: 3_600_000 }),
]);

const es = new EasySearch({
  data: () => getPosts(),
  keys: ["title"],
  advancedSettings: {
    useLayerCache: true,      // defaults to true when `cache` is given
    cache: customCacheStack,  // never disconnected by EasySearch
    cacheKey: "posts",        // stable namespace, shared by every process using it
    cacheTtl: 300_000,        // ms, for entries EasySearch writes (default 60_000)
  },
});
```

| setting | default | meaning |
| --- | --- | --- |
| `useLayerCache` | `cache !== undefined` | enable caching |
| `cache` | memory-only stack | your `CacheStack` |
| `cacheKey` | unique per instance | key namespace; instances with the same `cacheKey` share cached data, so use it only for the same data source |
| `cacheTtl` | `60_000` | TTL in milliseconds |

How it stays consistent:

- Every load from the data source gets a new data version, and result keys
  contain it. New data never returns old results.
- Result keys also contain the search options, a fingerprint of the key
  configuration and a fingerprint of the built index, so different options or
  differently built indexes never share results.
- Concurrent identical searches are computed once (LayerCache stampede prevention).
- Static arrays only cache results (there is nothing to gain from caching the array).
- `filter` functions and custom `sort` comparators bypass the result cache.
- If the cache fails (e.g. Redis is down), EasySearch reports the error to
  `onError` and searches without it.

Across processes sharing Redis:

- A `reload()` in one process writes the new data to the cache; other processes
  see it on their next load. Use `reloadOnSearch: true` to check the cached data
  on every search (the data source is only called when the cached copy expired).
- With a memory layer in front of Redis, configure LayerCache's
  `RedisInvalidationBus` (`broadcastL1Invalidation`) so other processes drop
  their local copies, and `RedisTagIndex` if `invalidate()` should remove cached
  results everywhere. EasySearch relies on LayerCache for this and does not add
  its own messaging.
- Cached data must survive LayerCache serialization (JSON/MessagePack) for
  shared layers; for example, `Date` values come back as strings.

## API

```ts
class EasySearch<T> {
  constructor(options: EasySearchOptions<T>);
  search(query: string, options?: SearchOptions<T>): Promise<SearchResult<T>[]>;
  reload(): Promise<void>;
  invalidate(): Promise<void>;
  dispose(): Promise<void>;
}

interface SearchResult<T> {
  item: T;            // original item
  refIndex: number;   // position in the loaded array
  score: number;      // higher is better, comparable within one search
  matches: { key: string; type: "exact" | "prefix" | "word" | "partial" | "fuzzy" }[];
}
```

Also exported: `DataLoadError` and the types `EasySearchOptions`,
`AdvancedSettings`, `SearchOptions`, `SearchMode`, `SortOrder`, `SearchKey`,
`SearchKeyConfig`, `KeyPath`, `SearchResult`, `SearchMatch`, `MatchType`,
`DataSource`, `DataLoader`, `DataProvider`, `LayerCacheLike`, `CacheEntryOptions`.

Invalid options throw `TypeError` / `RangeError` (from the constructor or the
returned promise).

## Performance

Synthetic data, 3 keys, Node.js 22 (`npm run bench`, median of 30 runs):

| items | index build | 1-word query | 2-word query | fuzzy query | exact | 1 letter, `limit: 20` |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 24 ms | 0.2 ms | 0.1 ms | 0.3 ms | <0.1 ms | 0.4 ms |
| 10,000 | 118 ms | 0.4 ms | 0.5 ms | 0.5 ms | <0.1 ms | 2.9 ms |
| 100,000 | 1.1 s | 2–4 ms | 2–4 ms | 1–2 ms | 0.2 ms | 50 ms |

For comparison, a plain `includes()` scan over the same 100,000 pre-lower-cased
items takes about 14 ms per query. A cached result is returned in well under a
millisecond. Indexing and searching are synchronous: a large index build blocks
the event loop while it runs. Queries matched by most items (e.g. a single
letter) cost time proportional to the number of matches.

## Limitations

- Fuzzy matching works per word; it does not fix missing spaces in long
  unsegmented CJK text and has no initial-consonant (초성) search.
- The index is rebuilt from scratch on every load; there are no incremental updates.
- Remote search (delegating queries to a database) is not included.

See [docs/DESIGN.md](docs/DESIGN.md) for the design and trade-offs (Korean).

## License

MIT
