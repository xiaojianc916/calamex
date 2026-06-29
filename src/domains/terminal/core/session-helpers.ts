/**
 * src/domains/terminal/core/session-helpers.ts
 * TerminalSession 的纯函数 helpers（主题解析、选项构建、诊断辅助）。
 * 从 session.ts 拆分。无类状态依赖。
 */

import { resolveTerminalFontFamily } from '@/constants/terminal';
import { getThemeManager } from '@/themes';
import { buildTerminalTheme } from '@/themes/derive/terminal';
import { dark } from '@/themes/variants/dark';
import { light } from '@/themes/variants/light';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import { toErrorMessage } from '@/utils/error/error';
import { previewTerminalDiagnosticText } from './session-ansi';
import type { TTerminalBellStyle } from './session-constants';
import { DEFAULT_COLS, DEFAULT_ROWS } from './session-constants';

/**
 * 从 ThemeManager 获取当前 xterm 主题；未初始化时返回空对象，由 xterm 使用内置默认色。
 */
export const getXtermTheme = (theme?: TThemeMode) => {
  if (theme === 'light') return buildTerminalTheme(light);
  if (theme === 'dark') return buildTerminalTheme(dark);
  return getThemeManager().getTerminalTheme() ?? {};
};

/** 将值钳制为 [min, max] 范围内的有限整数，否则返回 fallback。 */
export const resolveInteger = (
  value: number | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const integer = Math.trunc(numeric);
  if (!Number.isFinite(integer)) return fallback;
  return Math.min(max, Math.max(min, integer));
};

/** 将 ITerminalSettings.bellMode 映射为内部 bell 风格。 */
export const resolveTerminalBellStyle = (
  bellMode: ITerminalSettings['bellMode'],
): TTerminalBellStyle => {
  switch (bellMode) {
    case 'sound':
      return 'sound';
    case 'flash':
      return 'visual';
    default:
      return 'none';
  }
};

/** 构建 xterm.js Terminal 构造选项对象。 */
export const buildTerminalOptions = (s: ITerminalSettings, theme: TThemeMode) => ({
  allowTransparency: false,
  cols: DEFAULT_COLS,
  convertEol: true,
  cursorBlink: s.cursorBlink,
  cursorStyle: s.cursorStyle,
  drawBoldTextInBrightColors: true,
  fastScrollSensitivity: 1,
  fontFamily: resolveTerminalFontFamily(s.fontFamily),
  fontSize: s.fontSize,
  letterSpacing: 0,
  lineHeight: Number(s.lineHeight),
  rows: DEFAULT_ROWS,
  scrollback: s.scrollback,
  scrollOnUserInput: true,
  scrollSensitivity: 1,
  smoothScrollDuration: 0,
  theme: getXtermTheme(theme),
});

/** 判断终端输入是否为可打印字符（非控制序列）。 */
export const isPrintableTerminalInput = (data: string): boolean => {
  if (data.length === 0) return false;
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
};

/** 将终端输入字符串编码为 Uint8Array 用于诊断上报。 */
export const encodeTerminalInputForDiagnostics = (data: string): Uint8Array => {
  if (typeof TextEncoder === 'undefined') {
    return new Uint8Array();
  }
  return new TextEncoder().encode(data);
};

/** 判断错误是否为交互式通道已关闭错误。 */
export const isInteractiveChannelClosedError = (error: unknown): boolean => {
  const message = toErrorMessage(error, '');
  return (
    message.includes('interactive command channel 已关闭') ||
    message.includes('terminal duplex 已关闭')
  );
};

export { previewTerminalDiagnosticText };
