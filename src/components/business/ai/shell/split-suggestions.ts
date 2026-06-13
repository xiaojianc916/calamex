/**
 * AI 建议区动态布局算法。
 *
 * 需求：
 * - 当前产品建议数量固定为 9；
 * - 不能固定死 3 行或 4 行；
 * - 9 个建议时同时评估：
 *   - 3 行：3 + 3 + 3
 *   - 4 行：3 + 2 + 2 + 2
 * - 每行至少 2 个建议；
 * - 根据建议标题视觉长度重新排序；
 * - 动态选择视觉更均衡的布局。
 *
 * 算法：
 * - 使用 LPT(Longest Processing Time first) 标准调度算法；
 * - 把每个建议 chip 的视觉宽度视为任务权重；
 * - 长建议优先分配到当前最短行；
 * - 对候选布局评分，选单行最大宽度更小、行宽更均衡的布局；
 * - 3 行足够均衡时优先 3 行，避免无意义增加高度。
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
const NINE_SUGGESTION_ROW_COUNTS = [3, 4] as const;

const isCjkCharacter = (char: string): boolean =>
  /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u.test(char);

const isAsciiLetterOrDigit = (char: string): boolean => /[a-z0-9]/iu.test(char);

const resolveSuggestionVisualWeight = (title: string): number => {
  let weight = 0;

  for (const char of title.trim()) {
    if (isCjkCharacter(char)) {
      weight += 2;
    } else if (isAsciiLetterOrDigit(char)) {
      weight += 1;
    } else if (/\s/u.test(char)) {
      weight += 0.5;
    } else {
      weight += 0.8;
    }
  }

  // chip 自身 padding / 最小宽度基础权重。
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

const buildCandidateRowCounts = (itemCount: number, maxRowCount: number): number[] => {
  if (itemCount <= 0) {
    return [];
  }

  if (itemCount <= 2 || maxRowCount <= 1) {
    return [1];
  }

  /**
   * 关键点：
   * 9 个建议是产品固定数量。
   * 这里必须动态评估 3 行和 4 行，不能受外部调用点传 3 还是 4 影响。
   */
  if (itemCount === FIXED_SUGGESTION_COUNT) {
    return NINE_SUGGESTION_ROW_COUNTS.filter((rowCount) => rowCount * 2 <= itemCount);
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

const createRows = <T extends TSuggestionLike>(
  capacities: readonly number[],
): ISuggestionRow<T>[] =>
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

    const rowRemainingCapacity = row.capacity - row.items.length;
    const bestRemainingCapacity = best.capacity - best.items.length;

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
  const rows = createRows<T>(buildRowCapacities(weightedItems.length, rowCount));

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

  // 行数惩罚：3 行已经足够均衡时，不要无脑变 4 行。
  const verticalPenalty = rows.length > 3 ? averageWeight * 0.14 * (rows.length - 3) : 0;

  return maxWeight + spread * 0.36 + standardDeviation * 0.58 + verticalPenalty;
};

const sortRowForReading = <T extends TSuggestionLike>(
  row: ISuggestionRow<T>,
): IWeightedSuggestion<T>[] =>
  row.items.slice().sort((a, b) => b.weight - a.weight || a.index - b.index);

const normalizeRowsForReading = <T extends TSuggestionLike>(
  rows: readonly ISuggestionRow<T>[],
): T[][] =>
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

    // 分数相同选更少行，减少垂直占用。
    return candidate.rows.length < best.rows.length ? candidate : best;
  }, candidates[0]!);

export const splitSuggestionsIntoRows = <T extends TSuggestionLike>(
  items: readonly T[],
  maxRowCount: number,
): T[][] => {
  if (items.length === 0) {
    return [];
  }

  const candidateRowCounts = buildCandidateRowCounts(items.length, maxRowCount);

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
