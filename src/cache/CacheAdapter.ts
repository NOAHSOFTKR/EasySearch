/**
 * Options EasySearch passes to cache writes. A subset of LayerCache's
 * `CacheGetOptions` / `CacheWriteOptions`.
 */
export interface CacheEntryOptions {
  /** Fresh TTL in milliseconds. */
  ttl?: number;
  /** Tags used by `invalidate()` to drop every entry of an EasySearch instance. */
  tags?: string[];
}

/**
 * The part of LayerCache's `CacheStack` API that EasySearch uses.
 *
 * It is declared structurally so the published type declarations do not
 * depend on `layercache` being installed. A `CacheStack` from `layercache`
 * (or a `CacheNamespace`-like wrapper with the same methods) satisfies it.
 */
export interface LayerCacheLike {
  get<V>(key: string, fetcher?: () => Promise<V>, options?: CacheEntryOptions): Promise<V | undefined>;
  set<V>(key: string, value: V, options?: CacheEntryOptions): Promise<void>;
  delete(key: string): Promise<void>;
  invalidateByTag(tag: string): Promise<void>;
  disconnect?(): Promise<void>;
}

/** LayerCache rejects longer keys (`MAX_CACHE_KEY_LENGTH` in layercache 5.x). */
export const MAX_CACHE_KEY_LENGTH = 1024;

/** Escapes a value so it can be embedded in a cache key without control characters or surrogates. */
export function toKeySegment(value: unknown): string {
  // JSON.stringify escapes U+0000-U+001F and lone surrogates. LayerCache also rejects DEL and
  // every surrogate code unit, including valid pairs (emoji), so escape those by hand.
  return JSON.stringify(value).replace(
    /[\u007f\ud800-\udfff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Small non-cryptographic 53-bit string hash (cyrb53) for configuration and index fingerprints. */
export function hashString(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
