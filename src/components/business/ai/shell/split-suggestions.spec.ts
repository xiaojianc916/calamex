import { describe, expect, it } from 'vitest';

import { splitSuggestionsIntoRows } from './split-suggestions';

describe('splitSuggestionsIntoRows', () => {
  it('空数组返回空行集', () => {
    expect(splitSuggestionsIntoRows([], 3)).toEqual([]);
  });

  it('rowCount 为 1 时返回单行副本', () => {
    const items = [{ title: 'a' }, { title: 'b' }];
    const rows = splitSuggestionsIntoRows(items, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(items);
    expect(rows[0]).not.toBe(items);
  });

  it('按权重分行且不丢项', () => {
    const items = [{ title: 'aaaa' }, { title: 'bbbb' }, { title: 'cccc' }, { title: 'dddd' }];
    const rows = splitSuggestionsIntoRows(items, 2);

    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.flat()).toHaveLength(4);
  });

  it('rowCount 超过项数时被收敛', () => {
    const items = [{ title: 'a' }, { title: 'b' }];
    const rows = splitSuggestionsIntoRows(items, 5);

    expect(rows.flat()).toHaveLength(2);
  });
});
