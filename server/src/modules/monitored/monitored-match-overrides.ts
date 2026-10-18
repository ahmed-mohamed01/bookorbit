import { createHash } from 'node:crypto';

import { normalizeWorkToken, type MonitoredFormat, type MonitoredWork } from '@bookorbit/types';

import type { MonitoredMatchOverrideRow } from './schema/monitored.schema';

/** What the owner has said about one format of one work. */
export interface FormatMatchOverride {
  /** The book the owner linked by hand, which beats whatever the matcher finds. */
  linkedBookId: number | null;
  /** Books the owner said are not this work's, kept from matching and from being offered again. */
  rejected: Set<number>;
}

export type WorkMatchOverrides = Record<MonitoredFormat, FormatMatchOverride>;

export function emptyWorkMatchOverrides(): WorkMatchOverrides {
  return { ebook: { linkedBookId: null, rejected: new Set() }, audiobook: { linkedBookId: null, rejected: new Set() } };
}

/**
 * The keys an answer is filed under: the work's provider ids, which survive a refresh that gives the
 * book a new work id. Only a work no provider identifies falls back to its title, because two
 * same-titled works with ids of their own must not share each other's answers.
 */
export function matchIdentityKeys(work: Pick<MonitoredWork, 'providerWorkIds' | 'title'>): string[] {
  const providerKeys = Object.entries(work.providerWorkIds)
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([source, id]) => `${source}:${id}`)
    .sort();
  if (providerKeys.length > 0) return providerKeys;
  return [`title:${createHash('sha256').update(normalizeWorkToken(work.title)).digest('hex')}`];
}

/**
 * Folds the stored answers for one work into a decision per format. A newer link wins over an older
 * one filed under another of the work's keys, and a rejection of the linked book drops the link.
 */
export function resolveWorkMatchOverrides(
  work: Pick<MonitoredWork, 'providerWorkIds' | 'title'>,
  rows: readonly MonitoredMatchOverrideRow[],
): WorkMatchOverrides {
  const result = emptyWorkMatchOverrides();
  const keys = new Set(matchIdentityKeys(work));
  const relevant = rows.filter((row) => keys.has(row.identityKey)).sort((a, b) => a.decidedAt.getTime() - b.decidedAt.getTime());
  for (const row of relevant) {
    const format = result[row.format];
    if (row.decision === 'link') {
      format.linkedBookId = row.bookId;
      format.rejected.delete(row.bookId);
    } else {
      format.rejected.add(row.bookId);
      if (format.linkedBookId === row.bookId) format.linkedBookId = null;
    }
  }
  return result;
}
