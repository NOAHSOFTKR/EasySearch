/**
 * Caching through LayerCache (`npm install layercache`).
 * Run with: npx tsx examples/layercache.ts
 */
import { CacheStack, MemoryLayer } from "layercache";
import { EasySearch } from "../src/index.js";

let queries = 0;
async function getPosts() {
  queries++;
  return [
    { id: 1, title: "니아 TTS 봇" },
    { id: 2, title: "검색 라이브러리" },
  ];
}

// 1. Default: an in-memory CacheStack created by EasySearch.
const es = new EasySearch({
  data: () => getPosts(),
  keys: ["title"],
  advancedSettings: { useLayerCache: true, cacheTtl: 30_000 },
});
await es.search("니아");
await es.search("니아"); // result served from the cache
console.log("data source calls:", queries); // 1
await es.invalidate(); // drop cached data and results
await es.dispose(); // disconnects the CacheStack EasySearch created

// 2. Your own CacheStack: add Redis or disk layers here, e.g.
//    new RedisLayer({ client: new Redis(), ttl: 3_600_000 })
const cache = new CacheStack([new MemoryLayer({ ttl: 60_000, maxSize: 5_000 })]);
const shared = new EasySearch({
  data: () => getPosts(),
  keys: ["title"],
  advancedSettings: {
    useLayerCache: true,
    cache,
    cacheKey: "posts", // stable namespace: instances/processes with this key share cached data
    reloadOnSearch: true, // re-read the cached data on each search, the data source only after cacheTtl
  },
});
console.log(await shared.search("검색"));
await cache.disconnect(); // an injected cache is yours to close
