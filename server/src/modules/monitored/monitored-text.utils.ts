/**
 * The text-folding steps the monitored feature normalizes with. Every normalizer here starts from the
 * same accent fold; they diverge only in what they keep afterwards, which is why they stay separate
 * functions rather than one configurable one.
 */

/** NFKD, then drop the combining marks it split off, so "Métal" folds onto "Metal". */
export function foldDiacritics(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '');
}

/**
 * An author or series name reduced to bare letters and digits. Unicode letters survive, so two
 * different non-Latin names stay different instead of both collapsing to the empty string.
 *
 * This deliberately does NOT delegate to the shared normalizeWorkToken: that one lowercases before
 * NFKD, so a character whose decomposition produces letters keeps them uppercase ("Stormlight(tm)"
 * normalizes with a literal "TM" in it) and two spellings of one name stop comparing equal. Folding
 * first and lowercasing after is what makes this usable as an identity key.
 */
export function normalizeMonitoredName(value: string): string {
  return foldDiacritics(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * A LIKE pattern exactly as loose as the identity key: every run of characters the key would drop
 * becomes a wildcard, edges included. Only its null check is consumed now: the store prefilters an
 * indexed column on identityLikeRun instead, and this tells it whether a value holds anything a
 * scan could match at all. null when nothing but separators remains.
 */
export function identityLikePattern(text: string): string | null {
  const pattern = text.replace(/[^\p{L}\p{N}]+/gu, '%');
  return /[\p{L}\p{N}]/u.test(pattern) ? pattern : null;
}

/**
 * The longest run of letters or digits in the folded value, which the store matches as a plain
 * substring to narrow an indexed scan. Matching one run instead of the whole pattern is what makes
 * the prefilter symmetric between spellings that differ only in separator positions: the full
 * pattern demanded the input's own separators, so a stored "Ursula K. Le Guin" escaped a search for
 * "Ursula K. LeGuin". It is only a narrowing, never the identity decision - a stored value that
 * splits the run itself ("Spider-Man" vs "Spiderman") still escapes it, and the folded key
 * comparison after it stays the final word. Ties go to the earliest run; null when nothing but
 * separators remains.
 */
export function identityLikeRun(value: string): string | null {
  const runs = foldDiacritics(value)
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!runs?.length) return null;
  return runs.reduce((longest, run) => (run.length > longest.length ? run : longest));
}

/** The words of a search query: accent-folded, lowercased, split on anything that is not a letter or digit. */
export function foldedQueryWords(value: string): string[] {
  return foldDiacritics(value)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The `title|author` identity key the palette dedupes provider hits against owned works with. */
export function titleAuthorKey(title: string | null | undefined, authorName: string | null | undefined): string {
  return `${normalizeMonitoredName(title ?? '')}|${normalizeMonitoredName(authorName ?? '')}`;
}
