import { describe, expect, it } from 'vitest';

import { BoundedTtlCache } from './web-serials-cache.utils';

describe('BoundedTtlCache', () => {
  it('evicts the least recently used entry past the entry limit', () => {
    const cache = new BoundedTtlCache<string, number>(2, 1000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('expires entries after the ttl', () => {
    let now = 0;
    const cache = new BoundedTtlCache<string, number>(5, 100, Infinity, () => now);
    cache.set('a', 1);
    now = 99;
    expect(cache.get('a')).toBe(1);
    now = 100;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts by total weight and refuses a single entry above the budget', () => {
    const cache = new BoundedTtlCache<string, string>(10, 1000, 10);
    cache.set('a', 'x', 6);
    cache.set('b', 'y', 6);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('y');
    cache.set('huge', 'z', 11);
    expect(cache.get('huge')).toBeUndefined();
  });
});
