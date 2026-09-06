const SMART_SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\u2035]/g;
const SMART_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u2036]/g;
const SOFT_HYPHEN = /\u00AD/g;
const DASHES = /[\u2010-\u2015\u2212]/g;
const NON_BREAKING_SPACES = /[\u00A0\u2007\u202F\uFEFF]/g;

/**
 * Canonical normalizer for fuzzy matching a whisper transcript against book
 * text. The client mirrors this exact behavior.
 *
 * Rules (applied in order):
 *  1. Unicode NFKC fold so composed/compatibility forms compare equal.
 *  2. Lowercase.
 *  3. Drop soft hyphens entirely (they are invisible line-break hints).
 *  4. Fold smart single/double quotes to straight quotes, unify dashes, and
 *     turn non-breaking spaces into normal spaces, then remove all remaining
 *     punctuation and symbols (anything that is not a letter, number, or
 *     whitespace). This turns "Mr. O'Brien," into "mr obrien".
 *  5. Collapse all whitespace runs to a single space and trim.
 *
 * The normalizer intentionally does NOT expand abbreviations or spell out
 * initialisms: "Mister OBrien" normalizes to "mister obrien", which does not
 * equal "mr obrien". Bridging that gap (Mister vs Mr) is the fuzzy matcher's
 * job, not the normalizer's. The normalizer only guarantees that surface-level
 * differences (case, punctuation, smart quotes, soft hyphens, unicode form)
 * never block a match.
 */
export function normalizeForMatch(s: string): string {
  if (!s) return '';
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(SOFT_HYPHEN, '')
    .replace(SMART_SINGLE_QUOTES, "'")
    .replace(SMART_DOUBLE_QUOTES, '"')
    .replace(DASHES, '-')
    .replace(NON_BREAKING_SPACES, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
