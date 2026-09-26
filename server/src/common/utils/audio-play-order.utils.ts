import { basename } from 'node:path';

import { naturalCompare } from './natural-sort.utils';

export type AudioPlayOrderRow = { sortOrder: number | null; absolutePath: string };

/**
 * Deliberate code-move, not new logic: this mirrors upstream's audiobook manifest ordering
 * (`AudiobookService.loadManifestContext` in `audiobook.service.ts` - sortOrder with null last, then
 * `naturalCompare(basename)`). Originally lived only in the reading-alignment module; the Storyteller
 * module needs the identical ordering (absolute audio positions are derived from file order on both
 * sides, so a divergent tiebreak would silently hand either integration the wrong track order), so it
 * moved here as a shared fork util rather than being duplicated or imported across module boundaries.
 */
export function compareAudioPlayOrder(left: AudioPlayOrderRow, right: AudioPlayOrderRow): number {
  if (left.sortOrder !== null || right.sortOrder !== null) {
    const byOrder = (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
    if (byOrder !== 0) return byOrder;
  }
  return naturalCompare(basename(left.absolutePath), basename(right.absolutePath));
}
