import { FuzzyMatcher, defaultMaxEdits, fuzzyScore, matchField, matchTypeOf } from "../search/matchers.js";
import { toFuzzyCodes, tokenize } from "../search/normalize.js";
import type { SearchMode } from "../types/options.js";
import type { MatchType } from "../types/results.js";
import type { SearchIndex } from "./SearchIndex.js";

/** A matched item before it is joined with the original data. */
export interface Hit {
  /** Position in `SearchIndex.items`. */
  doc: number;
  score: number;
  /** `[key index, match type]`, in key order. */
  matches: [number, MatchType][];
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
/** Marks a (item, key) pair whose value contains the query word, as opposed to a fuzzy similarity in (0, 1]. */
const SUBSTRING = 2;

/** Scores are rounded so floating-point noise never decides an order (ties fall back to data order). */
function round(score: number): number {
  return Math.round(score * 1e6) / 1e6;
}

/** Best raw field score per item and key (`0` = no match). */
type FieldScores = Map<number, Float64Array>;

function setScore(scores: FieldScores, keyCount: number, doc: number, key: number, score: number): void {
  let row = scores.get(doc);
  if (!row) {
    row = new Float64Array(keyCount);
    scores.set(doc, row);
  }
  if (score > (row[key] as number)) row[key] = score;
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
      const weight = (index.keys[k] as { weight: number }).weight;
      this.weights[k] = weight;
      if (weight > maxWeight) maxWeight = weight;
    }
    this.maxWeight = maxWeight;
  }

  /** Best weighted field score plus a bonus for the other matching fields, scaled by the largest weight. */
  combine(row: Float64Array): number {
    let best = 0;
    let sum = 0;
    for (const k of this.activeKeys) {
      const weighted = (row[k] as number) * (this.weights[k] as number);
      sum += weighted;
      if (weighted > best) best = weighted;
    }
    return round((best + MULTI_FIELD_BONUS * (sum - best)) / this.maxWeight);
  }

  matches(row: Float64Array): [number, MatchType][] {
    const matches: [number, MatchType][] = [];
    for (const k of this.activeKeys) {
      const score = row[k] as number;
      if (score > 0) matches.push([k, matchTypeOf(score)]);
    }
    return matches;
  }

  hits(scores: FieldScores): Hit[] {
    const hits: Hit[] = [];
    for (const [doc, row] of scores) hits.push({ doc, score: this.combine(row), matches: this.matches(row) });
    return hits;
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

  const pairs = new Map<number, number>();
  const { terms, termCodes, postings } = index;
  for (let t = 0; t < terms.length; t++) {
    let mark: number;
    if ((terms[t] as string).includes(word)) mark = SUBSTRING;
    else if (fuzzy) {
      mark = fuzzy.similarity(termCodes[t] as number[]);
      if (mark === 0) continue;
    } else continue;
    for (const pair of postings[t] as number[]) {
      if (active[pair % keyCount] === 0) continue;
      if ((pairs.get(pair) ?? 0) < mark) pairs.set(pair, mark);
    }
  }

  const scores: FieldScores = new Map();
  for (const [pair, mark] of pairs) {
    const key = pair % keyCount;
    const doc = (pair - key) / keyCount;
    if (mark === SUBSTRING) {
      const values = index.fieldValues(doc, key);
      const match = values === undefined ? undefined : matchField(values, word);
      if (match) setScore(scores, keyCount, doc, key, match.score);
    } else {
      setScore(scores, keyCount, doc, key, fuzzyScore(mark));
    }
  }
  return scores;
}

/** Substring match of the whole query against every value. Used when the query has no words (e.g. "++"). */
function scanPhrase(index: SearchIndex<unknown>, query: EngineQuery, docs: Iterable<number>): FieldScores {
  const scores: FieldScores = new Map();
  for (const doc of docs) {
    for (const key of query.activeKeys) {
      const values = index.fieldValues(doc, key);
      if (values === undefined) continue;
      const match = matchField(values, query.text);
      if (match) setScore(scores, index.keyCount, doc, key, match.score);
    }
  }
  return scores;
}

function* allDocs(size: number): Iterable<number> {
  for (let doc = 0; doc < size; doc++) yield doc;
}

/**
 * Finds every item matching `query`. Results are unsorted.
 *
 * - `exact`: whole-value lookups in the exact-value maps.
 * - one-word query: vocabulary scan for the word.
 * - multi-word query: every word must match (in any searched field). The
 *   score is the better of the phrase match and the averaged word matches.
 */
export function executeQuery(index: SearchIndex<unknown>, query: EngineQuery): Hit[] {
  const scorer = new Scorer(index, query.activeKeys);
  const keyCount = index.keyCount;

  if (query.mode === "exact") {
    const scores: FieldScores = new Map();
    for (const key of query.activeKeys) {
      for (const doc of index.exactMatches(key, query.text)) setScore(scores, keyCount, doc, key, 1);
    }
    return scorer.hits(scores);
  }

  const words = [...new Set(tokenize(query.text))];
  if (words.length === 0) return scorer.hits(scanPhrase(index, query, allDocs(index.size)));

  const active = new Uint8Array(keyCount);
  for (const key of query.activeKeys) active[key] = 1;

  if (words.length === 1 && words[0] === query.text) {
    return scorer.hits(matchWord(index, query.text, query, active));
  }

  const perWord = words.map((word) => matchWord(index, word, query, active));
  // Iterate the smallest candidate set and require every other word to match too.
  perWord.sort((a, b) => a.size - b.size);
  const [smallest, ...others] = perWord as [FieldScores, ...FieldScores[]];
  const candidates: number[] = [];
  for (const doc of smallest.keys()) {
    if (others.every((scores) => scores.has(doc))) candidates.push(doc);
  }

  const phrase = scanPhrase(index, query, candidates);
  const hits: Hit[] = [];
  for (const doc of candidates) {
    let wordTotal = 0;
    const shown = new Float64Array(keyCount);
    for (const scores of perWord) {
      const row = scores.get(doc) as Float64Array;
      wordTotal += scorer.combine(row);
      for (const key of query.activeKeys) if ((row[key] as number) > (shown[key] as number)) shown[key] = row[key] as number;
    }
    const wordScore = (WORD_BY_WORD_FACTOR * wordTotal) / perWord.length;
    const phraseRow = phrase.get(doc);
    const phraseScore = phraseRow ? scorer.combine(phraseRow) : 0;
    if (phraseRow) {
      for (const key of query.activeKeys) if ((phraseRow[key] as number) > 0) shown[key] = phraseRow[key] as number;
    }
    hits.push({ doc, score: round(Math.max(phraseScore, wordScore)), matches: scorer.matches(shown) });
  }
  return hits;
}

/** Sorts hits in place: by score (ties in data order) or by data order. */
export function sortHits(hits: Hit[], order: "relevance" | "original"): Hit[] {
  if (order === "original") return hits.sort((a, b) => a.doc - b.doc);
  return hits.sort((a, b) => b.score - a.score || a.doc - b.doc);
}
