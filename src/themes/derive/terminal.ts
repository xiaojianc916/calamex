/**
 * Deriver: Terminal (xterm.js) Theme
 *
 * 从 L2 Roles 构造 xterm.js ITheme 对象。
 * 纯函数：相同输入 → 完全相同输出。
 *
 * 规则：
 *  - 仅接受 IRoles，不 import primitives，不写颜色字面量
 *  - terminal.* namespace 直接来自 IRoles.terminal（L2 已完整归纳所有 ANSI 颜色）
 */
import type { IRoles } from '../tokens/types';

/** xterm.js ITheme 的精简定义（避免强依赖 @xterm/xterm 类型包） */
export interface IXtermTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
  scrollbarSliderBackground?: string;
  scrollbarSliderHoverBackground?: string;
  scrollbarSliderActiveBackground?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

/**
 * 构造 xterm.js 主题对象。
 * roles.terminal 包含完整的终端颜色定义，此函数直接映射。
 */
export function buildTerminalTheme(roles: IRoles): IXtermTheme {
  const t = roles.terminal;

  return {
    background: t.background,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.cursorAccent,
    selectionBackground: t.selectionBackground,
    scrollbarSliderBackground: t.scrollbarBackground,
    scrollbarSliderHoverBackground: t.scrollbarHoverBackground,
    scrollbarSliderActiveBackground: t.scrollbarActiveBackground,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  };
}
