import { describe, expect, it } from 'vitest';
import {
  buildHighlightedSegments,
  buildMatchSegments,
  buildReplacementLineSegments,
  createSearchMatcher,
  escapeRegExp,
  getFileName,
  getParentPath,
  splitPatternList,
  toAnchoredSnippetSegments,
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

  it('buildMatchSegments 按码点区间切出完整前缀/命中/后缀', () => {
    expect(buildMatchSegments('const value = 1;', [14, 15])).toEqual([
      { text: 'const value = ', matched: false },
      { text: '1', matched: true },
      { text: ';', matched: false },
    ]);
    expect(buildMatchSegments('plain', null)).toEqual([{ text: 'plain', matched: false }]);
    // 星体字符（emoji 占 2 个 UTF-16 单元但 1 个码点）按码点切片不应被截断成乱码。
    expect(buildMatchSegments('\u{1F600}ab', [1, 2])).toEqual([
      { text: '\u{1F600}', matched: false },
      { text: 'a', matched: true },
      { text: 'b', matched: false },
    ]);
  });

  it('toAnchoredSnippetSegments 标注前缀/命中区/后缀', () => {
    expect(
      toAnchoredSnippetSegments([
        { text: 'const value = ', matched: false },
        { text: '1', matched: true },
        { text: ';', matched: false },
      ]),
    ).toEqual([
      { text: 'const value = ', matched: false, part: 'prefix' },
      { text: '1', matched: true, part: 'core' },
      { text: ';', matched: false, part: 'suffix' },
    ]);
    // 整行无命中：整段当后缀，交给 CSS 右侧省略。
    expect(toAnchoredSnippetSegments([{ text: 'foo.sh', matched: false }])).toEqual([
      { text: 'foo.sh', matched: false, part: 'suffix' },
    ]);
    // 命中在行首：无前缀，命中为命中区，其后为后缀。
    expect(
      toAnchoredSnippetSegments([
        { text: 'foo', matched: true },
        { text: '.sh', matched: false },
      ]),
    ).toEqual([
      { text: 'foo', matched: true, part: 'core' },
      { text: '.sh', matched: false, part: 'suffix' },
    ]);
  });

  it('buildReplacementLineSegments 按 UTF-16 命中区间切出增删片段', () => {
    expect(buildReplacementLineSegments('value = 23;', '24', 8, 10)).toEqual([
      { text: 'value = ', kind: 'equal', part: 'prefix' },
      { text: '23', kind: 'removed', part: 'removed' },
      { text: '24', kind: 'added', part: 'added' },
      { text: ';', kind: 'equal', part: 'suffix' },
    ]);
  });

  it('buildReplacementLineSegments 行首/行尾命中时对应公共片段为空', () => {
    expect(buildReplacementLineSegments('foo', 'bar', 0, 3)).toEqual([
      { text: '', kind: 'empty', part: 'prefix' },
      { text: 'foo', kind: 'removed', part: 'removed' },
      { text: 'bar', kind: 'added', part: 'added' },
      { text: '', kind: 'empty', part: 'suffix' },
    ]);
  });

  it('buildReplacementLineSegments 越界区间会被收敛到合法范围', () => {
    expect(buildReplacementLineSegments('abc', 'X', 2, 99)).toEqual([
      { text: 'ab', kind: 'equal', part: 'prefix' },
      { text: 'c', kind: 'removed', part: 'removed' },
      { text: 'X', kind: 'added', part: 'added' },
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
