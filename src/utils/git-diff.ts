export type TGitLineChangeType = 'added' | 'modified' | 'deleted';

export type TGitDiffPreviewLineType = 'context' | 'added' | 'deleted';

export interface IGitLineChange {
  type: TGitLineChangeType;
  startLine: number;
  endLine: number;
}

export interface IGitDiffPreviewLine {
  key: string;
  type: TGitDiffPreviewLineType;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  displayLineNumber: number | null;
}

export interface IGitDiffPreviewHunk {
  key: string;
  header: string;
  oldStart: number;
  oldLineCount: number;
  newStart: number;
  newLineCount: number;
  lines: IGitDiffPreviewLine[];
}

export interface IGitDiffPreview {
  hunks: IGitDiffPreviewHunk[];
  addedLineCount: number;
  deletedLineCount: number;
}

type TDiffOperation = 'equal' | 'insert' | 'delete';

interface IDiffOperationRecord {
  type: TDiffOperation;
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

const MAX_DIFF_MATRIX_CELLS = 1_200_000;
const DEFAULT_DIFF_PREVIEW_CONTEXT_LINES = 3;

const splitLines = (content: string): string[] => (content.length === 0 ? [] : content.split('\n'));

const clampLineNumber = (lineNumber: number, currentLineCount: number): number => {
  if (currentLineCount <= 0) {
    return 1;
  }

  return Math.min(Math.max(1, lineNumber), currentLineCount);
};

const mergeAdjacentChanges = (changes: IGitLineChange[]): IGitLineChange[] => {
  if (changes.length <= 1) {
    return changes;
  }

  const merged: IGitLineChange[] = [];

  for (const change of changes) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.type === change.type &&
      change.startLine <= previous.endLine + 1
    ) {
      previous.endLine = Math.max(previous.endLine, change.endLine);
      continue;
    }

    merged.push({ ...change });
  }

  return merged;
};

const appendRange = (
  changes: IGitLineChange[],
  type: TGitLineChangeType,
  startLine: number,
  endLine: number,
): void => {
  if (startLine > endLine) {
    return;
  }

  changes.push({
    type,
    startLine,
    endLine,
  });
};

const buildLcsMatrix = (baselineLines: string[], currentLines: string[]): Uint32Array[] => {
  const baselineLength = baselineLines.length;
  const currentLength = currentLines.length;
  const matrix = Array.from({ length: baselineLength + 1 }, () => new Uint32Array(currentLength + 1));

  for (let baselineIndex = baselineLength - 1; baselineIndex >= 0; baselineIndex -= 1) {
    for (let currentIndex = currentLength - 1; currentIndex >= 0; currentIndex -= 1) {
      if (baselineLines[baselineIndex] === currentLines[currentIndex]) {
        matrix[baselineIndex][currentIndex] = matrix[baselineIndex + 1][currentIndex + 1] + 1;
        continue;
      }

      matrix[baselineIndex][currentIndex] = Math.max(
        matrix[baselineIndex + 1][currentIndex],
        matrix[baselineIndex][currentIndex + 1],
      );
    }
  }

  return matrix;
};

const buildDiffOperations = (
  baselineLines: string[],
  currentLines: string[],
  matrix: Uint32Array[],
): TDiffOperation[] => {
  const operations: TDiffOperation[] = [];
  let baselineIndex = 0;
  let currentIndex = 0;

  while (baselineIndex < baselineLines.length || currentIndex < currentLines.length) {
    if (
      baselineIndex < baselineLines.length &&
      currentIndex < currentLines.length &&
      baselineLines[baselineIndex] === currentLines[currentIndex]
    ) {
      operations.push('equal');
      baselineIndex += 1;
      currentIndex += 1;
      continue;
    }

    const deleteScore =
      baselineIndex < baselineLines.length ? matrix[baselineIndex + 1][currentIndex] : -1;
    const insertScore =
      currentIndex < currentLines.length ? matrix[baselineIndex][currentIndex + 1] : -1;

    if (currentIndex < currentLines.length && (baselineIndex >= baselineLines.length || insertScore >= deleteScore)) {
      operations.push('insert');
      currentIndex += 1;
      continue;
    }

    operations.push('delete');
    baselineIndex += 1;
  }

  return operations;
};

const appendOperationRecord = (
  operations: IDiffOperationRecord[],
  type: TDiffOperation,
  content: string,
  oldLineNumber: number | null,
  newLineNumber: number | null,
): void => {
  operations.push({
    type,
    content,
    oldLineNumber,
    newLineNumber,
  });
};

