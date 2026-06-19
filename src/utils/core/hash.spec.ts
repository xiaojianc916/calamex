import { describe, expect, it } from 'vitest';
import { fnv1a32Bytes } from '@/utils/core/hash';

describe('fnv1a32Bytes', () => {
  it('对空字符串返回 offset basis', () => {
    expect(fnv1a32Bytes('')).toBe('811c9dc5');
  });

  it('对 ASCII 输入与标准 FNV-1a 一致', () => {
    // 'a' 的标准 FNV-1a 32 位哈希为 0xe40c292c
    expect(fnv1a32Bytes('a')).toBe('e40c292c');
  });

  it('输出为 8 位小写 hex 且对同一输入稳定', () => {
    const first = fnv1a32Bytes('xiaojianc');
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32Bytes('xiaojianc')).toBe(first);
  });

  it('不同输入产生不同哈希', () => {
    expect(fnv1a32Bytes('foo')).not.toBe(fnv1a32Bytes('bar'));
  });

  it('对非 ASCII 输入按 UTF-8 字节计算', () => {
    expect(fnv1a32Bytes('emoji 😀')).toMatch(/^[0-9a-f]{8}$/);
  });
});
