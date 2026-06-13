import { describe, expect, it } from 'vitest';

import { splitSuggestionsIntoRows } from './split-suggestions';

describe('splitSuggestionsIntoRows', () => {
  it('空数组返回空行集', () => {
    expect(splitSuggestionsIntoRows([], 4)).toEqual([]);
  });

  it('rowCount 为 1 时返回单行副本', () => {
    const items = [{ title: 'a' }, { title: 'b' }];
    const rows = splitSuggestionsIntoRows(items, 1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(items);
    expect(rows[0]).not.toBe(items);
  });

  it('固定 9 个建议时动态选择 3 行或 4 行，且每行至少 2 个', () => {
    const items = [
      { title: '如何培养阅读习惯' },
      { title: '介绍一部经典的治愈电影' },
      { title: '为什么古建筑会倒塌' },
      { title: '介绍一位历史人物' },
      { title: '讲讲三分钟热度的原因' },
      { title: '推荐几首轻音乐' },
      { title: '为什么人会做梦？' },
      { title: '油画的基本技法' },
      { title: '哪些食物最健康？' },
    ];

    const rows = splitSuggestionsIntoRows(items, 4);

    expect([3, 4]).toContain(rows.length);
    expect(rows.every((row) => row.length >= 2)).toBe(true);
    expect(rows.flat()).toHaveLength(9);
    expect(new Set(rows.flat())).toEqual(new Set(items));
  });

  it('固定 9 个建议时会根据长度重排而不是按原顺序硬切', () => {
    const items = [
      { title: '短1' },
      { title: '非常非常非常长的建议标题一' },
      { title: '短2' },
      { title: '中等长度建议' },
      { title: '非常非常非常长的建议标题二' },
      { title: '短3' },
      { title: '中等长度建议二' },
      { title: '短4' },
      { title: '非常非常非常长的建议标题三' },
    ];

    const rows = splitSuggestionsIntoRows(items, 4);

    expect([3, 4]).toContain(rows.length);
    expect(rows.every((row) => row.length >= 2)).toBe(true);
    expect(rows.flat()).toHaveLength(9);
    expect(rows.flat()).not.toEqual(items);
  });

  it('短标题且 3 行已经均衡时，不会无脑固定成 4 行', () => {
    const items = [
      { title: '建议1' },
      { title: '建议2' },
      { title: '建议3' },
      { title: '建议4' },
      { title: '建议5' },
      { title: '建议6' },
      { title: '建议7' },
      { title: '建议8' },
      { title: '建议9' },
    ];

    const rows = splitSuggestionsIntoRows(items, 4);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.length)).toEqual([3, 3, 3]);
  });

  it('长短差距明显时，可以动态选择 4 行降低单行最大宽度', () => {
    const items = [
      { title: '非常非常非常长的建议标题一' },
      { title: '非常非常非常长的建议标题二' },
      { title: '非常非常非常长的建议标题三' },
      { title: '非常非常非常长的建议标题四' },
      { title: '短1' },
      { title: '短2' },
      { title: '短3' },
      { title: '短4' },
      { title: '短5' },
    ];

    const rows = splitSuggestionsIntoRows(items, 4);

    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.length >= 2)).toBe(true);
    expect(rows.flat()).toHaveLength(9);
  });

  it('非 9 个建议时仍按最大行数动态均衡分行且不丢项', () => {
    const items = [{ title: 'aaaa' }, { title: 'bbbbbbbb' }, { title: 'cc' }, { title: 'dddd' }];
    const rows = splitSuggestionsIntoRows(items, 4);

    expect(rows.every((row) => row.length >= 2)).toBe(true);
    expect(rows.flat()).toHaveLength(4);
    expect(new Set(rows.flat())).toEqual(new Set(items));
  });
});
