import { type NormalizeOptions, normalizeText, toFuzzyCodes, tokenize } from "../search/normalize.js";

export interface ResolvedKey {
  /** Configured name (dot-notation path), or `""` when items are searched directly. */
  readonly name: string;
  readonly path: readonly string[];
  readonly weight: number;
}

type RawValue = string | number | bigint;

/** Field values of one item for one key: none, one, or several (array fields). */
type FieldValues = string | string[] | undefined;

export interface SearchIndexOptions extends NormalizeOptions {
  /** Configured keys, or `undefined` to discover them from the data. */
  keys: readonly ResolvedKey[] | undefined;
  idPath: readonly string[] | undefined;
}

/** Collects the searchable primitive values at `path`, flattening arrays at any depth. */
export function collectValues(value: unknown, path: readonly string[], depth: number, out: RawValue[]): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const element of value) collectValues(element, path, depth, out);
    return;
  }
  if (depth === path.length) {
    if (typeof value === "string" || typeof value === "bigint") out.push(value);
    else if (typeof value === "number" && Number.isFinite(value)) out.push(value);
    return;
  }
  if (typeof value !== "object") return;
  collectValues((value as Record<string, unknown>)[path[depth] as string], path, depth + 1, out);
}

function isSearchable(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "bigint") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(isSearchable);
  return false;
}

/** Keys used when none are configured: the item itself, or top-level searchable properties. */
function discoverKeys(items: readonly unknown[]): ResolvedKey[] {
  const names = new Set<string>();
  let primitive = false;
  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (typeof item !== "object" || Array.isArray(item)) {
      primitive = true;
      continue;
    }
    for (const [name, value] of Object.entries(item)) {
      if (!names.has(name) && isSearchable(value)) names.add(name);
    }
  }
  const keys: ResolvedKey[] = [];
  if (primitive) keys.push({ name: "", path: [], weight: 1 });
  for (const name of names) keys.push({ name, path: [name], weight: 1 });
  return keys;
}

/**
 * Immutable search structure built from one data load.
 *
 * - `values`: normalized field values, flat `[item * keyCount + key]`, so a
 *   search never re-reads or re-normalizes the original objects.
 * - vocabulary (`terms`, `termCodes`, `postings`): every distinct word with
 *   the (item, key) pairs it appears in. Single-word queries scan the
 *   vocabulary instead of every value, and fuzzy matching runs once per
 *   distinct word instead of once per occurrence.
 * - exact-value maps: built on first use of `mode: "exact"`.
 */
export class SearchIndex<T> {
  readonly items: readonly T[];
  /** Position of each indexed item in the loaded array. */
  readonly refIndexes: readonly number[];
  readonly keys: readonly ResolvedKey[];
  readonly keyCount: number;
  private readonly values: FieldValues[];
  readonly terms: readonly string[];
  readonly termCodes: readonly (readonly number[])[];
  /** Pair ids (`item * keyCount + key`) per term, ascending and unique. */
  readonly postings: readonly (readonly number[])[];
  private exactMaps: Map<string, number[]>[] | undefined;

  constructor(data: readonly T[], options: SearchIndexOptions) {
    const keys = options.keys ?? discoverKeys(data);
    const keyCount = keys.length;
    const items: T[] = [];
    const refIndexes: number[] = [];
    const values: FieldValues[] = [];
    const termIds = new Map<string, number>();
    const terms: string[] = [];
    const postings: number[][] = [];
    const seenIds = options.idPath ? new Set<string>() : undefined;
    const raw: RawValue[] = [];

    for (let ref = 0; ref < data.length; ref++) {
      const item = data[ref] as T;
      if (seenIds && options.idPath) {
        raw.length = 0;
        collectValues(item, options.idPath, 0, raw);
        if (raw.length > 0) {
          const id = `${typeof raw[0]}:${String(raw[0])}`;
          if (seenIds.has(id)) continue;
          seenIds.add(id);
        }
      }
      const doc = items.length;
      items.push(item);
      refIndexes.push(ref);

      for (let k = 0; k < keyCount; k++) {
        raw.length = 0;
        collectValues(item, (keys[k] as ResolvedKey).path, 0, raw);
        let field: FieldValues;
        for (const value of raw) {
          const text = normalizeText(String(value), options);
          if (text === "") continue;
          if (field === undefined) field = text;
          else if (typeof field === "string") field = [field, text];
          else field.push(text);
        }
        values.push(field);
        if (field === undefined) continue;

        const pair = doc * keyCount + k;
        for (const text of typeof field === "string" ? [field] : field) {
          for (const term of tokenize(text)) {
            let id = termIds.get(term);
            if (id === undefined) {
              id = terms.length;
              termIds.set(term, id);
              terms.push(term);
              postings.push([]);
            }
            const list = postings[id] as number[];
            if (list[list.length - 1] !== pair) list.push(pair);
          }
        }
      }
    }

    this.items = items;
    this.refIndexes = refIndexes;
    this.keys = keys;
    this.keyCount = keyCount;
    this.values = values;
    this.terms = terms;
    this.termCodes = terms.map(toFuzzyCodes);
    this.postings = postings;
  }

  get size(): number {
    return this.items.length;
  }

  /** Normalized values of one item for one key. */
  fieldValues(doc: number, key: number): FieldValues {
    return this.values[doc * this.keyCount + key];
  }

  /** Items whose value for `key` equals the normalized `text`, in data order. */
  exactMatches(key: number, text: string): readonly number[] {
    if (!this.exactMaps) this.exactMaps = this.buildExactMaps();
    return this.exactMaps[key]?.get(text) ?? [];
  }

  private buildExactMaps(): Map<string, number[]>[] {
    const maps = this.keys.map(() => new Map<string, number[]>());
    for (let doc = 0; doc < this.items.length; doc++) {
      for (let k = 0; k < this.keyCount; k++) {
        const field = this.fieldValues(doc, k);
        if (field === undefined) continue;
        const map = maps[k] as Map<string, number[]>;
        for (const text of typeof field === "string" ? [field] : field) {
          const list = map.get(text);
          if (!list) map.set(text, [doc]);
          else if (list[list.length - 1] !== doc) list.push(doc);
        }
      }
    }
    return maps;
  }
}
