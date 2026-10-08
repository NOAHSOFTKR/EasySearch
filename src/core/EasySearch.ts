import {
  type CacheEntryOptions,
  type LayerCacheLike,
  MAX_CACHE_KEY_LENGTH,
  hashString,
  toKeySegment,
} from "../cache/CacheAdapter.js";
import { createDefaultLayerCache } from "../cache/LayerCacheAdapter.js";
import { type ResolvedProvider, resolveProvider } from "../providers/DataProvider.js";
import { normalizeText } from "../search/normalize.js";
import type { AdvancedSettings, EasySearchOptions, SearchKey, SearchMode, SearchOptions } from "../types/options.js";
import type { SearchResult } from "../types/results.js";
import { type Hit, executeQuery, sortHits } from "./SearchEngine.js";
import { type ResolvedKey, SearchIndex } from "./SearchIndex.js";

const DEFAULT_CACHE_TTL = 60_000;
const MAX_CACHE_NAMESPACE_LENGTH = 200;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MODES: readonly SearchMode[] = ["exact", "partial", "fuzzy"];

/** Data of one load. `version` changes whenever the data is fetched from the source again. */
interface DataPayload<T> {
  version: string;
  items: readonly T[];
}

interface Snapshot<T> {
  version: string;
  index: SearchIndex<T>;
}

interface InFlightLoad<T> {
  /** `invalidate()` count when the load started. Searches only join loads of the current epoch. */
  epoch: number;
  promise: Promise<Snapshot<T>>;
}

/** Cached form of a search: `[item position, score, [key index, match type][]]`. */
type CachedHit = [number, number, Hit["matches"]];

let instanceCounter = 0;

function createVersion(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return random;
}

function parsePath(name: string, label: string): string[] {
  if (name === "") return [];
  const path = name.split(".");
  for (const segment of path) {
    if (segment === "") throw new TypeError(`EasySearch: invalid ${label} "${name}" (empty path segment).`);
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new TypeError(`EasySearch: invalid ${label} "${name}" ("${segment}" is not allowed).`);
    }
  }
  return path;
}

function resolveKeys<T>(keys: readonly SearchKey<T>[] | undefined): ResolvedKey[] | undefined {
  if (keys === undefined) return undefined;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new TypeError("EasySearch: `keys` must be a non-empty array when provided.");
  }
  const seen = new Set<string>();
  return keys.map((key) => {
    const config = typeof key === "string" ? { name: key as string, weight: 1 } : (key as { name: unknown; weight?: unknown });
    if (config === null || typeof config !== "object" || typeof config.name !== "string") {
      throw new TypeError("EasySearch: each key must be a string or an object with a string `name`.");
    }
    const weight = config.weight ?? 1;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
      throw new RangeError(`EasySearch: the weight of key "${config.name}" must be a positive finite number.`);
    }
    if (seen.has(config.name)) throw new TypeError(`EasySearch: duplicate key "${config.name}".`);
    seen.add(config.name);
    return { name: config.name, path: parsePath(config.name, "key"), weight };
  });
}

function isPayload(value: unknown): value is DataPayload<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DataPayload<unknown>).version === "string" &&
    Array.isArray((value as DataPayload<unknown>).items)
  );
}

function isCachedHits(value: unknown, size: number, keyCount: number): value is CachedHit[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (hit) =>
      Array.isArray(hit) &&
      Number.isInteger(hit[0]) &&
      hit[0] >= 0 &&
      hit[0] < size &&
      typeof hit[1] === "number" &&
      Array.isArray(hit[2]) &&
      (hit[2] as unknown[]).every(
        (match) => Array.isArray(match) && Number.isInteger(match[0]) && match[0] >= 0 && match[0] < keyCount,
      ),
  );
}

/**
 * Searches a data source.
 *
 * Data is loaded lazily on the first `search()`, indexed once, and reused
 * until `reload()` / `invalidate()` (or on every search with
 * `reloadOnSearch: true`). Caching is delegated to LayerCache when enabled.
 */
export class EasySearch<T> {
  private readonly provider: ResolvedProvider<T>;
  private readonly configuredKeys: ResolvedKey[] | undefined;
  private readonly idPath: string[] | undefined;
  private readonly settings: AdvancedSettings<T>;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtl: number;
  private readonly cachePrefix: string;
  private readonly cacheTag: string;
  private readonly configFingerprint: string;

