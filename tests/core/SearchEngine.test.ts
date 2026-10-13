import { describe, expect, it } from "vitest";
import { type Hit, rankHits } from "../../src/core/SearchEngine.js";

function makeHits(count: number, seed: number): Hit[] {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  // Few distinct scores, so ties are frequent.
  return Array.from({ length: count }, (_, doc) => ({ doc, score: Math.floor(random() * 5) / 4 }));
}

const fullSort = (hits: Hit[], order: "relevance" | "original") =>
  [...hits].sort((a, b) => (order === "original" ? a.doc - b.doc : b.score - a.score || a.doc - b.doc));

describe("rankHits", () => {
  it("matches a full stable sort for every limit (heap and sort paths)", () => {
    for (const order of ["relevance", "original"] as const) {
      for (const count of [0, 1, 7, 100]) {
        const expected = fullSort(makeHits(count, count + 1), order);
        for (const limit of [undefined, 0, 1, 3, 10, 24, 25, 26, 150]) {
          const shuffled = makeHits(count, count + 1).reverse();
          const ranked = rankHits(shuffled, order, limit);
          expect(ranked.map((h) => h.doc)).toEqual(expected.slice(0, limit ?? count).map((h) => h.doc));
        }
      }
    }
  });
});

describe("executeQuery storage modes", () => {
  it("gives the same results for rare (map-backed) and common (array-backed) matches", async () => {
    const { EasySearch } = await import("../../src/index.js");
    const filler = Array.from({ length: 400 }, (_, i) => ({ id: i, a: `filler ${i}`, b: "x" }));
    const targets = [
      { id: 1000, a: "니아", b: "봇" },
      { id: 1001, a: "니아 봇", b: "x" },
      { id: 1002, a: "x", b: "디스코드 니아" },
    ];
    // Targets first and last, so data order matters for ties.
    const data = [targets[0]!, ...filler, targets[1]!, targets[2]!];
    const es = new EasySearch({ data, keys: ["a", "b"] });

    const rare = await es.search("니아"); // 3 of 403 items: sparse
    expect(rare.map((r) => [r.item.id, r.matches.map((m) => `${m.key}:${m.type}`)])).toEqual([
      [1000, ["a:exact"]],
      [1001, ["a:prefix"]],
      [1002, ["b:word"]],
    ]);
    const rareWords = await es.search("니아 봇");
    expect(rareWords.map((r) => r.item.id)).toEqual([1001, 1000]);

    // Every item matches "x" or "filler": dense.
    const common = await es.search("filler", { limit: 3 });
    expect(common.map((r) => r.item.id)).toEqual([0, 1, 2]);
    const commonAll = await es.search("x");
    expect(commonAll).toHaveLength(402);
    expect(commonAll[0]?.matches).toEqual([{ key: "b", type: "exact" }]);
  });
});
