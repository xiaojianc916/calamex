import { toErrorMessage } from '@/utils/error';
import type {
  IHighlightedSegment,
  IReplacementLineSegment,
  ISearchMatcher,
  ISnippetSegment,
  TSnippetSegmentPart,
} from './search-sidebar.types';

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

// 按后端码点命中区间切出「完整前缀 + 命中 + 完整后缀」三段，全部按码点（Array.from）切片，
// 与后端 byte_to_char_offset（码点偏移）对齐。不做固定字符窗口、不拼省略号——长度收拢与
// 省略号完全交给 CSS，避免把中文从词中间斩断造成的乱码观感。
export const buildMatchSegments = (
  value: string,
  range: [number, number] | null,
): IHighlightedSegment[] => {
  if (!range) {
    return value ? [{ text: value, matched: false }] : [];
  }

  const characters = Array.from(value);
  const [matchStart, matchEnd] = range;
  const safeStart = Math.max(0, Math.min(matchStart, characters.length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, characters.length));

  return [
    { text: characters.slice(0, safeStart).join(''), matched: false },
    { text: characters.slice(safeStart, safeEnd).join(''), matched: true },
    { text: characters.slice(safeEnd).join(''), matched: false },
  ].filter((segment) => segment.text.length > 0);
};

// 把高亮分段标注成命中锚定的 prefix / core / suffix：首个命中之前全部为 prefix（左侧截断），
// 末个命中之后全部为 suffix（右侧截断），命中及其之间为 core（不收缩、始终可见）。
// 整行无命中（文件名/符号行可能没有可高亮片段）时整段视为 suffix，交给 CSS 右侧省略。
export const toAnchoredSnippetSegments = (segments: IHighlightedSegment[]): ISnippetSegment[] => {
  const visible = segments.filter((segment) => segment.text.length > 0);
  if (visible.length === 0) {
    return [];
  }

  const firstMatch = visible.findIndex((segment) => segment.matched);
  if (firstMatch === -1) {
    return visible.map((segment) => ({ text: segment.text, matched: false, part: 'suffix' }));
  }

  const reversedIndex = [...visible].reverse().findIndex((segment) => segment.matched);
  const lastMatch = reversedIndex === -1 ? firstMatch : visible.length - 1 - reversedIndex;

  return visible.map((segment, index) => {
    let part: TSnippetSegmentPart = 'core';
    if (index < firstMatch) {
      part = 'prefix';
    } else if (index > lastMatch) {
      part = 'suffix';
    }
    return { text: segment.text, matched: segment.matched, part };
  });
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

// 依据后端单命中替换预览切出 prefix / removed / added / suffix 四段。
// beforeLine 已由后端去掉行首缩进并规整换行；matchStart/matchEnd 是基于 beforeLine 的
// UTF-16 code unit 偏移（与后端 utf16_len 对齐），因此这里用原生 slice（UTF-16）切片，
// 不能用 Array.from（码点）——否则星体字符场景会与后端偏移错位、切出乱码。
// 不在数据层拼省略号：过长前后缀的视觉截断（含省略号）交给 CSS。
export const buildReplacementLineSegments = (
  beforeLine: string,
  insertedText: string,
  matchStart: number,
  matchEnd: number,
): IReplacementLineSegment[] => {
  const length = beforeLine.length;
  const safeStart = Math.max(0, Math.min(matchStart, length));
  const safeEnd = Math.max(safeStart, Math.min(matchEnd, length));
  const prefixText = beforeLine.slice(0, safeStart);
  const removedText = beforeLine.slice(safeStart, safeEnd);
  const suffixText = beforeLine.slice(safeEnd);

  return [
    { text: prefixText, kind: prefixText ? 'equal' : 'empty', part: 'prefix' },
    { text: removedText, kind: removedText ? 'removed' : 'empty', part: 'removed' },
    { text: insertedText, kind: insertedText ? 'added' : 'empty', part: 'added' },
    { text: suffixText, kind: suffixText ? 'equal' : 'empty', part: 'suffix' },
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
