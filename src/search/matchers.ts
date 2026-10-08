import type { MatchType } from "../types/results.js";
import { isWordStart } from "./normalize.js";

/**
 * Score bands per match type. Bands never overlap, so for a single field a
 * stronger match type always outranks a weaker one. Inside a band the score
 * grows with coverage (query length / value length): a shorter value that
 * contains the query is a closer match.
 */
const EXACT_SCORE = 1;
const PREFIX_BASE = 0.8;
const WORD_BASE = 0.6;
const PARTIAL_BASE = 0.4;
const COVERAGE_RANGE = 0.1;
const FUZZY_BASE = 0.1;
const FUZZY_RANGE = 0.2;
/** Fuzzy matches against the beginning of a longer word rank below whole-word fuzzy matches. */
const FUZZY_PREFIX_FACTOR = 0.75;
/** Fuzzy prefix matching needs a query this long (in fuzzy code points) to avoid noise. */
const FUZZY_PREFIX_MIN_LENGTH = 5;

/** Lowest score of a substring match. Every fuzzy score is below it. */
export const SUBSTRING_MIN_SCORE = PARTIAL_BASE;

/**
 * Score of an exact, prefix, word-start or substring match of `query` in one
 * normalized value, or `0` when `value` does not contain `query`.
 * Use {@link matchTypeOf} to get the match type.
 */
export function substringScore(value: string, query: string): number {
  if (value === query) return EXACT_SCORE;
  let index = value.indexOf(query);
  if (index === -1) return 0;
  const coverage = (query.length / value.length) * COVERAGE_RANGE;
  if (index === 0) return PREFIX_BASE + coverage;
  while (index !== -1) {
    if (isWordStart(value, index)) return WORD_BASE + coverage;
    index = value.indexOf(query, index + 1);
  }
  return PARTIAL_BASE + coverage;
}

/** Best {@link substringScore} of `query` across the values of one field. */
export function fieldScore(values: string | readonly string[], query: string): number {
  if (typeof values === "string") return substringScore(values, query);
  let best = 0;
  for (const value of values) {
    const score = substringScore(value, query);
    if (score > best) {
      best = score;
      if (best === EXACT_SCORE) break;
    }
  }
  return best;
}

/** Score of a fuzzy match with the given similarity (0..1]. */
export function fuzzyScore(similarity: number): number {
  return FUZZY_BASE + FUZZY_RANGE * similarity;
}

/** Default edit budget for a query word of `length` fuzzy code points. */
export function defaultMaxEdits(length: number): number {
  if (length <= 2) return 0;
  if (length <= 6) return 1;
  if (length <= 11) return 2;
  return 3;
}

/**
 * Bounded optimal-string-alignment distance (Levenshtein plus adjacent
 * transpositions) between one query word and many candidate words.
 *
 * Buffers are allocated once per query word and reused for every candidate.
 * Only the first `query.length + maxEdits` characters of a candidate are
 * examined, so long words cost the same as short ones.
 */
export class FuzzyMatcher {
  private readonly query: readonly number[];
  private readonly maxEdits: number;
  private readonly allowPrefix: boolean;
  private prev2: Int32Array;
  private prev: Int32Array;
  private curr: Int32Array;

  constructor(query: readonly number[], maxEdits: number) {
    this.query = query;
    // At least one character has to match, otherwise every word would qualify.
    this.maxEdits = Math.max(0, Math.min(maxEdits, query.length - 1));
    this.allowPrefix = query.length >= FUZZY_PREFIX_MIN_LENGTH;
    const width = query.length + this.maxEdits + 1;
    this.prev2 = new Int32Array(width);
    this.prev = new Int32Array(width);
    this.curr = new Int32Array(width);
  }

  get enabled(): boolean {
    return this.maxEdits > 0;
  }

  /**
   * Similarity in (0, 1] when `word` is within the edit budget of the query
   * (as a whole word, or for long queries as a word prefix), otherwise 0.
   */
  similarity(word: readonly number[]): number {
    const q = this.query;
    const m = q.length;
    const k = this.maxEdits;
    const n = word.length;
    if (k === 0 || n < m - k) return 0;
    if (!this.allowPrefix && n > m + k) return 0;

    // Row j holds the distances between word[0..j) and every query prefix q[0..i).
    // A word prefix longer than m + k cannot be within k edits, so rows stop there.
    const rows = Math.min(n, m + k);
    let prev2 = this.prev2;
    let prev = this.prev;
    let curr = this.curr;
    for (let i = 0; i <= m; i++) prev[i] = i;
    let prevRowMin = 0;
    let bestPrefix = Number.POSITIVE_INFINITY;

    for (let j = 1; j <= rows; j++) {
      const wj = word[j - 1] as number;
      curr[0] = j;
      let rowMin = j;
      for (let i = 1; i <= m; i++) {
        const qi = q[i - 1] as number;
        let value = Math.min(
          (prev[i] as number) + 1,
          (curr[i - 1] as number) + 1,
          (prev[i - 1] as number) + (qi === wj ? 0 : 1),
        );
        if (i > 1 && j > 1 && qi === word[j - 2] && q[i - 2] === wj) {
          value = Math.min(value, (prev2[i - 2] as number) + 1);
        }
        curr[i] = value;
        if (value < rowMin) rowMin = value;
      }
      if ((curr[m] as number) < bestPrefix) bestPrefix = curr[m] as number;
      const recycled = prev2;
      prev2 = prev;
      prev = curr;
      curr = recycled;
      // Later cells derive from the last two rows (+1 for transpositions), so all of them exceed k.
      if (rowMin > k && prevRowMin > k) break;
      prevRowMin = rowMin;
    }
    this.prev2 = prev2;
    this.prev = prev;
    this.curr = curr;

    // `prev` is the last computed row. If the loop stopped early its values already exceed k.
    if (n === rows) {
      const full = prev[m] as number;
      if (full <= k) return 1 - full / m;
    }
    if (this.allowPrefix && n > m && bestPrefix <= k) {
      return (1 - bestPrefix / m) * FUZZY_PREFIX_FACTOR;
    }
    return 0;
  }
}

/** Match type of a positive field score. Score bands do not overlap, so the band identifies the type. */
export function matchTypeOf(score: number): MatchType {
  if (score >= EXACT_SCORE) return "exact";
  if (score >= PREFIX_BASE) return "prefix";
  if (score >= WORD_BASE) return "word";
  if (score >= PARTIAL_BASE) return "partial";
  return "fuzzy";
}
