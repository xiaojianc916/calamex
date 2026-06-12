import { toErrorMessage } from '@/utils/error';
import type {
  IHighlightedSegment,
  IReplacementLineSegment,
  ISearchMatcher,
} from './search-sidebar.types';

const COMPACT_PREVIEW_ELLIPSIS = '…';

export interface ICreateSearchMatcherOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  useStructural: boolean;
}

// 单词字符定义需与后端一致：后端 grep_regex 的 .word(true) 使用 Unicode \b（\w：
// 字母、数字、下划线，含 CJK 等表意文字），连字符属于「非单词字符」。早期把 '-'
// 当作单词字符，会让前端全字高亮边界与后端命中范围不一致（如 "foo-bar" 中的 "foo"
// 后端命中、前端却判为非边界而不高亮）。
const isWordCharacter = (value: string | undefined): boolean =>
  typeof value === 'string' && /[A-Za-z0-9_\u4E00-\u9FFF]/u.test(value);

const isBoundaryWhitespace = (value: string): boolean => /^\s$/u.test(value);

export const trimBoundaryWhitespaceWithRange = (
  value: string,
  range: [number, number] | null,
): { text: string; range: [number, number] | null } => {
  const characters = Array.from(value);
  let startIndex = 0;
  let endIndex = characters.length;

  while (startIndex < endIndex && isBoundaryWhitespace(characters[startIndex] ?? '')) {
    startIndex += 1;
  }

  while (endIndex > startIndex && isBoundaryWhitespace(characters[endIndex - 1] ?? '')) {
    endIndex -= 1;
  }

  if (!range) {
    return {
      text: characters.slice(startIndex, endIndex).join(''),
      range: null,
    };
  }

  const [matchStart, matchEnd] = range;
  const safeStart = Math.max(0, Math.min(matchStart, characters.length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, characters.length));
  const visibleStart = Math.max(safeStart, startIndex);
  const visibleEnd = Math.min(safeEnd, endIndex);

  return {
    text: characters.slice(startIndex, endIndex).join(''),
    range:
      visibleStart < visibleEnd
        ? ([visibleStart - startIndex, visibleEnd - startIndex] as [number, number])
        : null,
  };
};

export const trimBoundaryWhitespace = (value: string): string =>
  trimBoundaryWhitespaceWithRange(value, null).text;

export const splitPatternList = (value: string): string[] =>
  value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);

export const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const collectPlainMatchRanges = (
  value: string,
  query: string,
  caseSensitive: boolean,
  fullWord: boolean,
): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];

  if (!query) {
    return ranges;
  }

  // 直接在原串上用大小写不敏感正则匹配，避免 toLocaleLowerCase()
  // 在某些语言环境下改变字符串长度，导致高亮区间相对原串发生偏移。
  let pattern: RegExp;
  try {
    pattern = new RegExp(escapeRegExp(query), caseSensitive ? 'gu' : 'giu');
  } catch {
    return ranges;
  }

  let nextMatch = pattern.exec(value);
  while (nextMatch) {
    const matchedValue = nextMatch[0] ?? '';
    if (!matchedValue) {
      pattern.lastIndex += 1;
      nextMatch = pattern.exec(value);
      continue;
    }

    const startIndex = nextMatch.index;
    const endIndex = startIndex + matchedValue.length;
    const beforeCharacter = value[startIndex - 1];
    const afterCharacter = value[endIndex];
    const passesWordBoundary =
      !fullWord || (!isWordCharacter(beforeCharacter) && !isWordCharacter(afterCharacter));

    if (passesWordBoundary) {
      ranges.push([startIndex, endIndex]);
    }

    nextMatch = pattern.exec(value);
  }

  pattern.lastIndex = 0;
  return ranges;
};

const collectRegExpMatchRanges = (value: string, pattern: RegExp): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  pattern.lastIndex = 0;

  let nextMatch = pattern.exec(value);
  while (nextMatch) {
    const matchedValue = nextMatch[0] ?? '';
    if (!matchedValue) {
      pattern.lastIndex += 1;
      nextMatch = pattern.exec(value);
      continue;
    }

    ranges.push([nextMatch.index, nextMatch.index + matchedValue.length]);
    nextMatch = pattern.exec(value);
  }

  pattern.lastIndex = 0;
  return ranges;
};

export const buildHighlightedSegments = (
  value: string,
  ranges: Array<[number, number]>,
): IHighlightedSegment[] => {
  if (ranges.length === 0) {
    return [{ text: value, matched: false }];
  }

  const segments: IHighlightedSegment[] = [];
  let previousIndex = 0;

  for (const [startIndex, endIndex] of ranges) {
    if (startIndex > previousIndex) {
      segments.push({ text: value.slice(previousIndex, startIndex), matched: false });
    }

    segments.push({ text: value.slice(startIndex, endIndex), matched: true });
    previousIndex = endIndex;
  }

  if (previousIndex < value.length) {
    segments.push({ text: value.slice(previousIndex), matched: false });
  }

  return segments.filter((segment) => segment.text.length > 0);
};

