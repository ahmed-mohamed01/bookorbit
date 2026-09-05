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
