import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

const splitFile = path.join(
  repoRoot,
  'src/components/business/ai/shell/split-suggestions.ts',
);

const specFile = path.join(
  repoRoot,
  'src/components/business/ai/shell/split-suggestions.spec.ts',
);

const panelFile = path.join(
  repoRoot,
  'src/components/business/ai/shell/AiAssistantPanel.vue',
);

const fail = (message) => {
  throw new Error(message);
};

if (!fs.existsSync(splitFile)) {
  fail(`[missing] ${path.relative(repoRoot, splitFile)}`);
}

if (!fs.existsSync(specFile)) {
  fail(`[missing] ${path.relative(repoRoot, specFile)}`);
}

if (!fs.existsSync(panelFile)) {
  fail(`[missing] ${path.relative(repoRoot, panelFile)}`);
}

const splitSource = `/**
 * 建议区布局算法。
 *
 * 需求：
 * - 建议数量固定 9 个时，不固定死 3 行或 4 行；
 * - 同时评估 3 行与 4 行候选布局；
 * - 每行至少 2 个建议；
 * - 根据标题视觉长度重新排序；
 * - 选择视觉宽度更均衡、整体更自然的布局。
 *
 * 算法：
 * - 使用 LPT(Longest Processing Time first) 做长度均衡分配；
 * - 9 个建议候选布局为：
 *   - 3 行：3 + 3 + 3
 *   - 4 行：3 + 2 + 2 + 2
 * - 分别计算评分，动态选择更优布局。
 */

type TSuggestionLike = { title: string };

interface IWeightedSuggestion<T extends TSuggestionLike> {
  item: T;
  index: number;
  weight: number;
}

interface ISuggestionRow<T extends TSuggestionLike> {
  items: IWeightedSuggestion<T>[];
  capacity: number;
  weight: number;
  index: number;
}

interface ILayoutCandidate<T extends TSuggestionLike> {
  rows: ISuggestionRow<T>[];
  score: number;
}

const FIXED_SUGGESTION_COUNT = 9;
const NINE_SUGGESTION_MIN_ROWS = 3;
const NINE_SUGGESTION_MAX_ROWS = 4;

const isCjkCharacter = (char: string): boolean =>
  /[\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af]/u.test(char);

const isAsciiLetterOrDigit = (char: string): boolean => /[a-z0-9]/iu.test(char);

const resolveSuggestionVisualWeight = (title: string): number => {
  let weight = 0;

  for (const char of title.trim()) {
    if (isCjkCharacter(char)) {
      weight += 2;
    } else if (isAsciiLetterOrDigit(char)) {
      weight += 1;
    } else if (/\\s/u.test(char)) {
      weight += 0.5;
    } else {
      weight += 0.8;
    }
  }

  // chip 左右 padding / 最小宽度的基础权重，避免短文本被低估。
  return weight + 6;
};

const buildRowCapacities = (itemCount: number, rowCount: number): number[] => {
  if (rowCount <= 1) {
    return [itemCount];
  }

  const base = Math.floor(itemCount / rowCount);
  const remainder = itemCount % rowCount;

  return Array.from({ length: rowCount }, (_, index) => base + (index < remainder ? 1 : 0));
};

const buildDynamicCandidateRowCounts = (itemCount: number, maxRowCount: number): number[] => {
  if (itemCount <= 0) {
    return [];
  }

  if (itemCount <= 2 || maxRowCount <= 1) {
    return [1];
  }

  // 当前产品固定 9 个建议：动态评估 3 行和 4 行，而不是固定其中一种。
  if (itemCount === FIXED_SUGGESTION_COUNT) {
    return [NINE_SUGGESTION_MIN_ROWS, NINE_SUGGESTION_MAX_ROWS].filter(
      (rowCount) => rowCount <= maxRowCount && rowCount * 2 <= itemCount,
    );
  }

  const maxFeasibleRows = Math.min(maxRowCount, Math.floor(itemCount / 2));

  if (maxFeasibleRows <= 1) {
    return [1];
  }

  const minReasonableRows = Math.max(1, Math.min(maxFeasibleRows, Math.ceil(itemCount / 4)));
  const result: number[] = [];

  for (let rowCount = minReasonableRows; rowCount <= maxFeasibleRows; rowCount += 1) {
    result.push(rowCount);
  }

  return result.length > 0 ? result : [maxFeasibleRows];
};

const createRows = <T extends TSuggestionLike>(capacities: readonly number[]): ISuggestionRow<T>[] =>
  capacities.map((capacity, index) => ({
    items: [],
    capacity,
    weight: 0,
    index,
  }));

const findBestRow = <T extends TSuggestionLike>(rows: ISuggestionRow<T>[]): ISuggestionRow<T> => {
  const availableRows = rows.filter((row) => row.items.length < row.capacity);

  if (availableRows.length === 0) {
    return rows[rows.length - 1]!;
  }

  return availableRows.reduce((best, row) => {
    if (row.weight !== best.weight) {
      return row.weight < best.weight ? row : best;
    }

    const bestRemainingCapacity = best.capacity - best.items.length;
    const rowRemainingCapacity = row.capacity - row.items.length;

    if (rowRemainingCapacity !== bestRemainingCapacity) {
      return rowRemainingCapacity > bestRemainingCapacity ? row : best;
    }

    return row.index < best.index ? row : best;
  }, availableRows[0]!);
};

const buildRowsByLpt = <T extends TSuggestionLike>(
  weightedItems: readonly IWeightedSuggestion<T>[],
  rowCount: number,
): ISuggestionRow<T>[] => {
  const capacities = buildRowCapacities(weightedItems.length, rowCount);
  const rows = createRows<T>(capacities);

  for (const weightedItem of weightedItems) {
    const row = findBestRow(rows);
    row.items.push(weightedItem);
    row.weight += weightedItem.weight;
  }

  return rows;
};

const scoreRows = <T extends TSuggestionLike>(rows: readonly ISuggestionRow<T>[]): number => {
  const weights = rows.map((row) => row.weight);
  const maxWeight = Math.max(...weights);
  const minWeight = Math.min(...weights);
  const averageWeight = weights.reduce((sum, weight) => sum + weight, 0) / weights.length;
  const spread = maxWeight - minWeight;
  const variance =
    weights.reduce((sum, weight) => sum + (weight - averageWeight) ** 2, 0) / weights.length;
  const standardDeviation = Math.sqrt(variance);

  /**
   * 评分目标：
   * - maxWeight：避免任何一行太宽；
   * - spread/stddev：避免行宽差异太大；
   * - verticalPenalty：避免在 3 行已经足够均衡时，无脑变成 4 行。
   *
   * 所以最终会根据长度动态选择：
   * - 标题都比较短 / 均衡：倾向 3 行；
   * - 长短差距明显 / 3 行会过宽：倾向 4 行。
   */
  const verticalPenalty = rows.length > 3 ? averageWeight * 0.14 * (rows.length - 3) : 0;

  return maxWeight + spread * 0.36 + standardDeviation * 0.58 + verticalPenalty;
};

const sortRowForReading = <T extends TSuggestionLike>(
  row: ISuggestionRow<T>,
): IWeightedSuggestion<T>[] =>
  row.items
    .slice()
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

const normalizeRowsForReading = <T extends TSuggestionLike>(rows: readonly ISuggestionRow<T>[]): T[][] =>
  rows
    .filter((row) => row.items.length > 0)
    .map((row) => sortRowForReading(row).map((weightedItem) => weightedItem.item));

const chooseBestCandidate = <T extends TSuggestionLike>(
  candidates: readonly ILayoutCandidate<T>[],
): ILayoutCandidate<T> =>
  candidates.reduce((best, candidate) => {
    if (candidate.score !== best.score) {
      return candidate.score < best.score ? candidate : best;
    }

    // 评分相同则选行数少的，减少垂直占用。
    return candidate.rows.length < best.rows.length ? candidate : best;
  }, candidates[0]!);

/**
 * 把建议按视觉长度动态均衡分行。
 *
 * 对 9 个建议：
 * - 动态评估 3 行：3 + 3 + 3；
 * - 动态评估 4 行：3 + 2 + 2 + 2；
 * - 选择视觉评分更优的一种；
 * - 每行至少 2 个；
 * - 根据长度重排，不按原始顺序硬切。
 */
export const splitSuggestionsIntoRows = <T extends TSuggestionLike>(
  items: readonly T[],
  maxRowCount: number,
): T[][] => {
  if (items.length === 0) {
    return [];
  }

  const candidateRowCounts = buildDynamicCandidateRowCounts(items.length, maxRowCount);

  if (candidateRowCounts.length === 0 || candidateRowCounts[0] === 1) {
    return [items.slice()];
  }

  const weightedItems = items
    .map<IWeightedSuggestion<T>>((item, index) => ({
      item,
      index,
      weight: resolveSuggestionVisualWeight(item.title),
    }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);

  const candidates = candidateRowCounts.map<ILayoutCandidate<T>>((rowCount) => {
    const rows = buildRowsByLpt(weightedItems, rowCount);

    return {
      rows,
      score: scoreRows(rows),
    };
  });

  return normalizeRowsForReading(chooseBestCandidate(candidates).rows);
};
`;

