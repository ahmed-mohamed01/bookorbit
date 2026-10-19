import { IndexerSearchException } from '../indexers/indexer-adapter';
import { HttpException } from '@nestjs/common';
import type { ReleaseCandidateItem, ReleaseInspectionRanking } from '@bookorbit/types';

export class InspectionRefusal extends HttpException {
  constructor(readonly reason: 'timeout' | 'challenge' | 'http') {
    super(`Release inspection refused: ${reason}`, reason === 'timeout' ? 408 : 403);
  }
}

export function inspectionRefusal(error: unknown): InspectionRefusal | null {
  if (error instanceof InspectionRefusal) return error;
  if (error instanceof IndexerSearchException && (error.failure === 'throttled' || error.failure === 'unauthorized'))
    return new InspectionRefusal('http');
  if (error instanceof HttpException && [429, 403].includes(error.getStatus())) return new InspectionRefusal('http');
  const message = error instanceof Error ? error.message : '';
  if (typeof error === 'object' && error !== null && 'status' in error && [429, 403].includes(Number(error.status)))
    return new InspectionRefusal('http');
  if (error instanceof Error && (/timeout|abort/i.test(error.name) || /timed? out|in time/i.test(message))) return new InspectionRefusal('timeout');

  return null;
}

export async function sweepUnknownReleases(input: {
  ranked: ReleaseCandidateItem[];
  minScore: number;
  inspect: (release: ReleaseCandidateItem) => Promise<ReleaseInspectionRanking | null>;
  limit?: number;
  concurrency?: number;
  alreadyInspected?: ReadonlySet<string>;
  consecutiveTimeouts?: number;
}): Promise<{
  releases: ReleaseCandidateItem[];
  inspected: number;
  promoted: number;
  inspectedKeys: string[];
  consecutiveTimeouts: number;
  stoppedBy: 'tier' | 'exhausted' | 'ceiling' | 'refused';
}> {
  const releases = [...input.ranked];
  const seen = new Set(input.alreadyInspected);
  const inspectedKeys: string[] = [];
  const candidates = releases
    .filter((r) => {
      const key = `${r.indexerId}:${r.guid}`;
      if (!r.inspectionWanted || r.score < input.minScore || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score || (b.seeders ?? -1) - (a.seeders ?? -1));
  const limit = Math.max(0, Math.min(20, input.limit ?? 20));
  const concurrency = Math.max(1, Math.min(2, input.concurrency ?? 2));
  let inspected = 0;
  let promoted = 0;
  let timeouts = input.consecutiveTimeouts ?? 0;
  let stoppedBy: 'tier' | 'refused' | undefined;
  // Probe the best candidate first so a top-tier answer needs only one fetch.
  while (inspected < Math.min(limit, candidates.length) && !stoppedBy) {
    const width = inspected === 0 ? 1 : concurrency;
    const batch = candidates.slice(inspected, Math.min(inspected + width, limit));
    const results = await Promise.all(
      batch.map(async (release) => {
        try {
          return { release, ranking: await input.inspect(release), error: null };
        } catch (error) {
          return { release, ranking: null, error };
        }
      }),
    );
    for (const { release, ranking, error } of results) {
      inspected++;
      inspectedKeys.push(`${release.indexerId}:${release.guid}`);
      const refusal = inspectionRefusal(error);
      timeouts = refusal?.reason === 'timeout' ? timeouts + 1 : 0;
      if (refusal && (refusal.reason !== 'timeout' || timeouts >= 2)) stoppedBy = 'refused';
      if (!ranking) continue;
      const improved = ranking.tier !== null && (release.tier === null || ranking.tier < release.tier);
      releases[releases.indexOf(release)] = { ...release, ...ranking };
      if (improved) {
        promoted++;
        if (ranking.tier === 0 && stoppedBy !== 'refused') stoppedBy = 'tier';
      }
    }
  }
  return {
    releases,
    inspected,
    promoted,
    inspectedKeys,
    consecutiveTimeouts: timeouts,
    stoppedBy: stoppedBy ?? (inspected < candidates.length ? 'ceiling' : 'exhausted'),
  };
}
