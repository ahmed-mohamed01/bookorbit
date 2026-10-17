import type { HardcoverAuthorSearchDocument } from '../metadata-fetch/providers/hardcover/hardcover.types';
import { normalizeMonitoredName } from './monitored-text.utils';

/**
 * One Hardcover hit per author name, keeping whichever record carries the most books. Hardcover holds
 * several records for the same author - a populated one and empty stubs - and they all fold onto one
 * key here. Keeping whichever hit the search returned last would hand the monitor a stub's id, and a
 * bibliography fetch pinned to a stub comes back with nothing. This is the same tie-break the
 * bibliography provider applies when it has to resolve the author by name itself.
 */
export function strongestHitPerName(hits: HardcoverAuthorSearchDocument[]): HardcoverAuthorSearchDocument[] {
  const best = new Map<string, HardcoverAuthorSearchDocument>();
  for (const hit of hits) {
    const key = normalizeMonitoredName(hit.name);
    const current = best.get(key);
    if (!current || (hit.books_count ?? 0) > (current.books_count ?? 0)) best.set(key, hit);
  }
  return [...best.values()];
}
