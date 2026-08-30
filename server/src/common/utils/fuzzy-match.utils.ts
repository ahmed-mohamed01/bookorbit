import { distance } from 'fastest-levenshtein';

export function normalizeIsbn(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^0-9X]/gi, '').toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

// A number, plus the ordinal suffix it carries when it has one. Matching the suffix as part of the
// token is what keeps "50th" from degrading into a bare "50" under backtracking.
const NUMBER_TOKEN = /\d+(?:\.\d+)?(?:st|nd|rd|th)?/g;
const ORDINAL_TOKEN = /(?:st|nd|rd|th)$/;

/**
 * True when both titles carry a number and the numbers differ: "The Primal Hunter 3" vs
 * "The Primal Hunter 16" is a different volume of the same series, not a fuzzy near-miss, and edit
 * distance is nearly blind to it (2 edits over 20 characters reads as 90% similar). One-sided
 * numbers stay allowed - subtitles and editions often drop the volume.
 *
 * Ordinals are not volumes: "50th Anniversary Edition" names the same book as any other printing of
 * it, so those numbers are excluded rather than read as volume 50.
 */
export function titleVolumeConflict(a: string, b: string): boolean {
  const numbersOf = (value: string) => (normalizeName(value).match(NUMBER_TOKEN) ?? []).filter((token) => !ORDINAL_TOKEN.test(token));
  const left = numbersOf(a);
  const right = numbersOf(b);
  if (left.length === 0 || right.length === 0) return false;
  return Number.parseFloat(left[left.length - 1]) !== Number.parseFloat(right[right.length - 1]);
}

export function scoreTitle(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.startsWith(right) || right.startsWith(left)) return 0.94;
  if (left.includes(right) || right.includes(left)) return 0.9;

  const tokenScore = tokenOverlap(left, right);
  const editScore = normalizedLevenshtein(left, right);
  return Math.max(tokenScore, editScore >= 0.7 ? editScore : 0);
}

export function scoreAuthors(hardcoverAuthors: string[], localAuthors: string[]): number {
  let best = 0;
  for (const hardcoverAuthor of hardcoverAuthors) {
    for (const localAuthor of localAuthors) {
      best = Math.max(best, scoreAuthor(hardcoverAuthor, localAuthor));
    }
  }
  return best;
}

function scoreAuthor(a: string, b: string): number {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = tokenize(left);
  const rightTokens = tokenize(right);
  if (haveEqualTokenSet(leftTokens, rightTokens)) return 0.98;
  const overlap = tokenOverlap(left, right);
  const edit = normalizedLevenshtein(left, right);
  return Math.max(overlap, edit >= 0.76 ? edit : 0);
}

function normalizeTitle(value: string): string {
  const stripped = value.split(/:\s+| - /)[0] ?? value;
  return normalizeName(stripped);
}

export function normalizeName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return value.split(' ').filter((token) => token.length > 1);
}

export function tokenOverlap(a: string, b: string): number {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.max(left.size, right.size);
}

export function normalizedLevenshtein(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - distance(a, b) / maxLen;
}

function haveEqualTokenSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((token, index) => token === right[index]);
}
