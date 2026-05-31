import { describe, expect, it } from 'vitest';

import { createUniqueId } from './id';

describe('createUniqueId', () => {
  it('生成带语义前缀的 ID', () => {
    expect(createUniqueId('document').startsWith('document-')).toBe(true);
    expect(createUniqueId('ai-thread').startsWith('ai-thread-')).toBe(true);
  });

  it('多次生成的 ID 互不相同', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createUniqueId('log')));
    expect(ids.size).toBe(1000);
  });
});