fs.writeFileSync(splitFile, splitSource);

const specSource = `import { describe, expect, it } from 'vitest';

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
`;

fs.writeFileSync(specFile, specSource);

let panelSource = fs.readFileSync(panelFile, 'utf8');

const callPattern =
  /splitSuggestionsIntoRows\\(suggestionPool\\.suggestions\\.value,\\s*\\d+\\)/;

if (!callPattern.test(panelSource)) {
  fail('[guard] 找不到 AiAssistantPanel.vue 里的 splitSuggestionsIntoRows 调用。');
}

panelSource = panelSource.replace(
  callPattern,
  'splitSuggestionsIntoRows(suggestionPool.suggestions.value, 4)',
);

fs.writeFileSync(panelFile, panelSource);

console.log('✅ Applied dynamic AI suggestion layout');
console.log('✅ 9 suggestions now dynamically choose 3 or 4 rows');
console.log('✅ No fixed 3+2+2+2 layout');
console.log('✅ Reorders suggestions by visual title length');
console.log('✅ Keeps at least 2 suggestions per row');
console.log(`📝 Updated: ${path.relative(repoRoot, splitFile)}`);
console.log(`📝 Updated: ${path.relative(repoRoot, specFile)}`);
console.log(`📝 Updated: ${path.relative(repoRoot, panelFile)}`);