import { describe, expect, it } from 'vitest';
import { getBoundedCacheValue, setBoundedCacheValue } from '../useWorkspacePathSuggestions';

describe('bounded workspace path suggestion cache', () => {
  it('evicts the least recently used entry when the cache exceeds the limit', () => {
    const cache = new Map<string, number>();

    setBoundedCacheValue(cache, 'a', 1, 2);
    setBoundedCacheValue(cache, 'b', 2, 2);
    setBoundedCacheValue(cache, 'c', 3, 2);

    expect([...cache.keys()]).toEqual(['b', 'c']);
    expect(getBoundedCacheValue(cache, 'a')).toBeUndefined();
  });

  it('touches a cache hit so a recently reused entry is retained', () => {
    const cache = new Map<string, number>();

    setBoundedCacheValue(cache, 'a', 1, 2);
    setBoundedCacheValue(cache, 'b', 2, 2);
    expect(getBoundedCacheValue(cache, 'a')).toBe(1);
    setBoundedCacheValue(cache, 'c', 3, 2);

    expect([...cache.keys()]).toEqual(['a', 'c']);
    expect(getBoundedCacheValue(cache, 'b')).toBeUndefined();
  });

  it('keeps only the latest value when an existing key is updated', () => {
    const cache = new Map<string, number>();

    setBoundedCacheValue(cache, 'a', 1, 2);
    setBoundedCacheValue(cache, 'b', 2, 2);
    setBoundedCacheValue(cache, 'a', 10, 2);

    expect([...cache.entries()]).toEqual([
      ['b', 2],
      ['a', 10],
    ]);
  });
});
