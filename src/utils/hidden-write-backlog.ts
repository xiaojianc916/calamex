import { createTerminalOutputBuffer } from '@/utils/terminal-output-buffer';

export type THiddenWriteBacklogOptions = {
  /** backlog 总字符上限（含省略提示标记）。 */
  maxChars: number;
  /** 单个内部 chunk 的最大字符数，用于合并细碎写入。 */
  maxChunkChars: number;
  /** 头部发生丢弃时，回灌内容前补上的可见提示标记。 */
  omittedMarker: string;
};

/**
 * 终端面板隐藏期间到达的输出先缓存在这里，待面板重新可见时一次性回灌。
 *
 * 旧实现用 previous + value 全量字符串拼接再 slice，在「离屏 + 高吞吐」场景下是
 * O(n²)（每个 chunk 复制整段 backlog）。这里复用 ring-buffer 风格的有界尾缓冲：
 * append 均摊 O(1)，超出预算时按 code point 边界从头部丢弃（不会劈开 UTF-16 代理对）；
 * 一旦发生丢弃，drain 时在最前面补上 omittedMarker，保持原有「已省略」的可见语义。
 */
export const createHiddenWriteBacklog = ({
  maxChars,
  maxChunkChars,
  omittedMarker,
}: THiddenWriteBacklogOptions) => {
  // 预留 marker 长度，保证补上提示后的总长度仍不超过 maxChars。
  const capacity = Math.max(0, maxChars - omittedMarker.length);
  const buffer = createTerminalOutputBuffer({
    maxLength: capacity,
    maxChunkLength: maxChunkChars,
  });
  let truncated = false;

  const append = (value: string): void => {
    if (!value) return;
    const lengthBefore = buffer.length;
    buffer.append(value);
    // 写入总量超过容量 => 头部一定发生了丢弃。
    if (lengthBefore + value.length > buffer.length) {
      truncated = true;
    }
  };

  const drain = (): string => {
    const body = buffer.toString();
    const result = truncated ? omittedMarker + body : body;
    buffer.clear();
    truncated = false;
    return result;
  };

  const clear = (): void => {
    buffer.clear();
    truncated = false;
  };

  return {
    /** 近似的已缓存字符数，仅供诊断展示。 */
    get length(): number {
      return truncated ? omittedMarker.length + buffer.length : buffer.length;
    },
    get isEmpty(): boolean {
      return buffer.length === 0 && !truncated;
    },
    append,
    drain,
    clear,
  };
};
