/**
 * Searching data loaded from a database (or any async source).
 * Run with: npx tsx examples/async-provider.ts
 */
import { DataLoadError, type DataProvider, EasySearch } from "../src/index.js";

interface Post {
  id: number;
  title: string;
  content: string;
  author: { name: string };
}

// Stand-in for `prisma.post.findMany()`, a SQL query, an HTTP call, ...
async function getPosts(): Promise<Post[]> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return [
    { id: 1, title: "니아 TTS 봇 출시", content: "디스코드 음성 봇", author: { name: "노아" } },
    { id: 2, title: "검색 라이브러리 소개", content: "EasySearch 사용법", author: { name: "니아" } },
  ];
}

// 1. A plain async function. Loaded on the first search, then reused.
const es = new EasySearch({
  data: () => getPosts(),
  keys: [{ name: "title", weight: 3 }, "content", "author.name"],
});
console.log(await es.search("니아"));

// After the underlying data changed:
await es.reload();

// 2. A provider object, for example to keep connection details together.
class PostProvider implements DataProvider<Post> {
  load(): Promise<Post[]> {
    return getPosts();
  }
}
const viaProvider = new EasySearch({
  data: new PostProvider(),
  keys: ["title"],
  advancedSettings: {
    reloadOnSearch: true, // fetch fresh rows before every search
    fallbackToStaleOnError: true, // ...but keep answering from the last rows if the database is down
    onError: (error) => console.warn("search degraded:", error),
  },
});
console.log(await viaProvider.search("검색"));

// 3. Load errors.
const broken = new EasySearch({ data: async (): Promise<Post[]> => Promise.reject(new Error("db down")) });
try {
  await broken.search("니아");
} catch (error) {
  console.log(error instanceof DataLoadError, (error as Error).cause);
}
