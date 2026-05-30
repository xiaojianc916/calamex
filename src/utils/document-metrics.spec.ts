import { describe, expect, it } from 'vitest';

import { computeDocumentMetrics } from '@/utils/document-metrics';

describe('computeDocumentMetrics', () => {
  it('空字符串视为 1 行 0 字符', () => {
    expect(computeDocumentMetrics('')).toEqual({ lineCount: 1, charCount: 0 });
  });

  it('行数与 split 一致，字符数按码点计', () => {
    const content = 'a\nbb\nccc';
    expect(computeDocumentMetrics(content)).toEqual({
      lineCount: content.split('\n').length,
      charCount: Array.from(content).length,
    });
  });

  it('末尾换行符计入新的一行', () => {
    const content = 'line\n';
    expect(computeDocumentMetrics(content).lineCount).toBe(content.split('\n').length);
  });

  it('代理对（emoji）记为单个字符', () => {
    const content = '😀a😀';
    expect(computeDocumentMetrics(content)).toEqual({
      lineCount: 1,
      charCount: Array.from(content).length,
    });
  });

  it('多行含 emoji 文本，与 split + Array.from 旧实现结果一致', () => {
    const content = '第一行 😀\n第二行 𝟙𝟚\n③';
    expect(computeDocumentMetrics(content)).toEqual({
      lineCount: content.split('\n').length,
      charCount: Array.from(content).length,
    });
  });
});