export const buildCompactHighlightedSegments = (
  value: string,
  range: [number, number] | null,
  contextSize: number,
): IHighlightedSegment[] => {
  if (!range) {
    return [{ text: value, matched: false }];
  }

  const characters = Array.from(value);
  const [matchStart, matchEnd] = range;
  const safeStart = Math.max(0, Math.min(matchStart, characters.length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, characters.length));
  const previewStart = Math.max(0, safeStart - contextSize);
  const previewEnd = Math.min(characters.length, safeEnd + contextSize);
  const prefixText = `${previewStart > 0 ? COMPACT_PREVIEW_ELLIPSIS : ''}${characters
    .slice(previewStart, safeStart)
    .join('')}`;
  const matchText = characters.slice(safeStart, safeEnd).join('');
  const suffixText = `${characters.slice(safeEnd, previewEnd).join('')}${
    previewEnd < characters.length ? COMPACT_PREVIEW_ELLIPSIS : ''
  }`;
  const segments: IHighlightedSegment[] = [];

  if (prefixText) {
    segments.push({ text: prefixText, matched: false });
  }

  if (matchText) {
    segments.push({ text: matchText, matched: true });
  }

  if (suffixText) {
    segments.push({ text: suffixText, matched: false });
  }

  return segments.filter((segment) => segment.text.length > 0);
};

