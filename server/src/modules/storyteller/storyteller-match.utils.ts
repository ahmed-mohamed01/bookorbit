import type { StorytellerExistingMatch } from '@bookorbit/types';

import { normalizeName, scoreAuthors } from '../../common/utils/fuzzy-match.utils';
import { normalizeStorytellerIdentifier } from './storyteller-book-normalize.utils';
import type { StorytellerBookSummary } from './storyteller-client.types';

// The author floor the edition-link candidate list applies to a title match.
const MIN_AUTHOR_SCORE = 0.75;
const ARTICLES = new Set(['the', 'a', 'an']);
const VERSUS = new Set(['vs', 'versus']);

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
 * Best first. A shared identifier is proof and scores 100. Otherwise the titles must be the same
 * title and the authors must agree: a fuzzy title is not enough, because books of one series by one
 * author share most of their words ("Alcatraz vs. the Evil Librarians", "Bastille vs. the Evil
 * Librarians") and importing the wrong one attaches another book's read-along. The score only
 * orders what passes. Unaligned books stay in the result: only the caller knows whether it wants to
 * reuse an aligned book or re-process an existing one.
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
    if (score === null) continue;
    matches.push({ uuid: book.uuid, title: book.title, authors: book.authors, aligned: book.aligned, score });
  }
  return matches.sort((left, right) => right.score - left.score || left.uuid.localeCompare(right.uuid));
}

function scoreCandidate(title: string, authors: string[], identifiers: ReadonlySet<string>, book: StorytellerBookSummary): number | null {
  if (identifiers.size > 0 && book.identifiers.some((identifier) => sharesIdentifier(identifiers, identifier))) return 100;
  const left = comparableTitle(title);
  if (!left || left !== comparableTitle(book.title)) return null;

  // With no authors on one side there is nothing to disagree with, and the titles already agree.
  if (authors.length === 0 || book.authors.length === 0) return 100;
  const authorScore = scoreAuthors(book.authors, authors);
  if (authorScore < MIN_AUTHOR_SCORE) return null;
  return Math.round((0.7 + authorScore * 0.3) * 100);
}

/**
 * The title with case, punctuation, whitespace and articles folded, "vs", "vs." and "versus" read as
 * one word, and a trailing subtitle after a colon dropped: editions of one book differ in exactly
 * those ways.
 */
function comparableTitle(value: string | null | undefined): string {
  const main = (value ?? '').split(':')[0] ?? '';
  return normalizeName(main)
    .split(' ')
    .filter((token) => token.length > 0 && !ARTICLES.has(token))
    .map((token) => (VERSUS.has(token) ? 'vs' : token))
    .join(' ');
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
