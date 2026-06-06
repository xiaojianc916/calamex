import { describe, expect, it } from 'vitest';
import {
  buildHighlightedSegments,
  buildReplacementLineSegments,
  createSearchMatcher,
  escapeRegExp,
  getFileName,
  getParentPath,
  splitPatternList,
} from './search-sidebar-text';

describe('search-sidebar-text', () => {
  it('escapeRegExp 转义正则元字符', () => {
    expect(escapeRegExp('a.b*c+')).toBe('a\\.b\\*c\\+');
  });

  it('splitPatternList 按逗号与换行拆分并去除空白项', () => {
    expect(splitPatternList('src/**, dist\n , node_modules')).toEqual([
      'src/**',
      'dist',
      'node_modules',
    ]);
  });

  it('getFileName / getParentPath 解析相对路径', () => {
    expect(getFileName('src/components/Foo.vue')).toBe('Foo.vue');
    expect(getParentPath('src/components/Foo.vue')).toBe('src/components');
    expect(getFileName('Foo.vue')).toBe('Foo.vue');
    expect(getParentPath('Foo.vue')).toBe('');
  });

  it('buildHighlightedSegments 按区间切分高亮片段', () => {
    expect(buildHighlightedSegments('hello', [[0, 2]])).toEqual([
      { text: 'he', matched: true },
      { text: 'llo', matched: false },
    ]);
    expect(buildHighlightedSegments('hello', [])).toEqual([{ text: 'hello', matched: false }]);
  });

  it('buildReplacementLineSegments 标注公共前后缀与增删片段', () => {
    expect(buildReplacementLineSegments('abc', 'abc')).toEqual([
      { text: 'abc', kind: 'equal', part: 'whole' },
    ]);
    expect(buildReplacementLineSegments('foo', 'bar')).toEqual([
      { text: '', kind: 'empty', part: 'prefix' },
      { text: 'foo', kind: 'removed', part: 'removed' },
      { text: 'bar', kind: 'added', part: 'added' },
      { text: '', kind: 'empty', part: 'suffix' },
    ]);
  });

  it('createSearchMatcher 空查询不命中任何片段', () => {
    const matcher = createSearchMatcher({
      query: '   ',
      matchCase: false,
      wholeWord: false,
      useRegex: false,
      useStructural: false,
    });
    expect(matcher.hasQuery).toBe(false);
    expect(matcher.highlight('anything')).toEqual([{ text: 'anything', matched: false }]);
  });

  it('createSearchMatcher 普通查询高亮命中子串', () => {
    const matcher = createSearchMatcher({
      query: 'foo',
      matchCase: false,
      wholeWord: false,
      useRegex: false,
      useStructural: false,
    });
    const segments = matcher.highlight('a foo b');
    expect(segments.filter((segment) => segment.matched).map((segment) => segment.text)).toEqual([
      'foo',
    ]);
  });

  it('createSearchMatcher 非法正则返回错误信息且不抛出', () => {
    const matcher = createSearchMatcher({
      query: '(',
      matchCase: false,
      wholeWord: false,
      useRegex: true,
      useStructural: false,
    });
    expect(matcher.hasQuery).toBe(true);
    expect(matcher.errorMessage.length).toBeGreaterThan(0);
    expect(matcher.highlight('(')).toEqual([{ text: '(', matched: false }]);
  });

  it('createSearchMatcher 结构化模式不进行高亮', () => {
    const matcher = createSearchMatcher({
      query: 'foo',
      matchCase: false,
      wholeWord: false,
      useRegex: false,
      useStructural: true,
    });
    expect(matcher.highlight('foo bar')).toEqual([{ text: 'foo bar', matched: false }]);
  });
});
