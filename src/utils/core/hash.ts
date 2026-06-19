/**
 * FNV-1a 32-bit 哈希工具。
 *
 * 提供两类变体：
 *  - code-point 变体（fnv1a32 / fnv1a32Base36）：按 Unicode code point 计算，
 *    仅用于**前端会话内**的去重 / 引用 key，对非 ASCII 输入与标准字节版不可互操作。
 *  - 标准字节版（fnv1a32Bytes）：按 UTF-8 字节计算，可与 Rust/Python/Go 等后端严格对齐。
 */

/**
 * FNV-1a 32-bit 核心计算（按 Unicode code point 变体）。
 *
 * ⚠️ 注意：标准 FNV-1a 按字节哈希；本实现按 Unicode code point（21-bit 整数）
 * 进行 XOR。对纯 ASCII 输入结果与标准版一致；对包含非 ASCII 字符（中文、emoji 等）
 * 的输入，结果与其他语言/库的标准字节 FNV-1a 不可互操作。
 *
 * 仅用于**前端会话内**的去重 / 引用 key；若需跨端（如与 Rust/Python 端对齐 hash），
 * 请改用 {@link fnv1a32Bytes}。
 *
 * @returns 0..=0xFFFFFFFF 的无符号 32-bit 整数
 */
const computeFnv1a32CodePoints = (value: string): number => {
  let hash = 0x811c9dc5;
  // 索引遍历替代 for...of：避免字符串迭代器协议开销与逐 code point 子串分配。
  // 通过 codePointAt + 跳过低位代理项保持 code-point 语义，hash 输出与旧实现逐位一致。
  for (let i = 0; i < value.length; i += 1) {
    const codePoint = value.codePointAt(i)!;
    hash ^= codePoint;
    hash = Math.imul(hash, 0x01000193);
    if (codePoint > 0xffff) {
      // 完整 surrogate pair：跳过其低位代理项，避免重复计入。
      i += 1;
    }
  }
  return hash >>> 0;
};

/**
 * FNV-1a 32-bit 哈希（code-point 变体），输出 8 位 hex。
 *
 * 用途：会话内去重 / 引用 key（非加密哈希）。
 * 不可互操作性参见 {@link computeFnv1a32CodePoints} 的说明。
 */
export const fnv1a32 = (value: string): string =>
  computeFnv1a32CodePoints(value).toString(16).padStart(8, '0');

/**
 * FNV-1a 32-bit（code-point 变体），以 base36 输出固定长度字符串。
 *
 * @param padLength 输出最小字符数（默认 7；32-bit 无符号上限正好是 7 位 base36）。
 */
export const fnv1a32Base36 = (value: string, padLength = 7): string =>
  computeFnv1a32CodePoints(value).toString(36).padStart(padLength, '0');

// --- 跨端标准版（保留，不替换上面任何函数） ---------------------------------

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
