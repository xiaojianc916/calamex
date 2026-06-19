import {
  CODEMIRROR_LANGUAGE_LABELS,
  FILE_LANGUAGE_BY_EXTENSION,
  resolveCodeMirrorLanguageId,
} from '@/services/editor/codemirror-language';
import { computeDocumentMetrics } from '@/utils/editor/document-metrics';
import { splitTextGraphemes } from '@/utils/file/text-preview';

export type TSshPreviewEncoding = 'utf-8' | 'utf-8-bom';
export type TSshPreviewLineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';

export interface ISshPreviewLanguageInfo {
  codeMirrorLanguage: string;
  label: string;
}

export interface ISshPreviewMatchRange {
  start: number;
  end: number;
}

export interface ISshPreviewMatchHit extends ISshPreviewMatchRange {
  lineIndex: number;
  lineCodeUnitStart: number;
  lineCodeUnitEnd: number;
  globalStart: number;
  globalEnd: number;
}

const LINE_ENDING_LABEL_MAP: Readonly<Record<TSshPreviewLineEnding, string>> = {
  lf: 'LF',
  crlf: 'CRLF',
  cr: 'CR',
  mixed: 'Mixed',
  none: '无',
};

// 注意：workspace.ts 的 normalizeWorkspaceQuery 仅做 trim + toLocaleLowerCase（无 NFC）。
// 两处语义不同（搜索图素 vs 工作区查询），如需统一请抽到 utils/file/text/normalize.ts。
const normalizeSearchGrapheme = (value: string): string =>
  value.normalize('NFC').toLocaleLowerCase('zh-CN');

const resolveFileExtension = (path: string): string => {
  const normalized = path.trim().toLowerCase().split(/[?#]/u, 1)[0] ?? '';
  const fileName = normalized.split(/[\\/]/u).at(-1) ?? normalized;

  if (fileName === 'dockerfile') {
    return 'dockerfile';
  }

  if (!fileName.includes('.')) {
    return '';
  }

  return fileName.split('.').at(-1) ?? '';
};

/**
 * 行结束符归一化：将 CRLF 和 lone CR 统一为 LF。
 * 跨语言约定：Rust 侧 src-tauri/src/commands/shell_tools.rs 的
 * normalize_shellcheck_content 做完全相同的操作，修改时请同步两端。
 */
export const normalizeSshPreviewContent = (value: string): string =>
  value.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n');

export const formatSshPreviewLineEnding = (value: TSshPreviewLineEnding): string =>
  LINE_ENDING_LABEL_MAP[value];

export const formatSshPreviewEncoding = (value: TSshPreviewEncoding): string =>
  value === 'utf-8-bom' ? 'UTF-8 BOM' : 'UTF-8';

export const resolveSshPreviewLanguageInfo = (path: string): ISshPreviewLanguageInfo => {
  const extension = resolveFileExtension(path);
  const codeMirrorLanguage = resolveCodeMirrorLanguageId(
    FILE_LANGUAGE_BY_EXTENSION[extension] ?? 'text',
  );

  return {
    codeMirrorLanguage,
    label: CODEMIRROR_LANGUAGE_LABELS[codeMirrorLanguage] ?? codeMirrorLanguage,
  };
};

export const formatSshPreviewModifiedAt = (value: string | null): string => {
  if (!value) {
    return '—';
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return '—';
  }

  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date(timestamp))
    .replace(/\//gu, '-');
};

export const countSshPreviewLines = (value: string): number =>
  computeDocumentMetrics(normalizeSshPreviewContent(value)).lineCount;

export const resolveSshPreviewCursorPosition = (
  textBeforeCursor: string,
): { line: number; column: number } => {
  const normalized = normalizeSshPreviewContent(textBeforeCursor);
  const lines = normalized.split('\n');
  const currentLine = lines.at(-1) ?? '';

  return {
    line: lines.length,
    column: splitTextGraphemes(currentLine).length + 1,
  };
};

export const buildSshPreviewMatchRanges = (
  line: string,
  query: string,
): ISshPreviewMatchRange[] => {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const lineGraphemes = splitTextGraphemes(line);
  const queryGraphemes = splitTextGraphemes(normalizedQuery);
  if (queryGraphemes.length === 0 || queryGraphemes.length > lineGraphemes.length) {
    return [];
  }

  const normalizedLineGraphemes = lineGraphemes.map(normalizeSearchGrapheme);
  const normalizedQueryGraphemes = queryGraphemes.map(normalizeSearchGrapheme);
  const matches: ISshPreviewMatchRange[] = [];

  for (
    let start = 0;
    start <= normalizedLineGraphemes.length - normalizedQueryGraphemes.length;
    start += 1
  ) {
    let matched = true;

    for (let offset = 0; offset < normalizedQueryGraphemes.length; offset += 1) {
      if (normalizedLineGraphemes[start + offset] !== normalizedQueryGraphemes[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) {
      matches.push({
        start,
        end: start + normalizedQueryGraphemes.length,
      });
    }
  }

  return matches;
};

const buildGraphemeCodeUnitOffsets = (value: string): number[] => {
  const graphemes = splitTextGraphemes(value);
  const offsets = [0];
  let currentOffset = 0;

  for (const grapheme of graphemes) {
    currentOffset += grapheme.length;
    offsets.push(currentOffset);
  }

  return offsets;
};

export const buildSshPreviewMatchHits = (content: string, query: string): ISshPreviewMatchHit[] => {
  const normalizedContent = normalizeSshPreviewContent(content);
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return [];
  }

  const lines = normalizedContent.split('\n');
  const hits: ISshPreviewMatchHit[] = [];
  let documentOffset = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    const ranges = buildSshPreviewMatchRanges(line, normalizedQuery);
    const codeUnitOffsets = buildGraphemeCodeUnitOffsets(line);

    for (const range of ranges) {
      const lineCodeUnitStart = codeUnitOffsets[range.start] ?? 0;
      const lineCodeUnitEnd = codeUnitOffsets[range.end] ?? line.length;

      hits.push({
        lineIndex,
        start: range.start,
        end: range.end,
        lineCodeUnitStart,
        lineCodeUnitEnd,
        globalStart: documentOffset + lineCodeUnitStart,
        globalEnd: documentOffset + lineCodeUnitEnd,
      });
    }

    documentOffset += line.length;
    if (lineIndex < lines.length - 1) {
      documentOffset += 1;
    }
  }

  return hits;
};

export const estimateSshPreviewByteSize = (
  content: string,
  encoding: TSshPreviewEncoding,
  lineEnding: TSshPreviewLineEnding,
): number => {
  const normalizedLineFeed = normalizeSshPreviewContent(content);
  const normalized = (() => {
    if (lineEnding === 'crlf') {
      return normalizedLineFeed.replace(/\n/gu, '\r\n');
    }
    if (lineEnding === 'cr') {
      return normalizedLineFeed.replace(/\n/gu, '\r');
    }

    return normalizedLineFeed;
  })();

  const textEncoder = new TextEncoder();
  const bomSize = encoding === 'utf-8-bom' ? 3 : 0;

  return textEncoder.encode(normalized).length + bomSize;
};
