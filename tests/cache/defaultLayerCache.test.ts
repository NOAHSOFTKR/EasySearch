import { describe, expect, it, vi } from "vitest";
import { EasySearch } from "../../src/index.js";

const created = vi.hoisted(() => [] as { disconnect(): Promise<void>; getMetrics(): { hits: number } }[]);

vi.mock("layercache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("layercache")>();
  class TrackedCacheStack extends actual.CacheStack {
    constructor(...args: ConstructorParameters<typeof actual.CacheStack>) {
      super(...args);
      created.push(this);
    }
  }
  return { ...actual, CacheStack: TrackedCacheStack };
});

describe("useLayerCache: true without a custom cache", () => {
  it("creates one memory CacheStack lazily, uses it, and disconnects it on dispose()", async () => {
    const load = vi.fn(async () => [{ title: "니아 TTS 봇" }, { title: "검색" }]);
    const es = new EasySearch({ data: load, keys: ["title"], advancedSettings: { useLayerCache: true } });
    expect(created).toHaveLength(0);

    const first = await es.search("니아");
    const second = await es.search("니아");
    expect(second).toEqual(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.getMetrics().hits).toBeGreaterThan(0);

    const disconnect = vi.spyOn(created[0]!, "disconnect");
    await es.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not load layercache when caching is disabled", async () => {
    const before = created.length;
    const es = new EasySearch({ data: [{ title: "니아" }], keys: ["title"] });
    expect(await es.search("니아")).toHaveLength(1);
    expect(created.length).toBe(before);
  });

  it("works for invalidate() before the first search", async () => {
    const es = new EasySearch({ data: async () => [{ title: "니아" }], advancedSettings: { useLayerCache: true } });
    await es.invalidate();
    expect(await es.search("니아")).toHaveLength(1);
    await es.dispose();
  });
});
