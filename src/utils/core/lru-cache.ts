/**
 * 有界 LRU cache 辅助函数。
 *
 * 基于 Map 的插入顺序维护 LRU 语义：get 时 delete-then-re-insert 更新访问顺序，
 * set 时超限则淘汰最旧条目。
 */

export const getBoundedCacheValue = <T>(cache: Map<string, T>, key: string): T | undefined => {
  if (!cache.has(key)) {
    return undefined;
  }

  const value = cache.get(key) as T;
  cache.delete(key);
  cache.set(key, value);
  return value;
};

export const setBoundedCacheValue = <T>(
  cache: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): void => {
  if (limit <= 0) {
    cache.clear();
    return;
  }

  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);

  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
};
