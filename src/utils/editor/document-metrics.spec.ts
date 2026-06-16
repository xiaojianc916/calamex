import { describe, expect, it } from 'vitest';

import { computeDocumentMetrics } from '@/utils/editor/document-metrics';

describe('computeDocumentMetrics', () => {
  it('空字符串视为 1 行 0 字符', () => {
    expect(computeDocumentMetrics('')).toEqual({ lineCount: 1, charCount: 0 });
  });

  it('单行纯 ASCII：字符数等于字符串长度', () => {
    expect(computeDocumentMetrics('hello')).toEqual({ lineCount: 1, charCount: 5 });
  });

  it('多行文本按 \\n 计行，换行符本身计入字符数', () => {
    // a \n b b \n c c c → 3 行、8 个码点（含两个换行符）
    expect(computeDocumentMetrics('a\nbb\nccc')).toEqual({ lineCount: 3, charCount: 8 });
  });

  it('末尾换行符额外计入一行', () => {
    expect(computeDocumentMetrics('line\n')).toEqual({ lineCount: 2, charCount: 5 });
  });

  it('CRLF 中的 \\r 计入字符但不额外计行', () => {
    expect(computeDocumentMetrics('a\r\nb')).toEqual({ lineCount: 2, charCount: 4 });
  });

  it('代理对 emoji 记为单个码点', () => {
    expect(computeDocumentMetrics('😀a😀')).toEqual({ lineCount: 1, charCount: 3 });
  });

  it('多行混合 emoji 与数学双线数字均按码点计数', () => {
    // '第一行 😀'=5 + '\n'=1 + '第二行 𝟙𝟚'=6 + '\n'=1 + '③'=1 → 14 码点、3 行
    expect(computeDocumentMetrics('第一行 😀\n第二行 𝟙𝟚\n③')).toEqual({
      lineCount: 3,
      charCount: 14,
    });
  });

  it('结尾处孤立的高位代理项不会越界，按单码点计数', () => {
    expect(computeDocumentMetrics('a\uD83D')).toEqual({ lineCount: 1, charCount: 2 });
  });
});
