import { describe, expect, it } from 'vitest';

import { __test__, applyDocChanges, computeDocChanges, type IDocChange } from './editor-doc-diff';

const expectSortedNonOverlapping = (changes: readonly IDocChange[]): void => {
  let previousTo = -1;
  for (const change of changes) {
    expect(change.from).toBeGreaterThanOrEqual(previousTo);
    expect(change.to).toBeGreaterThanOrEqual(change.from);
    previousTo = change.to;
  }
};

describe('computeDocChanges', () => {
  it('相同文本返回空变更', () => {
    expect(computeDocChanges('same text', 'same text')).toEqual([]);
  });

  it('纯插入只在插入点产生一个零宽变更', () => {
    const current = 'hello world';
    const next = 'hello brave world';
    const changes = computeDocChanges(current, next);
    expect(changes).toEqual([{ from: 6, to: 6, insert: 'brave ' }]);
    expect(applyDocChanges(current, changes)).toBe(next);
  });

  it('纯删除产生一个 insert 为空的变更', () => {
    const current = 'hello brave world';
    const next = 'hello world';
    const changes = computeDocChanges(current, next);
    expect(changes).toEqual([{ from: 6, to: 12, insert: '' }]);
    expect(applyDocChanges(current, changes)).toBe(next);
  });

  it('保留公共前后缀，只替换中间', () => {
    const current = 'const value = 1;';
    const next = 'const value = 42;';
    const changes = computeDocChanges(current, next);
    expect(applyDocChanges(current, changes)).toBe(next);
    expect(changes[0].from).toBeGreaterThanOrEqual('const value = '.length);
  });

  it('两处互不相邻的改动产出两个独立变更（而非整段替换）', () => {
    const current = 'foo AAA bar BBB baz';
    const next = 'foo XXX bar YYY baz';
    const changes = computeDocChanges(current, next);
    expect(changes).toEqual([
      { from: 4, to: 7, insert: 'XXX' },
      { from: 12, to: 15, insert: 'YYY' },
    ]);
    expect(applyDocChanges(current, changes)).toBe(next);
    expectSortedNonOverlapping(changes);
  });

  it('多行场景仅改动变化的行，保留中间未变行', () => {
    const current = 'line1\nAAA\nline3\nBBB\nline5';
    const next = 'line1\nXXX\nline3\nYYY\nline5';
    const changes = computeDocChanges(current, next);
    expect(changes.length).toBe(2);
    expect(applyDocChanges(current, changes)).toBe(next);
    expectSortedNonOverlapping(changes);
  });

  it('正确处理代理对（按 code unit 计算仍可重建）', () => {
    const current = 'a😀b😀c';
    const next = 'a😀X😀c';
    const changes = computeDocChanges(current, next);
    expect(applyDocChanges(current, changes)).toBe(next);
  });

  it('空串与非空串互转', () => {
    expect(applyDocChanges('', computeDocChanges('', 'hello'))).toBe('hello');
    expect(applyDocChanges('hello', computeDocChanges('hello', ''))).toBe('');
  });

  it('对大段完全不同的文本回退为单段替换且仍可重建', () => {
    const current = 'A'.repeat(20000);
    const next = 'B'.repeat(20000);
    const changes = computeDocChanges(current, next);
    expect(changes.length).toBe(1);
    expect(applyDocChanges(current, changes)).toBe(next);
  });

  it('超大文本经 CodeMirror override 回退为线性单区间替换', () => {
    const current = `p${'A'.repeat(85_000)}q${'B'.repeat(85_000)}r`;
    const next = `P${'A'.repeat(85_000)}q${'B'.repeat(85_000)}R`;
    const changes = computeDocChanges(current, next);
    expect(changes).toEqual(__test__.computeSingleRangeChange(current, next));
    expect(changes.length).toBe(1);
    expect(applyDocChanges(current, changes)).toBe(next);
  });

  it('随机模糊测试：应用变更后必逐字等于目标', () => {
    let seed = 0x12345678;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = 'abc \n';
    const randomString = (maxLength: number): string => {
      const length = Math.floor(rand() * maxLength);
      let result = '';
      for (let i = 0; i < length; i += 1) {
        result += alphabet.charAt(Math.floor(rand() * alphabet.length));
      }
      return result;
    };
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const current = randomString(60);
      const next = randomString(60);
      const changes = computeDocChanges(current, next);
      expectSortedNonOverlapping(changes);
      expect(applyDocChanges(current, changes)).toBe(next);
    }
  });
});
