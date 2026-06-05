import { describe, expect, it } from 'vitest';
import { createPrefixedId, createUniqueId } from '@/utils/id';

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('createUniqueId', () => {
  it('生成符合 UUID v4 规范的标识符', () => {
    expect(createUniqueId()).toMatch(UUID_V4_PATTERN);
  });

  it('多次生成不重复', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => createUniqueId()));
    expect(ids.size).toBe(1000);
  });
});

describe('createPrefixedId', () => {
  it('保留语义前缀且尾部为 UUID v4', () => {
    const id = createPrefixedId('terminal');
    expect(id.startsWith('terminal-')).toBe(true);
    expect(id.slice('terminal-'.length)).toMatch(UUID_V4_PATTERN);
  });
});
