/**
 * 通用数学工具。
 */

/**
 * 将数值限制在 [min, max] 区间内。
 */
export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
