import type { Artifact, VisibleTerm } from './model';
import { termKey } from './text-utils';

const voteIndexes = new WeakMap<Artifact, Map<string, number[]>>();

export function modelVotedFor(artifact: Artifact, term: VisibleTerm, cutoff: number): boolean {
  if (!artifact.modelVotes?.length) return false;
  let index = voteIndexes.get(artifact);
  if (!index) {
    index = new Map(artifact.modelVotes.map(({ key, deltas }) => [key, deltas]));
    voteIndexes.set(artifact, index);
  }

  const keys = new Set([term.key, termKey(term.displayName), ...term.aliases.map(termKey)]);
  let count = 0;
  for (const key of keys) {
    const deltas = index.get(key);
    if (!deltas?.length || deltas[0] > cutoff) continue;
    if (++count === 2 || (deltas.length > 1 && deltas[0] + deltas[1] <= cutoff)) return true;
  }
  return false;
}