export const getFileName = (relativePath: string): string => {
  const normalizedPath = relativePath.replace(/\\/gu, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments.at(-1) ?? relativePath;
};

export const getParentPath = (relativePath: string): string => {
  const normalizedPath = relativePath.replace(/\\/gu, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length <= 1) {
    return '';
  }

  return segments.slice(0, -1).join('/');
};

export interface IBuildReplacementLineSegmentsOptions {
  // 命中区间（基于 beforeLine 的 UTF-16 下标）。提供后用于完整标注被替换片段，
  // 避免最小公共前后缀把同一 token 拆碎（如 23→24 退化成 3→4）。
  matchRange?: [number, number] | null;
  // 首/尾公共片段保留的上下文字符数（按码点计）。超出部分用省略号收拢，
  // 且省略号只出现在最外侧（前缀最前、后缀最后）。0 表示不收拢。
  contextSize?: number;
}

// 校验命中区间是否与 before/after 自洽：区间之外的前后缀必须在两侧完全一致，
// 否则说明该区间并非真正被替换的部分，回退到最小字符 diff 更稳妥。
const isUsableMatchRange = (
  matchRange: [number, number] | null | undefined,
  beforeLine: string,
  afterLine: string,
): matchRange is [number, number] => {
  if (!matchRange) {
    return false;
  }

  const [matchStart, matchEnd] = matchRange;
  if (!Number.isInteger(matchStart) || !Number.isInteger(matchEnd)) {
    return false;
  }
  if (matchStart < 0 || matchStart > matchEnd || matchEnd > beforeLine.length) {
    return false;
  }

  const suffixLength = beforeLine.length - matchEnd;
  const addedEnd = afterLine.length - suffixLength;
  if (addedEnd < matchStart) {
    return false;
  }

  return (
    beforeLine.slice(0, matchStart) === afterLine.slice(0, matchStart) &&
    beforeLine.slice(matchEnd) === afterLine.slice(addedEnd)
  );
};

// 将首/尾公共片段收拢到给定上下文长度内，并把省略号放到最外侧：
// 前缀保留末尾 contextSize 个字符并在最前加省略号；后缀保留开头 contextSize
// 个字符并在最后加省略号。长度未超出或 contextSize<=0 时原样返回。
const windowEdgeText = (
  text: string,
  side: 'prefix' | 'suffix',
  contextSize: number,
): string => {
  if (contextSize <= 0) {
    return text;
  }

  const characters = Array.from(text);
  if (characters.length <= contextSize) {
    return text;
  }

  if (side === 'prefix') {
    return `${COMPACT_PREVIEW_ELLIPSIS}${characters.slice(characters.length - contextSize).join('')}`;
  }

  return `${characters.slice(0, contextSize).join('')}${COMPACT_PREVIEW_ELLIPSIS}`;
};

export const buildReplacementLineSegments = (
  beforeLine: string,
  afterLine: string,
  options: IBuildReplacementLineSegmentsOptions = {},
): IReplacementLineSegment[] => {
  if (beforeLine === afterLine) {
    return [{ text: beforeLine, kind: 'equal', part: 'whole' }];
  }

  const { matchRange = null, contextSize = 0 } = options;

  let prefixText: string;
  let removedText: string;
  let addedText: string;
  let suffixText: string;

  if (isUsableMatchRange(matchRange, beforeLine, afterLine)) {
    // 已知精确命中区间：直接按区间切出完整的被替换片段，保留整个 token（如 23→24）。
    const [matchStart, matchEnd] = matchRange;
    const suffixLength = beforeLine.length - matchEnd;
    const addedEnd = afterLine.length - suffixLength;
    prefixText = beforeLine.slice(0, matchStart);
    removedText = beforeLine.slice(matchStart, matchEnd);
    addedText = afterLine.slice(matchStart, addedEnd);
    suffixText = beforeLine.slice(matchEnd);
  } else {
    // 回退：按最小公共前后缀切分（按码点比较，避免拆分代理对）。
    const beforeCharacters = Array.from(beforeLine);
    const afterCharacters = Array.from(afterLine);
    let prefixLength = 0;

    while (
      prefixLength < beforeCharacters.length &&
      prefixLength < afterCharacters.length &&
      beforeCharacters[prefixLength] === afterCharacters[prefixLength]
    ) {
      prefixLength += 1;
    }

    let suffixLength = 0;
    while (
      suffixLength < beforeCharacters.length - prefixLength &&
      suffixLength < afterCharacters.length - prefixLength &&
      beforeCharacters[beforeCharacters.length - 1 - suffixLength] ===
        afterCharacters[afterCharacters.length - 1 - suffixLength]
    ) {
      suffixLength += 1;
    }

    prefixText = beforeCharacters.slice(0, prefixLength).join('');
    removedText = beforeCharacters
      .slice(prefixLength, beforeCharacters.length - suffixLength)
      .join('');
    addedText = afterCharacters
      .slice(prefixLength, afterCharacters.length - suffixLength)
      .join('');
    suffixText = beforeCharacters.slice(beforeCharacters.length - suffixLength).join('');
  }

  const windowedPrefixText = windowEdgeText(prefixText, 'prefix', contextSize);
  const windowedSuffixText = windowEdgeText(suffixText, 'suffix', contextSize);

  return [
    { text: windowedPrefixText, kind: windowedPrefixText ? 'equal' : 'empty', part: 'prefix' },
    { text: removedText, kind: removedText ? 'removed' : 'empty', part: 'removed' },
    { text: addedText, kind: addedText ? 'added' : 'empty', part: 'added' },
    { text: windowedSuffixText, kind: windowedSuffixText ? 'equal' : 'empty', part: 'suffix' },
  ];
};

export const toggleReadonlySetValue = (
  values: ReadonlySet<string>,
  value: string,
): ReadonlySet<string> => {
  const nextValues = new Set(values);
  if (nextValues.has(value)) {
    nextValues.delete(value);
  } else {
    nextValues.add(value);
  }

  return nextValues;
};

export const createSearchMatcher = (options: ICreateSearchMatcherOptions): ISearchMatcher => {
  const query = options.query.trim();
  if (!query) {
    return {
      hasQuery: false,
      errorMessage: '',
      highlight: (value) => [{ text: value, matched: false }],
    };
  }

  if (options.useStructural) {
    return {
      hasQuery: true,
      errorMessage: '',
      highlight: (value) => [{ text: value, matched: false }],
    };
  }

  if (options.useRegex) {
    try {
      const baseFlags = options.matchCase ? 'gu' : 'giu';
      // 与后端正则构建保持一致：全字匹配时用单词边界包裹，避免前端高亮
      // 与后端命中范围不一致。
      const highlightSource = options.wholeWord ? `\\b(?:${query})\\b` : query;
      const highlightPattern = new RegExp(highlightSource, baseFlags);
      return {
        hasQuery: true,
        errorMessage: '',
        highlight: (value: string) =>
          buildHighlightedSegments(value, collectRegExpMatchRanges(value, highlightPattern)),
      };
    } catch (error) {
      return {
        hasQuery: true,
        errorMessage: toErrorMessage(error, '请输入有效的正则表达式。'),
        highlight: (value) => [{ text: value, matched: false }],
      };
    }
  }

  return {
    hasQuery: true,
    errorMessage: '',
    highlight: (value: string) =>
      buildHighlightedSegments(
        value,
        collectPlainMatchRanges(value, query, options.matchCase, options.wholeWord),
      ),
  };
};

// 在 value 上用给定 matcher 计算唯一命中区间（UTF-16 下标）。仅当恰好命中一次时
// 返回区间；0 次或多次（无法确定替换的是哪一处）以及空查询/结构化模式均返回 null。
export const singleMatchRange = (
  matcher: ISearchMatcher,
  value: string,
): [number, number] | null => {
  if (!matcher.hasQuery) {
    return null;
  }

  let index = 0;
  let matchedCount = 0;
  let matchedRange: [number, number] | null = null;

  for (const segment of matcher.highlight(value)) {
    if (segment.matched) {
      matchedCount += 1;
      if (matchedCount > 1) {
        return null;
      }
      matchedRange = [index, index + segment.text.length];
    }
    index += segment.text.length;
  }

  return matchedCount === 1 ? matchedRange : null;
};
