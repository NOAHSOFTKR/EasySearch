import {
  FuzzyMatcher,
  SUBSTRING_MIN_SCORE,
  defaultMaxEdits,
  fieldScore,
  fuzzyScore,
  matchTypeOf,
} from "../search/matchers.js";
import { toFuzzyCodes, tokenize } from "../search/normalize.js";
import type { SearchMode } from "../types/options.js";
import type { MatchType } from "../types/results.js";
import type { ResolvedKey, SearchIndex } from "./SearchIndex.js";

/** A matched item before it is joined with the original data. */
export interface Hit {
  /** Position in `SearchIndex.items`. */
  doc: number;
  score: number;
}

/** `[key index, match type]` per matching key, in key order. */
export type HitMatches = [number, MatchType][];

export interface QueryResult {
  /** Every matching item, unsorted. */
  hits: Hit[];
  /** Matching keys of one hit. Computed on demand, so only returned hits pay for it. */
  matches(doc: number): HitMatches;
}

export interface EngineQuery {
  /** Normalized, non-empty query text. */
  text: string;
  mode: SearchMode;
  /** Indices of the keys to search, ascending. */
  activeKeys: readonly number[];
  maxEdits: number | undefined;
}

/** Share of the other matching fields' scores added to the best field's score. */
const MULTI_FIELD_BONUS = 0.1;
/** Multi-word queries matched word by word rank below the same words matched as a phrase. */
const WORD_BY_WORD_FACTOR = 0.9;
/** Above `items / DENSE_THRESHOLD` expected entries, typed arrays are cheaper than a hash map. */
const DENSE_THRESHOLD = 16;

/** Scores are rounded so floating-point noise never decides an order (ties fall back to data order). */
function round(score: number): number {
  return Math.round(score * 1e6) / 1e6;
}

/**
 * Best field score per (item, key), `0` meaning no match. Small result sets
 * use a map of per-item rows; large ones (e.g. one-letter queries) a flat
 * typed array, which avoids a hash lookup and an allocation per item.
 */
class FieldScores {
  /** Items with at least one score, in first-touch order. */
  readonly docs: number[] = [];
  private readonly dense: Float64Array | undefined;
  private readonly seen: Uint8Array | undefined;
  private readonly sparse: Map<number, Float64Array> | undefined;

  constructor(
    private readonly keyCount: number,
    itemCount: number,
    expectedEntries: number,
  ) {
    if (expectedEntries * DENSE_THRESHOLD >= itemCount) {
      this.dense = new Float64Array(itemCount * keyCount);
      this.seen = new Uint8Array(itemCount);
    } else {
      this.sparse = new Map();
    }
  }

  /** Raises the score of (doc, key) to `score` if it is higher. */
  raise(doc: number, key: number, score: number): void {
    if (this.dense) {
      const seen = this.seen as Uint8Array;
      if (seen[doc] === 0) {
        seen[doc] = 1;
        this.docs.push(doc);
      }
      const at = doc * this.keyCount + key;
      if (score > (this.dense[at] as number)) this.dense[at] = score;
      return;
    }
    const sparse = this.sparse as Map<number, Float64Array>;
    let row = sparse.get(doc);
    if (!row) {
      row = new Float64Array(this.keyCount);
      sparse.set(doc, row);
      this.docs.push(doc);
    }
    if (score > (row[key] as number)) row[key] = score;
  }

  get(doc: number, key: number): number {
    if (this.dense) return this.dense[doc * this.keyCount + key] as number;
    return (this.sparse as Map<number, Float64Array>).get(doc)?.[key] ?? 0;
  }

  has(doc: number): boolean {
    return this.dense ? this.seen?.[doc] === 1 : (this.sparse as Map<number, Float64Array>).has(doc);
  }
}

class Scorer {
  private readonly weights: Float64Array;
  private readonly maxWeight: number;

  constructor(
    index: SearchIndex<unknown>,
    private readonly activeKeys: readonly number[],
  ) {
    this.weights = new Float64Array(index.keyCount);
    let maxWeight = 0;
    for (const k of activeKeys) {
      const weight = (index.keys[k] as ResolvedKey).weight;
      this.weights[k] = weight;
      if (weight > maxWeight) maxWeight = weight;
    }
    this.maxWeight = maxWeight;
  }

