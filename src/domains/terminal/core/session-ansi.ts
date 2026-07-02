/**
 * src/domains/terminal/core/session-ansi.ts
 * ANSI 转义序列的纯函数工具集。无状态、无副作用（除正则 lastIndex 重置）。
 * 从 session.ts 拆分。
 */

import type { ITerminalDataEvent } from '@/types/terminal';
import {
  TERMINAL_BUFFER_DIAGNOSTIC_PREVIEW_LENGTH,
  TERMINAL_RUN_SEPARATOR_PREFIX,
} from './session-constants';

// ─── ANSI 常量 ─────────────────────────────────────────────────────────────────

const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_ESCAPE_CHARACTER_PATTERN = new RegExp(ANSI_ESCAPE, 'gu');
const ANSI_CSI_HOME_CURSOR_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[(?:\\d{0,4}(?:;\\d{0,4})?)?H`,
  'u',
);
const ANSI_CSI_ERASE_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[(?:\\??\\d{0,4}(?:;\\d{0,4})*)?[JK]`,
  'u',
);
const ANSI_CSI_HIDE_CURSOR_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[\\?25l`, 'u');
const ANSI_ALT_SCREEN_SWITCH_PATTERN = new RegExp(
  `${ANSI_ESCAPE}\\[\\?(?:47|1047|1049)([hl])`,
  'gu',
);

// ─── 导出的 ANSI helpers ──────────────────────────────────────────────────────

/** 去除注入的 run 分隔符标记行（如 `──── run #1 ────`），返回剩余数据。 */
export const stripInjectedRunSeparatorForTerminalData = (data: string): string => {
  const markerIndex = data.indexOf(TERMINAL_RUN_SEPARATOR_PREFIX);
  if (markerIndex < 0) return data;

  const crlfIndex = data.indexOf('\r\n', markerIndex);
  const lfIndex = data.indexOf('\n', markerIndex);
  const separatorEndIndex =
    crlfIndex >= 0 ? crlfIndex + 2 : lfIndex >= 0 ? lfIndex + 1 : data.length;

  return `${data.slice(0, markerIndex)}${data.slice(separatorEndIndex)}`;
};

// ─── 内部 ANSI helpers ─────────────────────────────────────────────────────────

/**
 * 单次扫描即可同时得出：本段数据是否含 alt-screen 切换序列（switched），
 * 以及在 current 基础上应用所有切换后的最终 alt-screen 状态（activeAfter）。
 */
export const scanInteractiveAltScreenSwitch = (
  current: boolean,
  data: string,
): { switched: boolean; activeAfter: boolean } => {
  ANSI_ALT_SCREEN_SWITCH_PATTERN.lastIndex = 0;
  let switched = false;
  let activeAfter = current;
  for (
    let match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data);
    match !== null;
    match = ANSI_ALT_SCREEN_SWITCH_PATTERN.exec(data)
  ) {
    switched = true;
    activeAfter = match[1] === 'h';
  }
  return { switched, activeAfter };
};

/** 检测一段数据是否像交互式程序的 resize-repaint 帧（home cursor + erase + hide cursor）。 */
export const isLikelyInteractiveResizeRepaintFrame = (data: string): boolean =>
  ANSI_CSI_HOME_CURSOR_PATTERN.test(data) &&
  ANSI_CSI_ERASE_PATTERN.test(data) &&
  (ANSI_CSI_HIDE_CURSOR_PATTERN.test(data) || data.includes('\x1b[H'));

/** 将 ANSI 转义字符替换为可读的 `\x1b` 形式，用于诊断预览。 */
export const previewTerminalDiagnosticText = (value: string): string =>
  value
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replace(ANSI_ESCAPE_CHARACTER_PATTERN, '\\x1b')
    .slice(0, TERMINAL_BUFFER_DIAGNOSTIC_PREVIEW_LENGTH);

/** 判断 run 数据帧是否为首次 run 的第一帧。 */
export const isFirstRunChunkFrame = (payload: ITerminalDataEvent): boolean =>
  payload.source === 'run' && typeof payload.runSeq === 'number' && payload.runSeq === 1;
