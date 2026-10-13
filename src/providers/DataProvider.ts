/** A function returning the items to search, synchronously or as a Promise. */
export type DataLoader<T> = () => readonly T[] | Promise<readonly T[]>;

/**
 * Object form of a data source. Implement it to wrap a database, an HTTP API,
 * or anything else; EasySearch only calls `load()`.
 */
export interface DataProvider<T> {
  load(): readonly T[] | Promise<readonly T[]>;
}

export type DataSource<T> = readonly T[] | DataLoader<T> | DataProvider<T>;

/** Thrown when the data source fails or returns something other than an array. */
export class DataLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DataLoadError";
  }
}

export interface ResolvedProvider<T> {
  /** `true` for an in-memory array: there is nothing to gain from caching the load itself. */
  readonly isStatic: boolean;
  load(): Promise<readonly T[]>;
}

async function loadWith<T>(load: () => readonly T[] | Promise<readonly T[]>): Promise<readonly T[]> {
  let items: unknown;
  try {
    items = await load();
  } catch (error) {
    throw new DataLoadError("EasySearch: the data source failed to load.", { cause: error });
  }
  if (!Array.isArray(items)) {
    throw new DataLoadError(`EasySearch: the data source must return an array, got ${describe(items)}.`);
  }
  return items as readonly T[];
}

function describe(value: unknown): string {
  return value === null ? "null" : typeof value;
}

export function resolveProvider<T>(source: DataSource<T>): ResolvedProvider<T> {
  if (Array.isArray(source)) {
    const items = source as readonly T[];
    return { isStatic: true, load: () => Promise.resolve(items) };
  }
  if (typeof source === "function") {
    const fn = source as DataLoader<T>;
    return { isStatic: false, load: () => loadWith(fn) };
  }
  if (source !== null && typeof source === "object" && typeof (source as DataProvider<T>).load === "function") {
    const provider = source as DataProvider<T>;
    return { isStatic: false, load: () => loadWith(() => provider.load()) };
  }
  throw new TypeError("EasySearch: `data` must be an array, a function, or an object with a load() method.");
}
