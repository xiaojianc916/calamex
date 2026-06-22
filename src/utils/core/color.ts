import { parse, sRGB } from '@texel/color';
import { clamp } from './math';

export interface IRgbaColor {
  /** 红色通道，0-255 整数。 */
  r: number;
  /** 绿色通道，0-255 整数。 */
  g: number;
  /** 蓝色通道，0-255 整数。 */
  b: number;
  /** 透明度通道，0-255 整数（255 = 完全不透明）。 */
  a: number;
}

const toByte = (value: number): number => Math.round(clamp(value, 0, 1) * 255);

/**
 * 将 CSS 颜色字符串解析为 RGBA 字节值（0-255）。
 * 支持 hex、rgb/rgba、hsl/hsla、lab/lch、oklab/oklch、color() 等所有
 * CSS Color Level 4 语法。
 *
 * 注意：宽色域颜色（如 oklch、display-p3）会被 clamp 到 sRGB 范围，
 * 可能产生轻微偏色。
 *
 * @throws 当输入为空字符串或 `@texel/color` 无法解析时抛错。
 */
export const parseCssColorToRgba = (value: string): IRgbaColor => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`parseCssColorToRgba: 颜色值为空 (raw=${JSON.stringify(value)})`);
  }

  let vec: ArrayLike<number>;
  try {
    vec = parse(trimmed, sRGB);
  } catch (cause) {
    throw new Error(`parseCssColorToRgba: 无法解析颜色 "${trimmed}"`, { cause });
  }

  const [r, g, b, a = 1] = vec as [number, number, number, number?];
  return {
    r: toByte(r),
    g: toByte(g),
    b: toByte(b),
    a: toByte(a),
  };
};

/**
 * 从 CSS 自定义属性读取颜色并解析为 RGBA 字节值。
 *
 * 在非浏览器环境下调用时，必须显式传入 `element`，否则会抛错而不是
 * 抛出 `document is not defined` 这类难以排查的错误。
 *
 * @param name    CSS 自定义属性名，必须以 `--` 开头。
 * @param element 读取计算样式的目标元素，默认 `document.documentElement`。
 *
 * @throws 当所处环境无 DOM、变量未定义或值为空时抛错。
 */
export const readCssVarAsRgba = (name: `--${string}`, element?: Element): IRgbaColor => {
  const target = element ?? (typeof document !== 'undefined' ? document.documentElement : null);

  if (!target) {
    throw new Error(`readCssVarAsRgba: 当前环境无 DOM，必须显式传入 element (name=${name})`);
  }

  const raw = getComputedStyle(target).getPropertyValue(name);
  if (!raw.trim()) {
    throw new Error(`readCssVarAsRgba: CSS 变量 ${name} 未定义或值为空`);
  }

  return parseCssColorToRgba(raw);
};
