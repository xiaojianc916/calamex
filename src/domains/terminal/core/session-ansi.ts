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
