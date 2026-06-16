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
  // for...of 比 indexed loop 慢；但要正确处理 surrogate pair 又不破坏既有 hash 值，
  // 这里保留 code-point 语义。如需更快路径，使用 fnv1a32Bytes 走 UTF-8。
  for (const char of value) {
    // codePointAt 在 for...of 产生的非空字符串上必返回 number，无需 ?? 兜底。
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
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

// --- 跨端标准版（新增，不替换上面任何函数） ---------------------------------

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
