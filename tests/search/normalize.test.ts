import { describe, expect, it } from "vitest";
import { isWordStart, normalizeText, toFuzzyCodes, tokenize } from "../../src/search/normalize.js";

const plain = { ignoreDiacritics: false };

describe("normalizeText", () => {
  it("lower-cases, trims and collapses whitespace", () => {
    expect(normalizeText("  Hello   WORLD\n\t! ", plain)).toBe("hello world !");
  });

  it("composes decomposed Hangul (NFD input, e.g. from macOS) with NFKC", () => {
    const decomposed = "니아".normalize("NFD");
    expect(decomposed).not.toBe("니아");
    expect(normalizeText(decomposed, plain)).toBe("니아");
  });

  it("folds full-width characters", () => {
    expect(normalizeText("ＴＴＳ　봇", plain)).toBe("tts 봇");
  });

  it("keeps diacritics unless ignoreDiacritics is set, without breaking Hangul", () => {
    expect(normalizeText("Café 검색", plain)).toBe("café 검색");
    expect(normalizeText("Café 검색", { ignoreDiacritics: true })).toBe("cafe 검색");
  });
});

describe("tokenize", () => {
  it("splits on punctuation and whitespace, keeping letters and digits of any script", () => {
    expect(tokenize("니아 tts-봇, v2.0 😀 東京")).toEqual(["니아", "tts", "봇", "v2", "0", "東京"]);
  });

  it("returns an empty list for text without words", () => {
    expect(tokenize("++ --")).toEqual([]);
  });
});

describe("isWordStart", () => {
  it("detects word boundaries", () => {
    expect(isWordStart("니아 봇", 0)).toBe(true);
    expect(isWordStart("니아 봇", 3)).toBe(true);
    expect(isWordStart("니아봇", 2)).toBe(false);
  });

  it("treats astral letters (surrogate pairs) as word characters", () => {
    const text = "𠀀abc"; // U+20000 is a CJK ideograph outside the BMP
    expect(isWordStart(text, 2)).toBe(false);
  });
});

describe("toFuzzyCodes", () => {
  it("decomposes Hangul syllables into jamo", () => {
    expect(toFuzzyCodes("니아")).toHaveLength(4);
    expect(toFuzzyCodes("검색")).toHaveLength(6);
  });

  it("keeps other characters as code points (astral characters count once)", () => {
    expect(toFuzzyCodes("abc")).toEqual([97, 98, 99]);
    expect(toFuzzyCodes("😀a")).toHaveLength(2);
  });
});

describe("normalizeText fast paths", () => {
  it("agrees with the plain regex/NFKC implementation", () => {
    const reference = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
    const pieces = ["a", "B", " ", "  ", "\t", "\n", " ", "　", "﻿", "니아", "ＴＴＳ", "ﬁ", "é", "é", "😀", "Ⅻ", "x"];
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 3000; n++) {
      let value = "";
      const length = Math.floor(random() * 8);
      for (let i = 0; i < length; i++) value += pieces[Math.floor(random() * pieces.length)];
      expect(normalizeText(value, plain)).toBe(reference(value));
    }
  });

  it("tokenizes like the Unicode word regex", () => {
    const reference = (text: string) => text.match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
    for (const text of ["니아 tts-봇", "été ½ ²", "𠀀𠀁 x", "a\ud800b", "東京タワー", "١٢٣ عربي", "__init__"]) {
      expect(tokenize(text)).toEqual(reference(text));
    }
  });
});
