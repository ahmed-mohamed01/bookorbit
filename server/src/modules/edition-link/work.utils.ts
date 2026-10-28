import type { WorkVariantRole } from '@bookorbit/types';
import { bookFormatKey, formatKeyRank, normalizeFormatPriority } from '@bookorbit/types';

import type { AttemptMergePlan, AttemptRow, WorkPrimaries } from './work.repository';

export interface PrimaryCandidate {
  bookId: number;
  role: WorkVariantRole;
  createdAt: Date;
  primaryFormat: string | null;
  primaryReadAlong: boolean;
  formatPriority: readonly string[] | null;
}

/** Where a book's primary file sits in its own library's format order; lower wins. */
export function formatRankOf(candidate: Pick<PrimaryCandidate, 'primaryFormat' | 'primaryReadAlong' | 'formatPriority'>): number {
  if (!candidate.primaryFormat) return Number.MAX_SAFE_INTEGER;
  return formatKeyRank(bookFormatKey(candidate.primaryFormat, candidate.primaryReadAlong), normalizeFormatPriority(candidate.formatPriority));
}

/**
 * One primary per role: the copy whose format comes first in its library's format order, the oldest
 * member on a tie. The primary is the copy integrations see. `current` carries the primaries a work
 * already has, kept while they remain members, so removing another copy never undoes a chosen one.
 */
export function pickPrimaries(members: readonly PrimaryCandidate[], current?: Partial<WorkPrimaries>): WorkPrimaries {
  const pick = (role: WorkVariantRole): number | null => {
    const kept = current?.[role];
    if (kept != null && members.some((member) => member.role === role && member.bookId === kept)) return kept;
    const ranked = members
      .filter((member) => member.role === role)
      .map((member) => ({ member, rank: formatRankOf(member) }))
      .sort(
        (left, right) =>
          left.rank - right.rank || left.member.createdAt.getTime() - right.member.createdAt.getTime() || left.member.bookId - right.member.bookId,
      );
    return ranked[0]?.member.bookId ?? null;
  };
  return { text: pick('text'), audio: pick('audio'), readAlong: pick('readAlong') };
}

function datedness(attempt: AttemptRow): number {
  return (attempt.startedOn ? 1 : 0) + (attempt.endedOn ? 1 : 0);
}

function duplicateKey(attempt: AttemptRow): string | null {
  if (attempt.outcome === null) return 'active';
  if (attempt.endedOn === null) return null;
  return `${attempt.origin}|${attempt.endedOn}`;
}

/**
 * Folds a joining book's attempts into the canonical book's history. Two attempts are the same read
 * when both are active, or when they share an origin and an end date; the one carrying more dates is
 * kept, the canonical's on a tie, and the other is soft-deleted.
 */
export function planAttemptMerge(canonicalBookId: number, attempts: readonly AttemptRow[]): AttemptMergePlan {
  const kept = new Map<string, AttemptRow>();
  const deletes: { id: number; keptId: number }[] = [];
  const ordered = [...attempts].sort(
    (left, right) => Number(right.bookId === canonicalBookId) - Number(left.bookId === canonicalBookId) || left.id - right.id,
  );
  for (const attempt of ordered) {
    const key = duplicateKey(attempt);
    if (key === null) continue;
    const existing = kept.get(key);
    if (!existing) {
      kept.set(key, attempt);
      continue;
    }
    if (datedness(attempt) > datedness(existing)) {
      deletes.push({ id: existing.id, keptId: attempt.id });
      kept.set(key, attempt);
    } else {
      deletes.push({ id: attempt.id, keptId: existing.id });
    }
  }
  const deleted = new Set(deletes.map((entry) => entry.id));
  const finalDeletes = deletes.map((entry) => ({ id: entry.id, keptId: resolveKept(entry.keptId, deletes) }));
  const moveIds = attempts.filter((attempt) => attempt.bookId !== canonicalBookId && !deleted.has(attempt.id)).map((attempt) => attempt.id);
  return { moveIds, deletes: finalDeletes };
}

function resolveKept(id: number, deletes: readonly { id: number; keptId: number }[]): number {
  let current = id;
  for (let hops = 0; hops < deletes.length; hops++) {
    const next = deletes.find((entry) => entry.id === current);
    if (!next) return current;
    current = next.keptId;
  }
  return current;
}

export interface AbsHistoryGroup {
  canonicalBookId: number;
  memberBookIds: number[];
}

export interface AbsHistoryPlanEntry {
  canonicalBookId: number;
  absEndedOn: string;
  replaced: AttemptRow[];
}

/**
 * A work whose canonical book holds a completed Audiobookshelf attempt replaces every completed
 * attempt with origin `migration` on any of its books. Works without such a finish are untouched.
 */
export function planAbsHistoryRebuild(groups: readonly AbsHistoryGroup[], completed: readonly AttemptRow[]): AbsHistoryPlanEntry[] {
  const byBook = new Map<number, AttemptRow[]>();
  for (const attempt of completed) {
    const list = byBook.get(attempt.bookId) ?? [];
    list.push(attempt);
    byBook.set(attempt.bookId, list);
  }
  const plan: AbsHistoryPlanEntry[] = [];
  for (const group of groups) {
    const absFinishes = (byBook.get(group.canonicalBookId) ?? [])
      .filter((attempt) => attempt.origin === 'audiobookshelf' && attempt.endedOn !== null)
      .map((attempt) => attempt.endedOn!)
      .sort();
    if (absFinishes.length === 0) continue;
    const replaced = group.memberBookIds.flatMap((bookId) => (byBook.get(bookId) ?? []).filter((attempt) => attempt.origin === 'migration'));
    plan.push({ canonicalBookId: group.canonicalBookId, absEndedOn: absFinishes[absFinishes.length - 1]!, replaced });
  }
  return plan;
}

export type MirrorSkipReason = 'alignment' | 'read_along_offsets' | null;

/**
 * Pairs a precise sync already owns are left to it: an ebook and audiobook with a ready alignment,
 * and a read-along and audiobook with narration offsets.
 */
export function mirrorSkipReason(
  sourceRole: WorkVariantRole,
  targetRole: WorkVariantRole,
  owned: { alignmentReady: boolean; readAlongOffsets: boolean },
): MirrorSkipReason {
  const pair = new Set([sourceRole, targetRole]);
  if (pair.has('text') && pair.has('audio') && owned.alignmentReady) return 'alignment';
  if (pair.has('readAlong') && pair.has('audio') && owned.readAlongOffsets) return 'read_along_offsets';
  return null;
}

/** The file and offset at a percentage of an audiobook's play order, or null without usable durations. */
export function audioPositionAt(
  files: readonly { id: number; durationSeconds: number | null }[],
  percentage: number,
): { currentFileId: number; positionSeconds: number } | null {
  if (files.length === 0 || files.some((file) => file.durationSeconds == null || file.durationSeconds <= 0)) return null;
  const total = files.reduce((sum, file) => sum + file.durationSeconds!, 0);
  let remaining = (Math.min(100, Math.max(0, percentage)) / 100) * total;
  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const duration = file.durationSeconds!;
    if (remaining < duration || index === files.length - 1) return { currentFileId: file.id, positionSeconds: Math.min(remaining, duration) };
    remaining -= duration;
  }
  return null;
}
