import { isHighSurrogateAt } from '@/utils/core/surrogate';

export interface IDocumentMetrics {
  /** 文档行数（按 \n 切分；空文档视为 1 行）。 */
  lineCount: number;
  /** 文档字符数，按 Unicode 码点计（代理对/emoji 记为 1）。 */
  charCount: number;
}

/**
 * 单次 O(n) 扫描同时统计文档「行数」与「码点字符数」。
 *
 * 取代旧实现里每次按键都会执行的
 *   content.split('\n').length   // 分配整篇行数组
 *   Array.from(content).length   // 分配整篇码点数组
 * 这两个调用都会在整篇文档上分配大数组，大文件 + 高频输入时造成明显的 GC 压力。
 * 这里改为一次遍历、零额外数组分配。
 *
 * 语义保持与旧实现完全一致：
 *   - lineCount：等价于 `content.length === 0 ? 1 : content.split('\n').length`
 *   - charCount：等价于 `Array.from(content).length`（按码点计，正确合并 UTF-16 代理对）
 */
export const computeDocumentMetrics = (content: string): IDocumentMetrics => {
  const length = content.length;
  let lineCount = 1;
  let charCount = 0;
  for (let index = 0; index < length; index += 1) {
    const code = content.charCodeAt(index);
    if (code === 0x0a) {
      lineCount += 1;
    }
    // 高位代理项 + 紧随其后的低位代理项 → 合并为一个码点，跳过下一个 code unit
    if (isHighSurrogateAt(content, index)) {
      index += 1;
    }
    charCount += 1;
  }
  return { lineCount, charCount };
};