  /** Best weighted field score plus a bonus for the other matching fields, scaled by the largest weight. */
  combine(scores: FieldScores, doc: number): number {
    let best = 0;
    let sum = 0;
    for (const k of this.activeKeys) {
      const weighted = scores.get(doc, k) * (this.weights[k] as number);
      sum += weighted;
      if (weighted > best) best = weighted;
    }
    return (best + MULTI_FIELD_BONUS * (sum - best)) / this.maxWeight;
  }

  /** Hits for every item in `scores`, with match types read from the same scores. */
  result(scores: FieldScores): QueryResult {
    const hits: Hit[] = scores.docs.map((doc) => ({ doc, score: round(this.combine(scores, doc)) }));
    return { hits, matches: (doc) => this.matches((k) => scores.get(doc, k)) };
  }

  matches(scoreOf: (key: number) => number): HitMatches {
    const matches: HitMatches = [];
    for (const k of this.activeKeys) {
      const score = scoreOf(k);
      if (score > 0) matches.push([k, matchTypeOf(score)]);
    }
    return matches;
  }
}

/**
 * Field scores for one query word: substring matches found through the
 * vocabulary, plus fuzzy matches in `fuzzy` mode.
 */
function matchWord(index: SearchIndex<unknown>, word: string, query: EngineQuery, active: Uint8Array): FieldScores {
  const keyCount = index.keyCount;
  let fuzzy: FuzzyMatcher | undefined;
  if (query.mode === "fuzzy") {
    const codes = toFuzzyCodes(word);
    const matcher = new FuzzyMatcher(codes, query.maxEdits ?? defaultMaxEdits(codes.length));
    if (matcher.enabled) fuzzy = matcher;
  }

  // Pass 1: matching words of the vocabulary. A similarity of 0 marks a substring match.
  const { terms, termCodes, postings } = index;
  const matchedTerms: number[] = [];
  const similarities: number[] = [];
  let expectedEntries = 0;
  for (let t = 0; t < terms.length; t++) {
    let similarity = 0;
    if (!(terms[t] as string).includes(word)) {
      if (!fuzzy) continue;
      similarity = fuzzy.similarity(termCodes[t] as number[]);
      if (similarity === 0) continue;
    }
    matchedTerms.push(t);
    similarities.push(similarity);
    expectedEntries += (postings[t] as number[]).length;
  }

  // Pass 2: score the (item, key) pairs those words occur in.
  const scores = new FieldScores(keyCount, index.size, expectedEntries);
  for (let m = 0; m < matchedTerms.length; m++) {
    const similarity = similarities[m] as number;
    for (const pair of postings[matchedTerms[m] as number] as number[]) {
      const key = pair % keyCount;
      if (active[key] === 0) continue;
      const doc = (pair - key) / keyCount;
      if (similarity > 0) {
        scores.raise(doc, key, fuzzyScore(similarity));
      } else if (scores.get(doc, key) < SUBSTRING_MIN_SCORE) {
        // Substring scores depend only on the field values: compute them once per pair.
        const values = index.fieldValues(doc, key);
        if (values !== undefined) scores.raise(doc, key, fieldScore(values, word));
      }
    }
  }
  return scores;
}

/** Substring match of the whole query against every value of the given items. */
function scanPhrase(index: SearchIndex<unknown>, query: EngineQuery, docs: readonly number[] | undefined): FieldScores {
  const count = docs ? docs.length : index.size;
  const scores = new FieldScores(index.keyCount, index.size, count);
  for (let i = 0; i < count; i++) {
    const doc = docs ? (docs[i] as number) : i;
    for (const key of query.activeKeys) {
      const values = index.fieldValues(doc, key);
      if (values === undefined) continue;
      const score = fieldScore(values, query.text);
      if (score > 0) scores.raise(doc, key, score);
    }
  }
  return scores;
}

/**
 * Finds every item matching `query`.
 *
 * - `exact`: whole-value lookups in the exact-value maps.
 * - one-word query: vocabulary scan for the word.
 * - query without words (e.g. "++"): substring scan of every value.
 * - multi-word query: every word must match (in any searched field). The
 *   score is the better of the phrase match and the averaged word matches.
 */
