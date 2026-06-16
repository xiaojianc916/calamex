import { describe, expect, it } from 'vitest';
import { parseCssColorToRgba, readCssVarAsRgba } from './color';

describe('parseCssColorToRgba', () => {
  it('解析 HEX 与 alpha 通道', () => {
    expect(parseCssColorToRgba('#0a0b0cff')).toEqual({
      r: 10,
      g: 11,
      b: 12,
      a: 255,
    });
  });

  it('解析 RGB 颜色（含透明度）', () => {
    expect(parseCssColorToRgba('rgba(255, 0, 0, 0.5)')).toEqual({
      r: 255,
      g: 0,
      b: 0,
      a: 128,
    });
  });

  it('解析 OKLCH 灰阶颜色', () => {
    expect(parseCssColorToRgba('oklch(0.145 0 0)')).toEqual({
      r: 10,
      g: 10,
      b: 10,
      a: 255,
    });
  });

  it('解析 color(srgb ...) 颜色', () => {
    expect(parseCssColorToRgba('color(srgb 0.04 0.04 0.05 / 1)')).toEqual({
      r: 10,
      g: 10,
      b: 13,
      a: 255,
    });
  });

  it('读取 CSS 变量并转为 RGBA', () => {
    document.documentElement.style.setProperty('--background', '#010203');
    expect(readCssVarAsRgba('--background')).toEqual({
      r: 1,
      g: 2,
      b: 3,
      a: 255,
    });
  });
});