const buildDiffOperationRecords = (
  baselineLines: string[],
  currentLines: string[],
): IDiffOperationRecord[] => {
  const operations: IDiffOperationRecord[] = [];

  if (baselineLines.length === 0) {
    currentLines.forEach((content, index) => {
      appendOperationRecord(operations, 'insert', content, null, index + 1);
    });
    return operations;
  }

  if (currentLines.length === 0) {
    baselineLines.forEach((content, index) => {
      appendOperationRecord(operations, 'delete', content, index + 1, null);
    });
    return operations;
  }

  let prefixLineCount = 0;
  while (
    prefixLineCount < baselineLines.length &&
    prefixLineCount < currentLines.length &&
    baselineLines[prefixLineCount] === currentLines[prefixLineCount]
  ) {
    appendOperationRecord(
      operations,
      'equal',
      baselineLines[prefixLineCount],
      prefixLineCount + 1,
      prefixLineCount + 1,
    );
    prefixLineCount += 1;
  }

  let baselineSuffixIndex = baselineLines.length - 1;
  let currentSuffixIndex = currentLines.length - 1;

  while (
    baselineSuffixIndex >= prefixLineCount &&
    currentSuffixIndex >= prefixLineCount &&
    baselineLines[baselineSuffixIndex] === currentLines[currentSuffixIndex]
  ) {
    baselineSuffixIndex -= 1;
    currentSuffixIndex -= 1;
  }

  const middleBaselineLines = baselineLines.slice(prefixLineCount, baselineSuffixIndex + 1);
  const middleCurrentLines = currentLines.slice(prefixLineCount, currentSuffixIndex + 1);

  if (middleBaselineLines.length === 0) {
    middleCurrentLines.forEach((content, index) => {
      appendOperationRecord(operations, 'insert', content, null, prefixLineCount + index + 1);
    });
  } else if (middleCurrentLines.length === 0) {
    middleBaselineLines.forEach((content, index) => {
      appendOperationRecord(operations, 'delete', content, prefixLineCount + index + 1, null);
    });
  } else if (middleBaselineLines.length * middleCurrentLines.length > MAX_DIFF_MATRIX_CELLS) {
    middleBaselineLines.forEach((content, index) => {
      appendOperationRecord(operations, 'delete', content, prefixLineCount + index + 1, null);
    });
    middleCurrentLines.forEach((content, index) => {
      appendOperationRecord(operations, 'insert', content, null, prefixLineCount + index + 1);
    });
  } else {
    const matrix = buildLcsMatrix(middleBaselineLines, middleCurrentLines);
    const middleOperations = buildDiffOperations(middleBaselineLines, middleCurrentLines, matrix);

    let baselineIndex = 0;
    let currentIndex = 0;

    for (const operation of middleOperations) {
      if (operation === 'equal') {
        appendOperationRecord(
          operations,
          'equal',
          middleBaselineLines[baselineIndex],
          prefixLineCount + baselineIndex + 1,
          prefixLineCount + currentIndex + 1,
        );
        baselineIndex += 1;
        currentIndex += 1;
        continue;
      }

      if (operation === 'insert') {
        appendOperationRecord(
          operations,
          'insert',
          middleCurrentLines[currentIndex],
          null,
          prefixLineCount + currentIndex + 1,
        );
        currentIndex += 1;
        continue;
      }

      appendOperationRecord(
        operations,
        'delete',
        middleBaselineLines[baselineIndex],
        prefixLineCount + baselineIndex + 1,
        null,
      );
      baselineIndex += 1;
    }
  }

  const suffixStart = baselineSuffixIndex + 1;
  for (let index = suffixStart; index < baselineLines.length; index += 1) {
    const newLineNumber = currentSuffixIndex + 1 + (index - suffixStart) + 1;
    appendOperationRecord(operations, 'equal', baselineLines[index], index + 1, newLineNumber);
  }

  return operations;
};

const buildLineCountPrefix = (
  operations: IDiffOperationRecord[],
  predicate: (operation: IDiffOperationRecord) => boolean,
): number[] => {
  const prefix = new Array<number>(operations.length + 1);
  prefix[0] = 0;

  for (let index = 0; index < operations.length; index += 1) {
    prefix[index + 1] = prefix[index] + (predicate(operations[index]) ? 1 : 0);
  }

  return prefix;
};

