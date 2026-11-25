import type { ReleaseSearchResult } from '@bookorbit/types';

type CachedSearch = { result: ReleaseSearchResult | null; resultExpiresAt: number };

export function findFreshInteractiveResult(cache: ReadonlyMap<string, CachedSearch>, cacheKey: string): ReleaseSearchResult | null {
  const interactiveKey = cacheKey.replace(/,"interactive":false}$/, ',"interactive":true}');
  if (interactiveKey === cacheKey) return null;

  const entry = cache.get(interactiveKey);
  return entry && entry.resultExpiresAt > Date.now() ? entry.result : null;
}
