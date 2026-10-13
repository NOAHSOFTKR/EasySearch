/**
 * Synthetic benchmark: `npm run bench` (optionally `-- 10000 100000` for sizes,
 * and `BENCH_VOCABULARY=200000` for the number of distinct words).
 * Numbers depend on the machine; compare runs on the same machine only.
 */
import { CacheStack, MemoryLayer } from "layercache";
import { EasySearch } from "../src/index.js";

let seed = 20261008;
function random(): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = <V>(list: readonly V[]): V => list[Math.floor(random() * list.length)] as V;

const SYLLABLES = "가나다라마바사아자차카타파하검색니아봇라이브러리안녕하세요음성디스코드데이터캐시서버".split("");
const LATIN = "abcdefghijklmnopqrstuvwxyz".split("");

function word(): string {
  const korean = random() < 0.6;
  const length = korean ? 2 + Math.floor(random() * 3) : 3 + Math.floor(random() * 6);
  let text = "";
  for (let i = 0; i < length; i++) text += pick(korean ? SYLLABLES : LATIN);
  return text;
}

const VOCABULARY = Array.from({ length: Number(process.env.BENCH_VOCABULARY ?? 20_000) }, word);
const sentence = (words: number) => Array.from({ length: words }, () => pick(VOCABULARY)).join(" ");

interface Doc {
  id: number;
  title: string;
  content: string;
  author: { name: string };
}

function makeDocs(count: number): Doc[] {
  return Array.from({ length: count }, (_, id) => ({
    id,
    title: sentence(3 + Math.floor(random() * 4)),
    content: sentence(20 + Math.floor(random() * 20)),
    author: { name: sentence(2) },
  }));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

async function time(fn: () => Promise<unknown>, runs: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

const typo = (text: string) => (text.length > 2 ? text.slice(0, -2) + text.slice(-1) + text.slice(-2, -1) : text);

async function run(size: number): Promise<void> {
  const docs = makeDocs(size);
  const keys = [{ name: "title", weight: 3 }, "content", "author.name"] as const;
  const queries = Array.from({ length: 20 }, () => pick(docs).title.split(" ")[0] as string);

  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const es = new EasySearch({ data: () => docs, keys: [...keys] });
  const buildStart = performance.now();
  await es.reload();
  const build = performance.now() - buildStart;
  global.gc?.();
  const heap = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

  const cases: [string, () => Promise<unknown>][] = [
    ["partial, 1 word", () => es.search(pick(queries))],
    ["partial, 2 words", () => es.search(`${pick(queries)} ${pick(VOCABULARY)}`)],
    ["partial, 1 char (most items match)", () => es.search(pick(SYLLABLES))],
    ["partial, 1 char, limit 20", () => es.search(pick(SYLLABLES), { limit: 20 })],
    ["exact", () => es.search(pick(docs).author.name, { mode: "exact" })],
    ["fuzzy, 1 word (typo)", () => es.search(typo(pick(queries)), { mode: "fuzzy" })],
    ["fuzzy, limit 10", () => es.search(typo(pick(queries)), { mode: "fuzzy", limit: 10 })],
  ];

  // Baseline without an index: substring scan over pre-lower-cased fields.
  const flat = docs.map((d) => [d.title.toLowerCase(), d.content.toLowerCase(), d.author.name.toLowerCase()]);
  cases.push([
    "baseline: linear includes() scan, 1 word",
    async () => {
      const q = pick(queries);
      return flat.filter((fields) => fields.some((f) => f.includes(q)));
    },
  ]);

  const cached = new EasySearch({
    data: () => docs,
    keys: [...keys],
    advancedSettings: { cache: new CacheStack([new MemoryLayer({ maxSize: 10_000 })]) },
  });
  await cached.search(queries[0] as string);
  cases.push(["LayerCache result hit", () => cached.search(queries[0] as string)]);

  console.log(`\n## ${size.toLocaleString("en-US")} documents (3 keys)`);
  console.log(`index build: ${build.toFixed(1)} ms, heap: ~${heap.toFixed(1)} MB${global.gc ? "" : " (run with --expose-gc for accuracy)"}`);
  console.log("| case | median ms |\n| --- | ---: |");
  for (const [name, fn] of cases) {
    await time(fn, 3); // warm-up
    console.log(`| ${name} | ${(await time(fn, 30)).toFixed(2)} |`);
  }
  await cached.dispose();
}

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
for (const size of sizes.length > 0 ? sizes : [1_000, 10_000, 100_000]) await run(size);
