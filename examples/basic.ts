/**
 * Run with: npx tsx examples/basic.ts
 * (In your project, import from "@noahsoft/easy-search" instead.)
 */
import { EasySearch } from "../src/index.js";

const es = new EasySearch({
  data: [
    { id: 1, title: "안녕하세요", tags: ["greeting"] },
    { id: 2, title: "니아 TTS 봇", tags: ["bot", "tts"] },
    { id: 3, title: "검색 라이브러리", tags: ["search"] },
  ],
  keys: [{ name: "title", weight: 2 }, "tags"],
});

console.log(await es.search("니아"));
console.log(await es.search("검섹", { mode: "fuzzy" })); // typo-tolerant
console.log(await es.search("tts", { mode: "exact", limit: 1 }));
