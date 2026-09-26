import type { StorytellerExistingMatch } from '@bookorbit/types';

import { scoreAuthors, scoreTitle, titleVolumeConflict } from '../../common/utils/fuzzy-match.utils';
import { normalizeStorytellerIdentifier } from './storyteller-book-normalize.utils';
import type { StorytellerBookSummary } from './storyteller-client.types';

// The floor the link candidate list uses.
const MIN_MATCH_SCORE = 70;

const ISBN_13 = /^\d{13}$/;
const ISBN_10 = /^\d{9}[\dx]$/;
const ASIN = /^b[0-9a-z]{9}$/;

export interface StorytellerMatchInput {
  title: string;
  authors: string[];
  /** ISBN/ASIN style identifiers of the BookOrbit pair, in any notation. */
  identifiers: string[];
}

/**
 * Null for a value that proves nothing. Storyteller stores whatever an import put in the identifier
 * table - a bare `1`, a Calibre row id - and an equality test over those returns a certain match for
 * two unrelated books. ISBN-10 is widened to ISBN-13 so either notation compares equal.
 */
export function canonicalStorytellerIdentifier(value: string | null | undefined): string | null {
  const normalized = normalizeStorytellerIdentifier(value);
  if (!normalized) return null;
  if (ISBN_13.test(normalized)) return normalized;
  if (ISBN_10.test(normalized)) return isbn10ToIsbn13(normalized);
  if (ASIN.test(normalized)) return normalized;
  return null;
}

/**
 * Best first. A shared identifier is proof and scores 100; otherwise title and author similarity
 * decide, on the edition-link candidate list's 0-100 scale. Unaligned books stay in the result:
 * only the caller knows whether it wants to reuse an aligned book or re-process an existing one.
 */
export function matchExistingBooks(pair: StorytellerMatchInput, remote: readonly StorytellerBookSummary[]): StorytellerExistingMatch[] {
  const identifiers = new Set(
    (pair.identifiers ?? [])
      .map((identifier) => canonicalStorytellerIdentifier(identifier))
      .filter((identifier): identifier is string => identifier !== null),
  );
  const authors = (pair.authors ?? []).filter((author) => author.trim().length > 0);

  const matches: StorytellerExistingMatch[] = [];
  for (const book of remote) {
    const score = scoreCandidate(pair.title ?? '', authors, identifiers, book);
    if (score < MIN_MATCH_SCORE) continue;
    matches.push({ uuid: book.uuid, title: book.title, authors: book.authors, aligned: book.aligned, score });
  }
  return matches.sort((left, right) => right.score - left.score || left.uuid.localeCompare(right.uuid));
}

function scoreCandidate(title: string, authors: string[], identifiers: ReadonlySet<string>, book: StorytellerBookSummary): number {
  if (identifiers.size > 0 && book.identifiers.some((identifier) => sharesIdentifier(identifiers, identifier))) return 100;
  if (!title || !book.title) return 0;

  const titleScore = titleVolumeConflict(title, book.title) ? 0 : scoreTitle(title, book.title);
  if (titleScore === 0) return 0;

  const comparableAuthors = authors.length > 0 && book.authors.length > 0;
  if (!comparableAuthors) return Math.round(titleScore * 100);

  const authorScore = scoreAuthors(book.authors, authors);
  return Math.round((titleScore * 0.7 + authorScore * 0.3) * 100);
}

function sharesIdentifier(identifiers: ReadonlySet<string>, candidate: string): boolean {
  const canonical = canonicalStorytellerIdentifier(candidate);
  return canonical !== null && identifiers.has(canonical);
}

function isbn10ToIsbn13(isbn10: string): string {
  const body = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    sum += Number(body[index]) * (index % 2 === 0 ? 1 : 3);
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}