export function executeQuery(index: SearchIndex<unknown>, query: EngineQuery): QueryResult {
  const scorer = new Scorer(index, query.activeKeys);
  const keyCount = index.keyCount;

  if (query.mode === "exact") {
    const lists = query.activeKeys.map((key) => index.exactMatches(key, query.text));
    const scores = new FieldScores(keyCount, index.size, lists.reduce((sum, list) => sum + list.length, 0));
    query.activeKeys.forEach((key, i) => {
      for (const doc of lists[i] as readonly number[]) scores.raise(doc, key, 1);
    });
    return scorer.result(scores);
  }

  const words = [...new Set(tokenize(query.text))];
  if (words.length === 0) return scorer.result(scanPhrase(index, query, undefined));

  const active = new Uint8Array(keyCount);
  for (const key of query.activeKeys) active[key] = 1;

  if (words.length === 1 && words[0] === query.text) {
    return scorer.result(matchWord(index, query.text, query, active));
  }

  const perWord = words.map((word) => matchWord(index, word, query, active));
  // Iterate the smallest candidate set and require every other word to match too.
  perWord.sort((a, b) => a.docs.length - b.docs.length);
  const [smallest, ...others] = perWord as [FieldScores, ...FieldScores[]];
  const candidates = smallest.docs.filter((doc) => others.every((scores) => scores.has(doc)));
  const phrase = scanPhrase(index, query, candidates);

  const hits: Hit[] = candidates.map((doc) => {
    let wordTotal = 0;
    for (const scores of perWord) wordTotal += scorer.combine(scores, doc);
    const wordScore = (WORD_BY_WORD_FACTOR * wordTotal) / perWord.length;
    const phraseScore = phrase.has(doc) ? scorer.combine(phrase, doc) : 0;
    return { doc, score: round(Math.max(phraseScore, wordScore)) };
  });
  // Per key: the phrase match if there is one, otherwise the best word match.
  const matches = (doc: number): HitMatches =>
    scorer.matches((key) => {
      const phraseScore = phrase.get(doc, key);
      if (phraseScore > 0) return phraseScore;
      let best = 0;
      for (const scores of perWord) best = Math.max(best, scores.get(doc, key));
      return best;
    });
  return { hits, matches };
}

type HitOrder = (a: Hit, b: Hit) => number;

const byRelevance: HitOrder = (a, b) => b.score - a.score || a.doc - b.doc;
const byDataOrder: HitOrder = (a, b) => a.doc - b.doc;

/**
 * Orders hits by score (ties in data order) or by data order, keeping at
 * most `limit`. A small limit uses a bounded heap (O(n log limit)) instead
 * of sorting every hit.
 */
export function rankHits(hits: Hit[], order: "relevance" | "original", limit: number | undefined): Hit[] {
  const compare = order === "original" ? byDataOrder : byRelevance;
  if (limit === undefined || limit * 4 >= hits.length) {
    hits.sort(compare);
    return limit === undefined ? hits : hits.slice(0, limit);
  }
  return selectTop(hits, limit, compare);
}

/** The `limit` best hits in order, using a heap whose root is the worst hit kept so far. */
function selectTop(hits: readonly Hit[], limit: number, compare: HitOrder): Hit[] {
  const heap: Hit[] = [];
  if (limit === 0) return heap;
  // `compare(a, b) > 0` means `a` ranks after `b`; the root is the hit that ranks last.
  const siftUp = (index: number): void => {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (compare(heap[i] as Hit, heap[parent] as Hit) <= 0) break;
      [heap[i], heap[parent]] = [heap[parent] as Hit, heap[i] as Hit];
      i = parent;
    }
  };
  const siftDown = (): void => {
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let worst = i;
      if (left < heap.length && compare(heap[left] as Hit, heap[worst] as Hit) > 0) worst = left;
      if (right < heap.length && compare(heap[right] as Hit, heap[worst] as Hit) > 0) worst = right;
      if (worst === i) return;
      [heap[i], heap[worst]] = [heap[worst] as Hit, heap[i] as Hit];
      i = worst;
    }
  };
  for (const hit of hits) {
    if (heap.length < limit) {
      heap.push(hit);
      siftUp(heap.length - 1);
    } else if (compare(hit, heap[0] as Hit) < 0) {
      heap[0] = hit;
      siftDown();
    }
  }
  return heap.sort(compare);
}
