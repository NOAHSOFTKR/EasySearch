import { describe, expect, it, vi } from "vitest";
import { EasySearch } from "../../src/index.js";

vi.mock("layercache", () => {
  const error = Object.assign(new Error("Cannot find package 'layercache'"), { code: "ERR_MODULE_NOT_FOUND" });
  throw error;
});

describe("without the optional layercache package", () => {
  it("searches normally when caching is disabled", async () => {
    const es = new EasySearch({ data: async () => [{ title: "니아" }], keys: ["title"] });
    expect(await es.search("니아")).toHaveLength(1);
  });

  it("explains how to fix useLayerCache: true", async () => {
    const es = new EasySearch({ data: async () => [{ title: "니아" }], advancedSettings: { useLayerCache: true } });
    await expect(es.search("니아")).rejects.toThrow(/requires the optional peer dependency "layercache"/);
    const arrayBacked = new EasySearch({ data: [{ title: "니아" }], advancedSettings: { useLayerCache: true } });
    await expect(arrayBacked.search("니아")).rejects.toThrow(/npm install layercache/);
  });

  it("still accepts an injected cache", async () => {
    const store = new Map<string, unknown>();
    const cache = {
      async get<V>(key: string, fetcher?: () => Promise<V>) {
        if (!store.has(key) && fetcher) store.set(key, await fetcher());
        return store.get(key) as V | undefined;
      },
      async set(key: string, value: unknown) {
        store.set(key, value);
      },
      async delete(key: string) {
        store.delete(key);
      },
      async invalidateByTag() {},
    };
    const es = new EasySearch({ data: async () => [{ title: "니아" }], advancedSettings: { cache } });
    expect(await es.search("니아")).toHaveLength(1);
    expect(store.size).toBe(2);
  });
});
