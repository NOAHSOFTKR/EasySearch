/**
 * How a field matched, from strongest to weakest:
 * - `exact`: the whole value equals the query
 * - `prefix`: the value starts with the query
 * - `word`: a word inside the value starts with the query
 * - `partial`: the query appears inside the value
 * - `fuzzy`: a word is within the allowed edit distance of the query
 */
export type MatchType = "exact" | "prefix" | "word" | "partial" | "fuzzy";

export interface SearchMatch {
  /** The configured key (dot-notation path) that matched. */
  key: string;
  type: MatchType;
}

export interface SearchResult<T> {
  /** The original item, as returned by the data source. */
  item: T;
  /** Position of `item` in the loaded data array. */
  refIndex: number;
  /** Relevance score. Higher is better; only comparable within one search. */
  score: number;
  /** Matching fields in configuration order. */
  matches: SearchMatch[];
}
