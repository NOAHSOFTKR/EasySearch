import type { LayerCacheLike } from "./CacheAdapter.js";

/** Maximum entries held by the default in-memory LayerCache layer. */
export const DEFAULT_MEMORY_MAX_ENTRIES = 1000;

/**
 * Whether `layercache` itself could not be resolved. Loaders and bundlers may
 * wrap the original error, so the `cause` chain is followed. A missing
 * dependency *of* layercache names another package and is not matched.
 */
function isLayerCacheMissing(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (
      (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
      typeof message === "string" &&
      /['"]layercache['"]/.test(message)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Creates the default LayerCache stack (a single `MemoryLayer`) used when
 * `useLayerCache: true` is set without a custom `cache`.
 *
 * `layercache` is an optional peer dependency, so it is loaded lazily and
 * only when caching is actually enabled.
 */
export async function createDefaultLayerCache(): Promise<LayerCacheLike> {
  let layercache: typeof import("layercache");
  try {
    layercache = await import("layercache");
  } catch (error) {
    if (isLayerCacheMissing(error)) {
      throw new Error(
        'EasySearch: "useLayerCache: true" requires the optional peer dependency "layercache". ' +
          'Install it with "npm install layercache", or pass a CacheStack through advancedSettings.cache.',
        { cause: error },
      );
    }
    throw error;
  }
  return new layercache.CacheStack([new layercache.MemoryLayer({ maxSize: DEFAULT_MEMORY_MAX_ENTRIES })]);
}
