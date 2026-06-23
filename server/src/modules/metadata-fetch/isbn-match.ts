import { MetadataCandidate } from '@bookorbit/types';

import { normalizeIsbn } from '../metadata/lib/isbn-detect';

export function normalizeMetadataIsbn(value: string | null | undefined): string {
  return value ? normalizeIsbn(value) : '';
}

export function candidateHasNormalizedIsbn(candidate: MetadataCandidate, normalizedIsbn: string): boolean {
  return (
    normalizedIsbn.length > 0 &&
    (normalizeMetadataIsbn(candidate.isbn10) === normalizedIsbn || normalizeMetadataIsbn(candidate.isbn13) === normalizedIsbn)
  );
}
