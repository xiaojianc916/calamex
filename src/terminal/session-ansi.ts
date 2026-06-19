/**
 * src/terminal/session-ansi.ts
 * ANSI 转义序列的纯函数工具集。无状态、无副作用（除正则 lastIndex 重置）。
 * 从 session.ts 拆分。
 */

import type { ITerminalDataEvent, TThemeMode } from '@/types/terminal';
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
const ANSI_SGR_PATTERN = new RegExp(`${ANSI_ESCAPE}\\[([0-9;]*)m`, 'gu');
const ANSI_DEFAULT_FOREGROUND_CODE = 39;
const ANSI_DEFAULT_BACKGROUND_CODE = 49;
const ANSI_EXTENDED_FOREGROUND_CODE = 38;
const ANSI_EXTENDED_BACKGROUND_CODE = 48;
const ANSI_EXTENDED_INDEXED_COLOR_MODE = 5;
const ANSI_EXTENDED_RGB_COLOR_MODE = 2;
const ANSI_LIGHT_THEME_FORCED_FOREGROUND_CODES = new Set([37, 97]);
const ANSI_LIGHT_THEME_FORCED_BACKGROUND_CODES = new Set([40, 100]);

// ─── 导出的 ANSI helpers ──────────────────────────────────────────────────────

/**
 * 在 light 主题下规范化 SGR 序列：将强制亮色前景/背景码替换为默认色，
 * 确保 light 主题终端中文本不被亮色码冲淡。dark 主题原样返回。
 */
export const normalizeTerminalAnsiForTheme = (value: string, theme: TThemeMode): string => {
  if (theme !== 'light' || !value) return value;
  ANSI_SGR_PATTERN.lastIndex = 0;
  return value.replace(ANSI_SGR_PATTERN, (sequence: string, params: string) => {
    const normalizedParams = normalizeSgrParamsForLightTerminal(params);
    return normalizedParams === params ? sequence : `${ANSI_ESCAPE}[${normalizedParams}m`;
  });
};

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

/** 规范化 SGR 参数字符串为 light 终端适配版本。 */
const normalizeSgrParamsForLightTerminal = (params: string): string => {
  if (!params) return params;
  const parts = params.split(';');
  const normalized: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const rawPart = parts[index] ?? '';
    const code = rawPart === '' ? 0 : Number(rawPart);
    if (!Number.isInteger(code)) {
      normalized.push(rawPart);
      continue;
    }

    if (code === ANSI_EXTENDED_FOREGROUND_CODE || code === ANSI_EXTENDED_BACKGROUND_CODE) {
      normalized.push(rawPart);
      const modeRaw = parts[index + 1];
      const mode = modeRaw === undefined || modeRaw === '' ? 0 : Number(modeRaw);
      if (modeRaw !== undefined) {
        normalized.push(modeRaw);
        index += 1;
      }
      if (mode === ANSI_EXTENDED_INDEXED_COLOR_MODE) {
        const colorIndex = parts[index + 1];
        if (colorIndex !== undefined) {
          normalized.push(colorIndex);
          index += 1;
        }
        continue;
      }
      if (mode === ANSI_EXTENDED_RGB_COLOR_MODE) {
        for (let channel = 0; channel < 3; channel += 1) {
          const channelValue = parts[index + 1];
          if (channelValue === undefined) break;
          normalized.push(channelValue);
          index += 1;
        }
        continue;
      }
      continue;
    }

    if (ANSI_LIGHT_THEME_FORCED_FOREGROUND_CODES.has(code)) {
      normalized.push(String(ANSI_DEFAULT_FOREGROUND_CODE));
      continue;
    }
    if (ANSI_LIGHT_THEME_FORCED_BACKGROUND_CODES.has(code)) {
      normalized.push(String(ANSI_DEFAULT_BACKGROUND_CODE));
      continue;
    }
    normalized.push(rawPart);
  }

  return normalized.join(';');
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
