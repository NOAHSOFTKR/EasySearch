export interface NormalizeOptions {
  ignoreDiacritics: boolean;
}

const WHITESPACE = /\s+/gu;
const COMBINING_MARKS = /\p{M}/gu;
/** Maximal runs of letters, digits and combining marks. Everything else separates words. */
const WORD = /[\p{L}\p{N}\p{M}]+/gu;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * Normalizes text for matching: Unicode NFKC (composes Hangul jamo, folds
 * full-width forms), lower case, optional diacritic removal, and collapsed
 * whitespace.
 */
export function normalizeText(value: string, options: NormalizeOptions): string {
  let text = value.normalize("NFKC").toLowerCase();
  if (options.ignoreDiacritics) {
    // NFD splits Hangul syllables into conjoining jamo (letters, not marks), so recompose afterwards.
    text = text.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
  }
  return text.replace(WHITESPACE, " ").trim();
}

/** Splits normalized text into words. */
export function tokenize(text: string): string[] {
  return text.match(WORD) ?? [];
}

/** Whether the character before `index` separates words (or `index` is the start). */
export function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  // Surrogate pairs: look at the full code point that ends right before `index`.
  const prev = text.codePointAt(index - 1);
  const low = prev !== undefined && prev >= 0xdc00 && prev <= 0xdfff && index >= 2;
  const ch = low ? String.fromCodePoint(text.codePointAt(index - 2) ?? 0) : text.charAt(index - 1);
  return !WORD_CHAR.test(ch);
}

const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JUNG_COUNT = 21;
const JONG_COUNT = 28;
const CHO_JAMO = 0x1100;
const JUNG_JAMO = 0x1161;
const JONG_JAMO = 0x11a7;

/**
 * Code points used for edit-distance comparison. Precomposed Hangul syllables
 * are split into their jamo, so "니아" vs "니야" is one edit out of four
 * instead of one out of two.
 */
export function toFuzzyCodes(word: string): number[] {
  const codes: number[] = [];
  for (const ch of word) {
    const code = ch.codePointAt(0) as number;
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      const offset = code - HANGUL_BASE;
      const jong = offset % JONG_COUNT;
      const jung = ((offset - jong) / JONG_COUNT) % JUNG_COUNT;
      const cho = Math.floor(offset / (JUNG_COUNT * JONG_COUNT));
      codes.push(CHO_JAMO + cho, JUNG_JAMO + jung);
      if (jong !== 0) codes.push(JONG_JAMO + jong);
    } else {
      codes.push(code);
    }
  }
  return codes;
}
