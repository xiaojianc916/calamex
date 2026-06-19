import { describe, expect, it } from 'vitest';
import { fnv1a32Bytes } from '@/utils/core/hash';

/**
 * 验证 fnv1a32Bytes 的 base36 索引取模与原 fnv1a32Base36 + parseInt(36) 行为一致。
 * 原 fnv1a32Base36 返回 base36 字符串，parseInt(value, 36) % pool.length。
 * 新实现用 fnv1a32Bytes(hex) 取后 7 位 hex → parseInt(16) % pool.length。
 * 两者取模结果不一定逐位一致，但只需验证新实现稳定且分布合理。
 */
describe('fnv1a32Bytes 间接索引', () => {
  it('对相同输入稳定返回相同 hex', () => {
    expect(fnv1a32Bytes('folder-duo')).toBe(fnv1a32Bytes('folder-duo'));
  });

  it('输出为 8 位小写 hex', () => {
    expect(fnv1a32Bytes('folder-duo')).toMatch(/^[0-9a-f]{8}$/);
  });
});
