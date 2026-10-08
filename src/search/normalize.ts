export interface NormalizeOptions {
  ignoreDiacritics: boolean;
}

const WHITESPACE = /\s+/g;
const COMBINING_MARKS = /\p{M}/gu;
/** ASCII and precomposed Hangul syllables are already in NFKC form. */
const NFKC_STABLE = /^[\u0000-\u007f\uac00-\ud7a3]*$/;
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function isWellFormed(text: string): boolean {
  // String.prototype.isWellFormed exists in Node.js 20+, but is not in the ES2022 type library.
  return (text as unknown as { isWellFormed(): boolean }).isWellFormed();
}

/**
 * Normalizes text for matching: Unicode NFKC (composes Hangul jamo, folds
 * full-width forms), lower case, optional diacritic removal, and collapsed
 * whitespace.
 */
export function normalizeText(value: string, options: NormalizeOptions): string {
  let text = (NFKC_STABLE.test(value) ? value : value.normalize("NFKC")).toLowerCase();
  // Lone surrogates are not characters: drop them so they cannot match halves of emoji.
  if (!isWellFormed(text)) text = text.replace(LONE_SURROGATE, "");
  if (options.ignoreDiacritics) {
    // NFD splits Hangul syllables into conjoining jamo (letters, not marks), so recompose afterwards.
    text = text.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
  }
  return hasIrregularWhitespace(text) ? text.replace(WHITESPACE, " ").trim() : text;
}

/** Whether `text` has whitespace other than single spaces between non-space characters (JavaScript `\s`). */
function hasIrregularWhitespace(text: string): boolean {
  const last = text.length - 1;
  for (let i = 0; i <= last; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x20) {
      if (i === 0 || i === last || text.charCodeAt(i + 1) === 0x20) return true;
    } else if (code < 0x20) {
      if (code >= 0x09 && code <= 0x0d) return true;
    } else if (
      code >= 0xa0 &&
      (code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Letters, digits and combining marks form words; everything else separates
 * them. ASCII and Hangul syllables are classified without a regular expression.
 */
function isWordCodePoint(code: number): boolean {
  if (code < 0x80) return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a);
  if (code >= 0xac00 && code <= 0xd7a3) return true;
  return WORD_CHAR.test(String.fromCodePoint(code));
}

/** Splits normalized text into words (maximal runs of word characters). */
export function tokenize(text: string): string[] {
  const words: string[] = [];
  let start = -1;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i) as number;
    if (isWordCodePoint(code)) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      words.push(text.slice(start, i));
      start = -1;
    }
    i += code > 0xffff ? 2 : 1;
  }
  if (start !== -1) words.push(text.slice(start));
  return words;
}

/** Whether the character before `index` separates words (or `index` is the start). */
export function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  let code = text.charCodeAt(index - 1);
  // The previous character may be the second half of a surrogate pair.
  if (code >= 0xdc00 && code <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) code = text.codePointAt(index - 2) as number;
  }
  return !isWordCodePoint(code);
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