const formatUnifiedRange = (start: number, lineCount: number): string => {
  if (lineCount === 0) {
    return `${start},0`;
  }

  if (lineCount === 1) {
    return `${start}`;
  }

  return `${start},${lineCount}`;
};

const buildDiffPreviewHunk = (
  operations: IDiffOperationRecord[],
  oldLinePrefix: number[],
  newLinePrefix: number[],
  firstChangeIndex: number,
  lastChangeIndex: number,
  contextLineCount: number,
): IGitDiffPreviewHunk => {
  const hunkStartIndex = Math.max(0, firstChangeIndex - contextLineCount);
  const hunkEndIndex = Math.min(operations.length - 1, lastChangeIndex + contextLineCount);
  const hunkOperations = operations.slice(hunkStartIndex, hunkEndIndex + 1);

  const oldLineCount = oldLinePrefix[hunkEndIndex + 1] - oldLinePrefix[hunkStartIndex];
  const newLineCount = newLinePrefix[hunkEndIndex + 1] - newLinePrefix[hunkStartIndex];
  const oldStart = oldLineCount > 0 ? oldLinePrefix[hunkStartIndex] + 1 : oldLinePrefix[hunkStartIndex];
  const newStart = newLineCount > 0 ? newLinePrefix[hunkStartIndex] + 1 : newLinePrefix[hunkStartIndex];

  return {
    key: `${oldStart}:${newStart}:${oldLineCount}:${newLineCount}`,
    header: `@@ -${formatUnifiedRange(oldStart, oldLineCount)} +${formatUnifiedRange(newStart, newLineCount)} @@`,
    oldStart,
    oldLineCount,
    newStart,
    newLineCount,
    lines: hunkOperations.map((operation, index) => ({
      key: `${hunkStartIndex + index}:${operation.type}:${operation.oldLineNumber ?? 'none'}:${operation.newLineNumber ?? 'none'}`,
      type:
        operation.type === 'equal'
          ? 'context'
          : operation.type === 'insert'
            ? 'added'
            : 'deleted',
      content: operation.content,
      oldLineNumber: operation.oldLineNumber,
      newLineNumber: operation.newLineNumber,
      displayLineNumber:
        operation.type === 'delete'
          ? operation.oldLineNumber
          : operation.newLineNumber ?? operation.oldLineNumber,
    })),
  };
};

const buildDiffPreviewHunks = (
  operations: IDiffOperationRecord[],
  contextLineCount: number,
): IGitDiffPreviewHunk[] => {
  const changeIndices = operations.reduce<number[]>((indices, operation, index) => {
    if (operation.type !== 'equal') {
      indices.push(index);
    }
    return indices;
  }, []);

  if (changeIndices.length === 0) {
    return [];
  }

  const oldLinePrefix = buildLineCountPrefix(operations, (operation) => operation.type !== 'insert');
  const newLinePrefix = buildLineCountPrefix(operations, (operation) => operation.type !== 'delete');
  const hunks: IGitDiffPreviewHunk[] = [];

  let firstChangeIndex = changeIndices[0];
  let lastChangeIndex = changeIndices[0];

  for (let index = 1; index < changeIndices.length; index += 1) {
    const nextChangeIndex = changeIndices[index];
    const gapLineCount = nextChangeIndex - lastChangeIndex - 1;

    if (gapLineCount <= contextLineCount * 2) {
      lastChangeIndex = nextChangeIndex;
      continue;
    }

    hunks.push(
      buildDiffPreviewHunk(
        operations,
        oldLinePrefix,
        newLinePrefix,
        firstChangeIndex,
        lastChangeIndex,
        contextLineCount,
      ),
    );
    firstChangeIndex = nextChangeIndex;
    lastChangeIndex = nextChangeIndex;
  }

  hunks.push(
    buildDiffPreviewHunk(
      operations,
      oldLinePrefix,
      newLinePrefix,
      firstChangeIndex,
      lastChangeIndex,
      contextLineCount,
    ),
  );

  return hunks;
};

