/**
 * FNV-1a 32-bit 哈希——标准 UTF-8 字节版。
 *
 * 原先的 code-point 变体（`fnv1a32` / `fnv1a32Base36`）已移除：
 * 项目内仅 hash.spec.ts 在测试它们，无生产使用方。
 * code-point 变体与标准字节版对非 ASCII 输入结果不同，不可互操作，
 * 容易引发跨端 hash 不匹配的 bug。现在统一只用标准字节版。
 */
const UTF8_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : undefined;

/**
 * 标准 FNV-1a 32-bit 哈希（按 **UTF-8 字节**），结果与其他语言/库的标准实现一致。
 *
 * 当你需要前端 hash 与 Rust/Python/Go 等后端 hash 严格匹配时使用本函数。
 * 输出为 8 位小写 hex。
 *
 * @throws 在没有 TextEncoder 的极小环境下抛错。
 */
export const fnv1a32Bytes = (value: string): string => {
  if (!UTF8_ENCODER) {
    throw new Error('fnv1a32Bytes: 当前环境缺少 TextEncoder');
  }
  const bytes = UTF8_ENCODER.encode(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};
