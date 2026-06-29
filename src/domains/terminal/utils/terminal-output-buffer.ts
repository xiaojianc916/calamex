import { isLowSurrogateAt } from '@/utils/core/surrogate';

export type TTerminalOutputBufferOptions = {
  maxLength: number;
  maxChunkLength: number;
};

/**
 * 把可能在 UTF-16 代理对中间截断的字符串按 code point 边界修正。
 */
const trimLeadingCodeUnitBoundary = (value: string, startIndex: number): string => {
  if (startIndex <= 0) return value;
  if (startIndex >= value.length) return '';
  let sliced = value.slice(startIndex);
  if (!sliced) {
    return '';
  }
  if (isLowSurrogateAt(sliced, 0)) {
    sliced = sliced.slice(1);
  }
  return sliced;
};

/**
 * 终端输出是典型的 append-tail / trim-head 工作负载。
 *
 * 直接对数组频繁 shift() 会在大输出时触发 O(n) 前移；这里用 head 游标实现
 * deque/ring-buffer 风格的均摊 O(1) 头部裁剪，并在 head 积累到一定规模后压缩数组。
 */
export const createTerminalOutputBuffer = ({
  maxLength,
  maxChunkLength,
}: TTerminalOutputBufferOptions) => {
  let chunks: string[] = [];
  let head = 0;
  let totalLength = 0;

  const compactIfNeeded = (): void => {
    if (head === 0) {
      return;
    }
    if (head < 32 && head * 2 < chunks.length) {
      return;
    }
    chunks = chunks.slice(head);
    head = 0;
  };

  const clear = (): void => {
    chunks = [];
    head = 0;
    totalLength = 0;
  };

  const trimOverflow = (): void => {
    let overflow = totalLength - maxLength;
    while (overflow > 0 && head < chunks.length) {
      const firstChunk = chunks[head];
      if (firstChunk.length <= overflow) {
        overflow -= firstChunk.length;
        totalLength -= firstChunk.length;
        head += 1;
        continue;
      }

      const trimmedChunk = trimLeadingCodeUnitBoundary(firstChunk, overflow);
      totalLength -= firstChunk.length - trimmedChunk.length;
      overflow = 0;
      if (trimmedChunk.length > 0) {
        chunks[head] = trimmedChunk;
      } else {
        head += 1;
      }
    }
    compactIfNeeded();
  };

  const append = (value: string): boolean => {
    if (!value) {
      return false;
    }

    const lastIndex = chunks.length - 1;
    if (lastIndex >= head && chunks[lastIndex].length + value.length <= maxChunkLength) {
      chunks[lastIndex] += value;
    } else {
      chunks.push(value);
    }

    totalLength += value.length;
    trimOverflow();
    return true;
  };

  const replaceWithChunks = (nextChunks: readonly string[]): void => {
    clear();
    for (const chunk of nextChunks) {
      append(chunk);
    }
  };

  const replaceWithText = (value: string): void => {
    clear();
    append(value);
  };

  return {
    get length() {
      return totalLength;
    },
    append,
    replaceWithChunks,
    replaceWithText,
    clear,
    snapshotChunks: (): string[] => chunks.slice(head),
    toString: (): string => chunks.slice(head).join(''),
  };
};
