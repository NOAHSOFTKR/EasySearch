import type { LayerCacheLike } from "../cache/CacheAdapter.js";
import type { DataSource } from "../providers/DataProvider.js";
import type { KeyPath } from "./paths.js";
import type { SearchResult } from "./results.js";

/** A searchable field with an optional relevance weight (default `1`). */
export interface SearchKeyConfig<T> {
  name: KeyPath<T>;
  /** Positive, finite multiplier applied to this field's match score. Defaults to `1`. */
  weight?: number;
}

/** A field to search: a dot-notation path or a `{ name, weight }` object. */
export type SearchKey<T> = KeyPath<T> | SearchKeyConfig<T>;

/**
 * - `exact`: the whole field value equals the query.
 * - `partial`: exact, prefix, word-start and substring matches.
 * - `fuzzy`: everything `partial` finds, plus typo-tolerant word matches.
 */
export type SearchMode = "exact" | "partial" | "fuzzy";

export type SortOrder<T> =
  | "relevance"
  | "original"
  | ((a: SearchResult<T>, b: SearchResult<T>) => number);

export interface SearchOptions<T> {
  /** Defaults to `"partial"`. */
  mode?: SearchMode;
  /** Maximum number of results. Non-negative integer; no limit by default. */
  limit?: number;
  /**
   * - `"relevance"` (default): highest score first, ties keep data order.
   * - `"original"`: data order.
   * - a comparator: custom order, ties keep data order.
   */
  sort?: SortOrder<T>;
  /** Restricts the search to a subset of the configured `keys`. */
  keys?: readonly KeyPath<T>[];
  /** Drops results for which the predicate returns `false`. Applied before `limit`. */
  filter?: (item: T) => boolean;
  /**
   * Maximum edit distance for fuzzy word matches. Defaults to a length-based
   * value (0 for 1-2 characters, 1 for 3-6, 2 for 7-11, 3 above). Hangul is
   * compared per jamo, so "니아" counts as 4 characters.
   */
  maxEdits?: number;
}

export interface AdvancedSettings<T> {
  /**
   * Cache data loads and search results through LayerCache.
   * Defaults to `true` when `cache` is given, otherwise `false`.
   * Without `cache`, a memory-only `CacheStack` is created lazily
   * (requires the optional peer dependency `layercache`).
   */
  useLayerCache?: boolean;
  /** A LayerCache `CacheStack` you created (memory, Redis, disk, ...). EasySearch never disconnects it. */
  cache?: LayerCacheLike;
  /**
   * Cache key namespace. Instances that share a namespace (and a cache backend)
   * share cached data, so only reuse a namespace for the same data source.
   * Defaults to a value unique to this instance.
   */
  cacheKey?: string;
  /** TTL in milliseconds for cache entries written by EasySearch. Defaults to `60_000`. */
  cacheTtl?: number;
  /**
   * - `false` (default): data is loaded on the first search and reused until
   *   `reload()` or `invalidate()`.
   * - `true`: every search loads data first (through the cache when enabled,
   *   so a fresh cached copy avoids calling the data source).
   */
  reloadOnSearch?: boolean;
  /**
   * When a load triggered by `search()` fails and data was loaded before,
   * search the previous data instead of throwing. The error is passed to
   * `onError`. Defaults to `false`. `reload()` always rejects on failure.
   */
  fallbackToStaleOnError?: boolean;
  /** Receives errors that EasySearch recovered from (cache failures, stale fallbacks). */
  onError?: (error: unknown) => void;
  /**
   * Field identifying an item. When set, items with an identifier seen
   * earlier in the same load are ignored (first occurrence wins).
   */
  idKey?: KeyPath<T>;
  /** Ignore diacritics, so "cafe" matches "café". Defaults to `false`. */
  ignoreDiacritics?: boolean;
}

export interface EasySearchOptions<T> {
  /** An array, a (sync or async) function returning an array, or a `DataProvider`. */
  data: DataSource<T>;
  /**
   * Fields to search. Defaults to the item itself for primitive items, or to
   * every top-level string/number property for objects.
   */
  keys?: readonly SearchKey<T>[];
  advancedSettings?: AdvancedSettings<T>;
}
