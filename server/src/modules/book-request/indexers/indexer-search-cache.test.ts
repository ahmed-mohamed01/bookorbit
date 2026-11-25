import { describe, expect, it, vi } from 'vitest';

import { findFreshInteractiveResult } from './indexer-search-cache';

describe('findFreshInteractiveResult', () => {
  it('returns null without reading the cache when the key has no interactive false field', () => {
    const cache = new Map<string, never>();
    const get = vi.spyOn(cache, 'get');

    expect(findFreshInteractiveResult(cache, '7:{"overrides":null}')).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
