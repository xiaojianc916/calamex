/**
 * 共享 UTF-8 字节长度度量。
 *
 * 统一使用模块级单例 TextEncoder，避免在热路径（IPC 出入参字节统计、git diff
 * 度量、SSH 预览字节估算等）反复 `new TextEncoder()`。与 utils/core/hash.ts、
 * services/tauri/core/ipc-metrics.ts 的单例口径保持一致。
 */
const UTF8_ENCODER = new TextEncoder();

/** 返回字符串的 UTF-8 字节长度。 */
export const utf8ByteLength = (value: string): number =>
  value.length === 0 ? 0 : UTF8_ENCODER.encode(value).length;
