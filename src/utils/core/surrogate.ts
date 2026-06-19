/**
 * UTF-16 代理对检测与跳过辅助。
 *
 * 多处代码（document-metrics.ts、agent-sidecar/text-metrics.ts、
 * terminal-output-buffer.ts）各自手写了相同的 charCodeAt + surrogate range check。
 * 此处提供共享实现，消除重复。
 */

/**
 * 检查指定位置是否是高位代理项（high surrogate, 0xD800..0xDBFF）。
 * 如果是且下一个 code unit 是低位代理项，返回 true（表示应跳过下一个 unit）。
 */
export const isHighSurrogateAt = (value: string, index: number): boolean => {
  const code = value.charCodeAt(index);
  return (
    code >= 0xd800 &&
    code <= 0xdbff &&
    index + 1 < value.length &&
    value.charCodeAt(index + 1) >= 0xdc00 &&
    value.charCodeAt(index + 1) <= 0xdfff
  );
};

/**
 * 检查指定位置是否是低位代理项（low surrogate, 0xDC00..0xDFFF）。
 * 用于在截断点检测不完整的代理对（如 terminal-output-buffer 的 trimLeadingCodeUnitBoundary）。
 */
export const isLowSurrogateAt = (value: string, index: number): boolean => {
  if (index >= value.length) return false;
  const code = value.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
};

/**
 * 如果 index 处是一个完整的代理对，返回 2（跳过低位代理）；否则返回 1。
 * 用于 charCodeAt 遍历中的 index 前进。
 */
export const surrogatePairStep = (value: string, index: number): 1 | 2 =>
  isHighSurrogateAt(value, index) ? 2 : 1;
