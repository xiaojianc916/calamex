/**
 * 按标题文本长度的权重将建议均匀拆分为多行，用于空状态建议区的折行布局。
 * 保证不丢项，且最多拆为 rowCount 行。
 */
export const splitSuggestionsIntoRows = <T extends { title: string }>(
  items: readonly T[],
  rowCount: number,
): T[][] => {
  if (items.length === 0) {
    return [];
  }

  const effectiveRowCount = Math.min(rowCount, items.length);

  if (effectiveRowCount <= 1) {
    return [items.slice()];
  }

  const totalWeight = items.reduce((sum, item) => sum + item.title.length + 2, 0);
  const targetWeight = totalWeight / effectiveRowCount;

  const rows: T[][] = [];
  let currentRow: T[] = [];
  let currentWeight = 0;
  let rowsRemaining = effectiveRowCount;

  items.forEach((item, index) => {
    currentRow.push(item);
    currentWeight += item.title.length + 2;

    const rowsLeftAfterBreak = rowsRemaining - 1;
    const itemsLeftAfterCurrent = items.length - index - 1;
    const shouldBreakRow =
      rowsLeftAfterBreak > 0 &&
      currentWeight >= targetWeight &&
      itemsLeftAfterCurrent >= rowsLeftAfterBreak;

    if (shouldBreakRow) {
      rows.push(currentRow);
      currentRow = [];
      currentWeight = 0;
      rowsRemaining -= 1;
    }
  });

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
};
