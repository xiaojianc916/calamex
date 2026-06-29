import { describe, expect, it } from 'vitest';

import { computeBashFoldByRow, resolveEnclosingByteRange } from './codemirror-bash-language';

describe('computeBashFoldByRow', () => {
  it('同一起始行取最外层折叠终点,跳过单行节点', () => {
    const fakeRoot = {
      descendantsOfType: (type: string) =>
        type === 'compound_statement'
          ? [
              { startPosition: { row: 0 }, endPosition: { row: 3 }, endIndex: 40 },
              { startPosition: { row: 0 }, endPosition: { row: 2 }, endIndex: 25 },
              { startPosition: { row: 5 }, endPosition: { row: 5 }, endIndex: 60 },
            ]
          : [],
    };
    const map = computeBashFoldByRow(fakeRoot, 'x'.repeat(80));
    expect(map.get(0)).toBe(40);
    expect(map.has(5)).toBe(false);
  });
});

describe('resolveEnclosingByteRange', () => {
  it('沿父链返回严格大于选区的最近节点', () => {
    const root = { startIndex: 0, endIndex: 100, parent: null };
    const mid = { startIndex: 10, endIndex: 50, parent: root };
    const leaf = { startIndex: 20, endIndex: 30, parent: mid };
    expect(resolveEnclosingByteRange(leaf, 20, 30)).toEqual({ startByte: 10, endByte: 50 });
    expect(resolveEnclosingByteRange(leaf, 0, 100)).toBeNull();
  });
});