const buildChangesFromOperations = (
  operations: TDiffOperation[],
  prefixLineCount: number,
  currentLineCount: number,
): IGitLineChange[] => {
  const changes: IGitLineChange[] = [];
  let currentLine = prefixLineCount + 1;
  let chunkStartLine = currentLine;
  let deletedCount = 0;
  let insertedCount = 0;

  const flushChunk = (): void => {
    if (deletedCount === 0 && insertedCount === 0) {
      return;
    }

    if (deletedCount === 0) {
      appendRange(changes, 'added', chunkStartLine, chunkStartLine + insertedCount - 1);
    } else if (insertedCount === 0) {
      const anchorLine = clampLineNumber(chunkStartLine, currentLineCount);
      appendRange(changes, 'deleted', anchorLine, anchorLine);
    } else {
      const modifiedCount = Math.min(deletedCount, insertedCount);
      appendRange(changes, 'modified', chunkStartLine, chunkStartLine + modifiedCount - 1);

      if (insertedCount > modifiedCount) {
        appendRange(
          changes,
          'added',
          chunkStartLine + modifiedCount,
          chunkStartLine + insertedCount - 1,
        );
      }

      if (deletedCount > modifiedCount) {
        const anchorLine = clampLineNumber(chunkStartLine + modifiedCount, currentLineCount);
        appendRange(changes, 'deleted', anchorLine, anchorLine);
      }
    }

    deletedCount = 0;
    insertedCount = 0;
  };

  for (const operation of operations) {
    if (operation === 'equal') {
      flushChunk();
      currentLine += 1;
      continue;
    }

    if (deletedCount === 0 && insertedCount === 0) {
      chunkStartLine = currentLine;
    }

    if (operation === 'insert') {
      insertedCount += 1;
      currentLine += 1;
      continue;
    }

    deletedCount += 1;
  }

  flushChunk();

  return mergeAdjacentChanges(changes);
};

export const computeGitLineChanges = (
  baselineContent: string,
  currentContent: string,
): IGitLineChange[] => {
  if (baselineContent === currentContent) {
    return [];
  }

  const baselineLines = splitLines(baselineContent);
  const currentLines = splitLines(currentContent);

  if (baselineLines.length === 0) {
    return currentLines.length === 0
      ? []
      : [{ type: 'added', startLine: 1, endLine: currentLines.length }];
  }

  if (currentLines.length === 0) {
    return [{ type: 'deleted', startLine: 1, endLine: 1 }];
  }

  let prefixLineCount = 0;
  while (
    prefixLineCount < baselineLines.length &&
    prefixLineCount < currentLines.length &&
    baselineLines[prefixLineCount] === currentLines[prefixLineCount]
  ) {
    prefixLineCount += 1;
  }

  let baselineSuffixIndex = baselineLines.length - 1;
  let currentSuffixIndex = currentLines.length - 1;

  while (
    baselineSuffixIndex >= prefixLineCount &&
    currentSuffixIndex >= prefixLineCount &&
    baselineLines[baselineSuffixIndex] === currentLines[currentSuffixIndex]
  ) {
    baselineSuffixIndex -= 1;
    currentSuffixIndex -= 1;
  }

  const middleBaselineLines = baselineLines.slice(prefixLineCount, baselineSuffixIndex + 1);
  const middleCurrentLines = currentLines.slice(prefixLineCount, currentSuffixIndex + 1);

  if (middleBaselineLines.length === 0) {
    return mergeAdjacentChanges([
      {
        type: 'added',
        startLine: prefixLineCount + 1,
        endLine: prefixLineCount + middleCurrentLines.length,
      },
    ]);
  }

  if (middleCurrentLines.length === 0) {
    const anchorLine = clampLineNumber(prefixLineCount + 1, currentLines.length);
    return [{ type: 'deleted', startLine: anchorLine, endLine: anchorLine }];
  }

  if (middleBaselineLines.length * middleCurrentLines.length > MAX_DIFF_MATRIX_CELLS) {
    return [{ type: 'modified', startLine: 1, endLine: currentLines.length }];
  }

  const matrix = buildLcsMatrix(middleBaselineLines, middleCurrentLines);
  const operations = buildDiffOperations(middleBaselineLines, middleCurrentLines, matrix);

  return buildChangesFromOperations(operations, prefixLineCount, currentLines.length);
};

export const buildGitDiffPreview = (
  baselineContent: string,
  currentContent: string,
  contextLineCount = DEFAULT_DIFF_PREVIEW_CONTEXT_LINES,
): IGitDiffPreview => {
  if (baselineContent === currentContent) {
    return {
      hunks: [],
      addedLineCount: 0,
      deletedLineCount: 0,
    };
  }

  const operations = buildDiffOperationRecords(splitLines(baselineContent), splitLines(currentContent));

  return {
    hunks: buildDiffPreviewHunks(operations, contextLineCount),
    addedLineCount: operations.filter((operation) => operation.type === 'insert').length,
    deletedLineCount: operations.filter((operation) => operation.type === 'delete').length,
  };
};