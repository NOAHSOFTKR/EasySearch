import { describe, expect, it } from "vitest";
import {
  FuzzyMatcher,
  defaultMaxEdits,
  fieldScore,
  fuzzyScore,
  matchTypeOf,
  substringScore,
} from "../../src/search/matchers.js";
import { toFuzzyCodes } from "../../src/search/normalize.js";

const typeOf = (value: string, query: string) => matchTypeOf(substringScore(value, query));

describe("substringScore", () => {
  it("classifies exact, prefix, word and partial matches", () => {
    expect(typeOf("니아", "니아")).toBe("exact");
    expect(typeOf("니아 tts 봇", "니아")).toBe("prefix");
    expect(typeOf("디스코드 니아봇", "니아")).toBe("word");
    expect(typeOf("디스코드니아", "니아")).toBe("partial");
    expect(substringScore("검색", "니아")).toBe(0);
  });

  it("finds a word-start occurrence after an earlier in-word occurrence", () => {
    expect(typeOf("abcat cat", "cat")).toBe("word");
  });

  it("orders score bands exact > prefix > word > partial > fuzzy", () => {
    const exact = substringScore("ab", "ab");
    const prefix = substringScore("abc", "ab");
    const word = substringScore("x ab", "ab");
    const partial = substringScore("xab", "ab");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(fuzzyScore(1));
  });

  it("prefers shorter values within a band (coverage)", () => {
    const short = substringScore("니아 봇", "니아");
    const long = substringScore("니아 tts 디스코드 봇", "니아");
    expect(short).toBeGreaterThan(long);
  });

  it("keeps every band apart for any coverage", () => {
    expect(matchTypeOf(substringScore("a".repeat(1000), "a"))).toBe("prefix");
    expect(matchTypeOf(substringScore("ab", "a"))).toBe("prefix");
    expect(matchTypeOf(substringScore("x a", "a"))).toBe("word");
    expect(matchTypeOf(substringScore("xa", "a"))).toBe("partial");
    expect(matchTypeOf(fuzzyScore(1))).toBe("fuzzy");
    expect(matchTypeOf(fuzzyScore(0.01))).toBe("fuzzy");
  });
});

describe("fieldScore", () => {
  it("returns the best match across array values", () => {
    expect(matchTypeOf(fieldScore(["니아봇", "니아"], "니아"))).toBe("exact");
    expect(fieldScore(["검색"], "니아")).toBe(0);
  });
});

describe("FuzzyMatcher", () => {
  const similarity = (query: string, word: string, maxEdits = defaultMaxEdits(toFuzzyCodes(query).length)) =>
    new FuzzyMatcher(toFuzzyCodes(query), maxEdits).similarity(toFuzzyCodes(word));

  it("accepts words within the edit budget", () => {
    expect(similarity("search", "serach")).toBeGreaterThan(0); // transposition = 1 edit
    expect(similarity("library", "libary")).toBeGreaterThan(0); // deletion
    expect(similarity("검섹", "검색")).toBeGreaterThan(0); // one jamo differs
  });

  it("rejects words beyond the edit budget", () => {
    expect(similarity("search", "sandwich")).toBe(0);
    expect(similarity("검색", "안녕")).toBe(0);
    expect(similarity("cat", "dog")).toBe(0);
  });

  it("does not fuzz very short queries by default", () => {
    expect(defaultMaxEdits(2)).toBe(0);
    expect(new FuzzyMatcher(toFuzzyCodes("ab"), 0).enabled).toBe(false);
  });

  it("caps the edit budget so at least one character must match", () => {
    expect(similarity("abc", "xyz", 10)).toBe(0);
  });

  it("matches long queries against word prefixes, ranked below whole-word matches", () => {
    const prefix = similarity("라이부", "라이브러리");
    const whole = similarity("라이브러뤼", "라이브러리");
    expect(prefix).toBeGreaterThan(0);
    expect(whole).toBeGreaterThan(prefix);
  });

  it("gives identical words similarity 1", () => {
    expect(similarity("search", "search")).toBe(1);
  });

  it("agrees with a reference OSA distance on random strings", () => {
    const osa = (a: number[], b: number[]): number => {
      const d = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
      );
      for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
          const cost = a[i - 1] === b[j - 1] ? 0 : 1;
          let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
          d[i]![j] = v;
        }
      }
      return d[a.length]![b.length]!;
    };
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const word = (len: number) => Array.from({ length: len }, () => 97 + Math.floor(rand() * 4));
    for (let n = 0; n < 2000; n++) {
      const q = word(3 + Math.floor(rand() * 4));
      const w = word(1 + Math.floor(rand() * 8));
      const k = 2;
      const matcher = new FuzzyMatcher(q, k);
      const expected = osa(q, w);
      const sim = matcher.similarity(w);
      if (expected <= k) {
        // A whole-word match must be found with the exact distance.
        expect(sim === 1 - expected / q.length || (q.length >= 5 && sim > 0)).toBe(true);
      } else if (q.length < 5 || w.length <= q.length) {
        expect(sim).toBe(0);
      }
    }
  });
});
