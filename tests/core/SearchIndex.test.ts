import { describe, expect, it } from "vitest";
import { SearchIndex, collectValues } from "../../src/core/SearchIndex.js";

const options = { ignoreDiacritics: false, idPath: undefined };
const key = (name: string, weight = 1) => ({ name, path: name === "" ? [] : name.split("."), weight });

describe("collectValues", () => {
  it("reads nested paths and flattens arrays at any depth", () => {
    const out: unknown[] = [];
    collectValues({ a: [{ b: "x" }, { b: ["y", 3] }, { b: null }, { b: true }] }, ["a", "b"], 0, out as never);
    expect(out).toEqual(["x", "y", 3]);
  });

  it("ignores non-finite numbers and missing values", () => {
    const out: unknown[] = [];
    collectValues({ n: Number.NaN, m: undefined }, ["n"], 0, out as never);
    collectValues({ n: Number.NaN, m: undefined }, ["m"], 0, out as never);
    expect(out).toEqual([]);
  });
});

describe("SearchIndex", () => {
  it("discovers top-level searchable keys when none are configured", () => {
    const index = new SearchIndex(
      [
        { id: 1, title: "a", flag: true, meta: { x: "y" } },
        { tags: ["t"], title: "b" },
      ],
      { ...options, keys: undefined },
    );
    expect(index.keys.map((k) => k.name)).toEqual(["id", "title", "tags"]);
  });

  it("indexes primitive items directly", () => {
    const index = new SearchIndex(["니아", "검색"], { ...options, keys: undefined });
    expect(index.keys).toEqual([{ name: "", path: [], weight: 1 }]);
    expect(index.fieldValues(1, 0)).toBe("검색");
  });

  it("stores normalized values and a deduplicated vocabulary", () => {
    const index = new SearchIndex([{ t: "Hello  hello WORLD" }, { t: "world" }], { ...options, keys: [key("t")] });
    expect(index.fieldValues(0, 0)).toBe("hello hello world");
    const world = index.terms.indexOf("world");
    expect(index.postings[world]).toEqual([0, 1]);
    expect(index.postings[index.terms.indexOf("hello")]).toEqual([0]);
  });

  it("keeps the first item per idKey and maps refIndex to the original position", () => {
    const index = new SearchIndex(
      [
        { id: 1, t: "first" },
        { id: 2, t: "second" },
        { id: 1, t: "duplicate" },
        { t: "no id" },
        { id: "1", t: "string id differs from number id" },
      ],
      { ...options, keys: [key("t")], idPath: ["id"] },
    );
    expect(index.items.map((item) => item.t)).toEqual(["first", "second", "no id", "string id differs from number id"]);
    expect(index.refIndexes).toEqual([0, 1, 3, 4]);
  });

  it("builds exact-value maps lazily", () => {
    const index = new SearchIndex([{ t: "a" }, { t: ["a", "b"] }, { t: "c" }], { ...options, keys: [key("t")] });
    expect(index.exactMatches(0, "a")).toEqual([0, 1]);
    expect(index.exactMatches(0, "z")).toEqual([]);
  });
});
