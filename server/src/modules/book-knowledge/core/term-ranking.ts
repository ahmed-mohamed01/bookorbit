import { visibleTerms } from './artifact';
import type { Artifact } from './model';
import { rankVisibleTerms, type RankedTerm } from './rank-visible-terms';

export type { RankedTerm } from './rank-visible-terms';

export function rankTerms(artifact: Artifact, cutoff: number, bodyOnly = false): RankedTerm[] {
  return rankVisibleTerms(artifact, visibleTerms(artifact, cutoff, bodyOnly), cutoff);
}
