import { distance } from 'fastest-levenshtein';

export function normalizeIsbn(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^0-9X]/gi, '').toUpperCase();
  return normalized.length > 0 ? normalized : null;
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
