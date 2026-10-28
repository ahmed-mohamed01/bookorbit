import type { EditionLinkMatchAction, EditionLinkMatchBucket } from '@bookorbit/types';
import { normalizeName, scoreAuthors, scoreTitle } from '../../common/utils/fuzzy-match.utils';

export const STRONG_SCORE = 0.92;
export const WEAK_SCORE = 0.8;
export const IDENTIFIER_SCORE = 0.99;

export interface ScoredCandidate {
  bookId: number;
  score: number;
  titleScore: number;
  authorScore: number;
  isbnMatch: boolean;
  /** The titles only match because one is the start of the other ("Dune" and "Dune Messiah"). */
  prefixOnly: boolean;
  /** Another book already holds this role in the candidate's work. */
  claimedBy: number | null;
}

export interface ClassifiedMatch {
  bucket: EditionLinkMatchBucket;
  targetBookId: number;
  score: number;
  titleScore: number;
  authorScore: number;
  isbnMatch: boolean;
  reason: string;
  competingBookIds: number[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function scoreReason(candidate: Pick<ScoredCandidate, 'titleScore' | 'authorScore' | 'isbnMatch'>): string {
  return candidate.isbnMatch ? 'same ISBN or ASIN' : `title ${round(candidate.titleScore)} author ${round(candidate.authorScore)}`;
}

/** True when one title is only a leading part of the other, which scoreTitle rates as a near match. */
export function isPrefixOnlyTitle(left: string | null, right: string | null): boolean {
  const normalize = (value: string) => normalizeName(value.split(/:\s+| - /)[0] ?? value);
  if (!left || !right) return false;
  const a = normalize(left);
  const b = normalize(right);
  return a !== b && (a.startsWith(b) || b.startsWith(a));
}

/** Two books in different languages are different editions of a work, never one work. */
export function languagesDiffer(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return left.trim().toLowerCase().slice(0, 2) !== right.trim().toLowerCase().slice(0, 2);
}

/**
 * Buckets a source book's best match. A linked source is checked against its link: fine while the
 * linked book is still its best match, suspect when another book scores higher or the linked one
 * scores below weak. An unlinked source is strong at 0.92 (a prefix-only title needs an identifier
 * match too), weak at 0.8, and a conflict when the target's role in its work is already taken.
 */
export function classifyMatch(linkedTargetId: number | null, candidates: readonly ScoredCandidate[]): ClassifiedMatch | null {
  const ranked = [...candidates].sort((left, right) => right.score - left.score || left.bookId - right.bookId);
  const best = ranked[0];
  const toMatch = (bucket: EditionLinkMatchBucket, candidate: ScoredCandidate, reason: string, competingBookIds: number[] = []): ClassifiedMatch => ({
    bucket,
    targetBookId: candidate.bookId,
    score: candidate.score,
    titleScore: candidate.titleScore,
    authorScore: candidate.authorScore,
    isbnMatch: candidate.isbnMatch,
    reason,
    competingBookIds,
  });

  if (linkedTargetId !== null) {
    const linked = ranked.find((candidate) => candidate.bookId === linkedTargetId) ?? {
      bookId: linkedTargetId,
      score: 0,
      titleScore: 0,
      authorScore: 0,
      isbnMatch: false,
      prefixOnly: false,
      claimedBy: null,
    };
    if (best && best.bookId !== linkedTargetId && best.score > linked.score && best.score >= WEAK_SCORE) {
      return toMatch('linked_suspect', best, `linked to #${linkedTargetId} but #${best.bookId} scores higher`);
    }
    if (linked.score < WEAK_SCORE) return toMatch('linked_suspect', linked, `linked to #${linkedTargetId}, score ${round(linked.score)}`);
    return toMatch('linked_ok', linked, scoreReason(linked));
  }

  if (!best || best.score < WEAK_SCORE) return null;
  if (best.claimedBy !== null) return toMatch('conflict', best, `also claimed by #${best.claimedBy}`, [best.claimedBy]);
  const strong = best.score >= STRONG_SCORE && (!best.prefixOnly || best.isbnMatch);
  return toMatch(strong ? 'strong' : 'weak', best, scoreReason(best));
}

export interface StrongClaim {
  resultId: number;
  sourceBookId: number;
  targetBookId: number;
}

export interface ClaimSource {
  title: string | null;
  authorNames: string[];
}

function strongDuplicates(left: ClaimSource, right: ClaimSource): boolean {
  const titleScore = scoreTitle(left.title ?? '', right.title ?? '');
  const comparable = left.authorNames.length > 0 && right.authorNames.length > 0;
  const score = comparable ? titleScore * 0.7 + scoreAuthors(left.authorNames, right.authorNames) * 0.3 : titleScore;
  return score >= STRONG_SCORE;
}

/**
 * A target claimed as strong by several sources is a conflict, unless every pair of those sources is a
 * strong duplicate of each other and duplicates may share a work. Returns the competing books per result.
 */
export function detectConflicts(
  claims: readonly StrongClaim[],
  sources: ReadonlyMap<number, ClaimSource>,
  duplicatesAllowed: boolean,
): Map<number, number[]> {
  const byTarget = new Map<number, StrongClaim[]>();
  for (const claim of claims) byTarget.set(claim.targetBookId, [...(byTarget.get(claim.targetBookId) ?? []), claim]);

  const conflicts = new Map<number, number[]>();
  for (const group of byTarget.values()) {
    const sourceIds = [...new Set(group.map((claim) => claim.sourceBookId))];
    if (sourceIds.length < 2) continue;
    const allDuplicates =
      duplicatesAllowed &&
      sourceIds.every((left, index) =>
        sourceIds.slice(index + 1).every((right) => {
          const a = sources.get(left);
          const b = sources.get(right);
          return a !== undefined && b !== undefined && strongDuplicates(a, b);
        }),
      );
    if (allDuplicates) continue;
    for (const claim of group)
      conflicts.set(
        claim.resultId,
        sourceIds.filter((id) => id !== claim.sourceBookId),
      );
  }
  return conflicts;
}

export function proposedActionFor(bucket: EditionLinkMatchBucket, targetInSourceWork: boolean): EditionLinkMatchAction {
  if (bucket === 'strong') return 'link';
  if (bucket === 'linked_suspect') return targetInSourceWork ? 'review' : 'relink';
  if (bucket === 'linked_ok') return 'none';
  return 'review';
}