  private snapshot: Snapshot<T> | undefined;
  private stale = true;
  private epoch = 0;
  private loadSeq = 0;
  private installedSeq = 0;
  private inFlight: InFlightLoad<T> | undefined;
  private cachePromise: Promise<LayerCacheLike> | undefined;
  private ownsCache = false;
  private disposed = false;

  constructor(options: EasySearchOptions<T>) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("EasySearch: options are required.");
    }
    this.provider = resolveProvider(options.data);
    this.configuredKeys = resolveKeys(options.keys);
    const settings = options.advancedSettings ?? {};
    this.settings = settings;
    this.idPath = settings.idKey === undefined ? undefined : parsePath(settings.idKey, "idKey");

    if (settings.cache !== undefined && (settings.cache === null || typeof settings.cache.get !== "function")) {
      throw new TypeError("EasySearch: advancedSettings.cache must be a LayerCache CacheStack.");
    }
    this.cacheEnabled = settings.useLayerCache ?? settings.cache !== undefined;

    const ttl = settings.cacheTtl ?? DEFAULT_CACHE_TTL;
    if (typeof ttl !== "number" || !Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError("EasySearch: advancedSettings.cacheTtl must be a positive number of milliseconds.");
    }
    this.cacheTtl = ttl;

    const namespace = settings.cacheKey ?? `instance-${++instanceCounter}-${createVersion()}`;
    if (
      typeof namespace !== "string" ||
      namespace.length === 0 ||
      namespace.length > MAX_CACHE_NAMESPACE_LENGTH ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      /[\u0000-\u001f\u007f\ud800-\udfff]/.test(namespace)
    ) {
      throw new TypeError(
        `EasySearch: advancedSettings.cacheKey must be a non-empty string of at most ${MAX_CACHE_NAMESPACE_LENGTH} characters without control characters.`,
      );
    }
    this.cachePrefix = `easysearch:${namespace}`;
    this.cacheTag = this.cachePrefix;
    this.configFingerprint = hashString(
      JSON.stringify([
        this.configuredKeys?.map((key) => [key.name, key.weight]) ?? null,
        settings.idKey ?? null,
        settings.ignoreDiacritics === true,
      ]),
    );
  }

  /**
   * Searches the current data. Loads it first if needed (first search,
   * after `invalidate()`, or always with `reloadOnSearch: true`).
   *
   * A query that is empty after normalization returns `[]` without loading.
   */
  async search(query: string, options: SearchOptions<T> = {}): Promise<SearchResult<T>[]> {
    this.assertUsable();
    if (typeof query !== "string") throw new TypeError("EasySearch: the query must be a string.");
    const mode = options.mode ?? "partial";
    if (!MODES.includes(mode)) throw new RangeError(`EasySearch: unknown search mode "${String(mode)}".`);
    const { limit, maxEdits, sort = "relevance", filter } = options;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("EasySearch: `limit` must be a non-negative integer.");
    }
    if (maxEdits !== undefined && (!Number.isInteger(maxEdits) || maxEdits < 0)) {
      throw new RangeError("EasySearch: `maxEdits` must be a non-negative integer.");
    }
    if (sort !== "relevance" && sort !== "original" && typeof sort !== "function") {
      throw new RangeError(`EasySearch: unknown sort "${String(sort)}".`);
    }
    if (filter !== undefined && typeof filter !== "function") {
      throw new TypeError("EasySearch: `filter` must be a function.");
    }

    const text = normalizeText(query, { ignoreDiacritics: this.settings.ignoreDiacritics === true });
    if (text === "" || limit === 0) return [];

    const snapshot = await this.acquireSnapshot();
    const index = snapshot.index;
    const activeKeys = this.resolveActiveKeys(index, options.keys);
    if (activeKeys.length === 0) return [];
    const engineQuery = { text, mode, activeKeys, maxEdits };

    if (filter === undefined && typeof sort !== "function") {
      const compute = (): Hit[] => {
        const hits = sortHits(executeQuery(index, engineQuery), sort);
        return limit === undefined ? hits : hits.slice(0, limit);
      };
      const hits = await this.cachedHits(snapshot, engineQuery, sort, limit, compute);
      return hits.map((hit) => this.toResult(index, hit));
    }

    let hits = executeQuery(index, engineQuery);
    if (filter) hits = hits.filter((hit) => filter(index.items[hit.doc] as T));
    if (typeof sort === "function") {
      const results = hits.map((hit) => this.toResult(index, hit));
      results.sort((a, b) => sort(a, b) || a.refIndex - b.refIndex);
      return limit === undefined ? results : results.slice(0, limit);
    }
    sortHits(hits, sort);
    return (limit === undefined ? hits : hits.slice(0, limit)).map((hit) => this.toResult(index, hit));
  }

  /**
   * Loads the data from the data source again (bypassing the cache, then
   * writing the fresh data to it) and rebuilds the index.
   *
   * On failure the promise rejects and the previous data stays in place.
   */
  async reload(): Promise<void> {
    this.assertUsable();
    await this.startLoad(true).promise;
  }

  /**
   * Marks the loaded data as invalid and deletes this instance's cache
   * entries. The next search loads the data again.
   */
  async invalidate(): Promise<void> {
    this.assertUsable();
    this.epoch++;
    this.stale = true;
    if (!this.cacheEnabled) return;
    const cache = await this.getCache();
    await Promise.all([cache.delete(this.dataKey()), cache.invalidateByTag(this.cacheTag)]);
  }

  /**
   * Releases resources. Disconnects the cache only if EasySearch created it
   * (an injected `cache` is left untouched). The instance cannot be used afterwards.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.snapshot = undefined;
    const cachePromise = this.cachePromise;
    this.cachePromise = undefined;
    if (this.ownsCache && cachePromise) {
      const cache = await cachePromise.catch(() => undefined);
      await cache?.disconnect?.();
    }
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("EasySearch: this instance has been disposed.");
  }

  private resolveActiveKeys(index: SearchIndex<T>, keys: readonly string[] | undefined): number[] {
    if (keys === undefined) return index.keys.map((_, i) => i);
    if (!Array.isArray(keys)) throw new TypeError("EasySearch: `keys` must be an array.");
    const active = new Set<number>();
    for (const name of keys) {
      const position = index.keys.findIndex((key) => key.name === name);
      if (position === -1) throw new RangeError(`EasySearch: "${String(name)}" is not a configured key.`);
      active.add(position);
    }
    return [...active].sort((a, b) => a - b);
  }

  private toResult(index: SearchIndex<T>, hit: Hit): SearchResult<T> {
    return {
      item: index.items[hit.doc] as T,
      refIndex: index.refIndexes[hit.doc] as number,
      score: hit.score,
      matches: hit.matches.map(([key, type]) => ({ key: (index.keys[key] as ResolvedKey).name, type })),
    };
  }

  // ---------------------------------------------------------------- loading

  private async acquireSnapshot(): Promise<Snapshot<T>> {
    if (!this.settings.reloadOnSearch && this.snapshot && !this.stale) return this.snapshot;
    const inFlight = this.inFlight;
    const load = inFlight && inFlight.epoch === this.epoch ? inFlight : this.startLoad(false);
    try {
      return await load.promise;
    } catch (error) {
      if (this.settings.fallbackToStaleOnError && this.snapshot) {
        this.report(error);
        return this.snapshot;
      }
      throw error;
    }
  }

  /**
   * Starts a load. Loads may overlap (`reload()` during a search-triggered
   * load); the most recently started one wins, older results are dropped.
   */
  private startLoad(force: boolean): InFlightLoad<T> {
    const seq = ++this.loadSeq;
    const epoch = this.epoch;
    const promise = this.loadPayload(force).then((payload) => this.install(seq, epoch, payload));
    const load: InFlightLoad<T> = { epoch, promise };
    this.inFlight = load;
    promise.then(
      () => this.clearInFlight(load),
      () => this.clearInFlight(load),
    );
    return load;
  }

  private clearInFlight(load: InFlightLoad<T>): void {
    if (this.inFlight === load) this.inFlight = undefined;
  }

  private install(seq: number, epoch: number, payload: DataPayload<T>): Snapshot<T> {
    if (this.disposed) throw new Error("EasySearch: this instance has been disposed.");
    if (seq < this.installedSeq && this.snapshot) return this.snapshot;
    let snapshot = this.snapshot;
    if (!snapshot || snapshot.version !== payload.version) {
      const index = new SearchIndex(payload.items, {
        keys: this.configuredKeys,
        idPath: this.idPath,
        ignoreDiacritics: this.settings.ignoreDiacritics === true,
      });
      snapshot = { version: payload.version, index };
    }
    this.snapshot = snapshot;
    this.installedSeq = seq;
    // Invalidated while loading: keep serving this load's caller, but load again next time.
    this.stale = epoch !== this.epoch;
    return snapshot;
  }

  private async loadPayload(force: boolean): Promise<DataPayload<T>> {
    const fromSource = async (): Promise<DataPayload<T>> => ({
      version: createVersion(),
      items: await this.provider.load(),
    });
    // An in-memory array gains nothing from being cached; only search results are.
    if (!this.cacheEnabled || this.provider.isStatic) return fromSource();

    const cache = await this.getCache();
    const key = this.dataKey();
    const entryOptions = this.entryOptions();

    if (force) {
      const payload = await fromSource();
      try {
        await cache.set(key, payload, entryOptions);
      } catch (error) {
        this.report(error);
      }
      return payload;
    }

    let sourceFailed = false;
    try {
      const payload = await cache.get(
        key,
        async () => {
          try {
            return await fromSource();
          } catch (error) {
            sourceFailed = true;
            throw error;
          }
        },
        entryOptions,
      );
      if (isPayload(payload)) return payload as DataPayload<T>;
      this.report(new Error(`EasySearch: ignoring malformed cache entry "${key}".`));
    } catch (error) {
      if (sourceFailed) throw error;
      // The cache failed, not the data source: search without it.
      this.report(error);
    }
    return fromSource();
  }

  // ------------------------------------------------------------------ cache

  private getCache(): Promise<LayerCacheLike> {
    if (!this.cachePromise) {
      const injected = this.settings.cache;
      if (injected) {
        this.cachePromise = Promise.resolve(injected);
      } else {
        this.ownsCache = true;
        const created = createDefaultLayerCache();
        this.cachePromise = created;
        // Retry on the next call (e.g. after installing layercache) instead of caching the failure.
        created.catch(() => {
          if (this.cachePromise === created) this.cachePromise = undefined;
        });
      }
    }
    return this.cachePromise;
  }

  private dataKey(): string {
    return `${this.cachePrefix}:data`;
  }

  private entryOptions(): CacheEntryOptions {
    return { ttl: this.cacheTtl, tags: [this.cacheTag] };
  }

  /**
   * Returns hits through the result cache when it can be used. Result keys
   * include the data version, so new data never reads results of old data.
   */
  private async cachedHits(
    snapshot: Snapshot<T>,
    query: { text: string; mode: SearchMode; activeKeys: readonly number[]; maxEdits: number | undefined },
    sort: "relevance" | "original",
    limit: number | undefined,
    compute: () => Hit[],
  ): Promise<Hit[]> {
    // Without a cached data load, `reloadOnSearch` creates a new version per search: results would never be reused.
    const versionIsStable = !this.settings.reloadOnSearch || !this.provider.isStatic;
    if (!this.cacheEnabled || !versionIsStable) return compute();

    const signature = toKeySegment([query.mode, query.activeKeys, query.maxEdits ?? null, sort, limit ?? null, query.text]);
    const key = `${this.cachePrefix}:result:${this.configFingerprint}:${snapshot.version}:${signature}`;
    if (key.length > MAX_CACHE_KEY_LENGTH) return compute();

    const index = snapshot.index;
    // A missing `layercache` package is a configuration error and is not swallowed.
    const cache = await this.getCache();
    try {
      const cached = await cache.get<CachedHit[]>(
        key,
        async () => compute().map((hit): CachedHit => [hit.doc, hit.score, hit.matches]),
        this.entryOptions(),
      );
      if (isCachedHits(cached, index.size, index.keyCount)) {
        return cached.map(([doc, score, matches]) => ({ doc, score, matches }));
      }
      this.report(new Error(`EasySearch: ignoring malformed cache entry "${key}".`));
    } catch (error) {
      this.report(error);
    }
    return compute();
  }

  private report(error: unknown): void {
    try {
      this.settings.onError?.(error);
    } catch {
      // A failing error hook must not break searches.
    }
  }
}
