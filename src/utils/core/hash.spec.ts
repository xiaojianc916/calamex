import { describe, expect, it } from 'vitest';
import { fnv1a32, fnv1a32Base36, fnv1a32Bytes } from '@/utils/core/hash';

describe('hash utils', () => {
  describe('fnv1a32', () => {
    it('对空字符串返回 FNV-1a 32 位 offset basis', () => {
      expect(fnv1a32('')).toBe('811c9dc5');
    });

    it('对 ASCII 输入与标准 FNV-1a 32 位实现一致', () => {
      // 'a' 的标准 FNV-1a 32 位哈希为 0xe40c292c
      expect(fnv1a32('a')).toBe('e40c292c');
    });

    it('输出始终为 8 位小写 hex 且对同一输入稳定', () => {
      const first = fnv1a32('xiaojianc');
      expect(first).toMatch(/^[0-9a-f]{8}$/);
      expect(fnv1a32('xiaojianc')).toBe(first);
    });

    it('不同输入产生不同哈希', () => {
      expect(fnv1a32('foo')).not.toBe(fnv1a32('bar'));
    });
  });

  describe('fnv1a32Base36', () => {
    it('默认补齐到至少 7 位且对同一输入稳定', () => {
      const value = fnv1a32Base36('');
      expect(value.length).toBeGreaterThanOrEqual(7);
      expect(fnv1a32Base36('')).toBe(value);
    });

    it('支持自定义最小补齐长度', () => {
      expect(fnv1a32Base36('x', 12).length).toBeGreaterThanOrEqual(12);
    });

    it('仅使用 base36 字符集', () => {
      expect(fnv1a32Base36('hello world')).toMatch(/^[0-9a-z]+$/);
    });
  });

  describe('fnv1a32Bytes', () => {
    it('对空字符串返回 offset basis', () => {
      expect(fnv1a32Bytes('')).toBe('811c9dc5');
    });

    it('对纯 ASCII 输入与 code-point 版结果一致', () => {
      expect(fnv1a32Bytes('hello')).toBe(fnv1a32('hello'));
    });

    it('对非 ASCII 输入与 code-point 版结果不同（UTF-8 字节 vs code point）', () => {
      expect(fnv1a32Bytes('中文')).not.toBe(fnv1a32('中文'));
    });

    it('输出为 8 位小写 hex', () => {
      expect(fnv1a32Bytes('emoji 😀')).toMatch(/^[0-9a-f]{8}$/);
    });
  });
});
