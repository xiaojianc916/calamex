import { describe, expect, it, vi } from 'vitest';

// 避免在测试环境加载真实 Shiki/Oniguruma 包；本用例只验证纯决策/计算函数。
vi.mock('@/services/editor/shiki-highlighter', () => ({
  tokenizeWithShikiWorker: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('@/services/editor/shiki-shared', () => ({
  resolveShikiLanguageId: vi.fn(() => null),
  SHIKI_BACKGROUND: '#ffffff',
  SHIKI_FOREGROUND: '#000000',
}));

import {
  computeShikiHighlightRange,
  resolveShikiHighlightUpdateAction,
  tokenStyleDeclarations,
} from './codemirror-shiki-highlight';

describe('resolveShikiHighlightUpdateAction', () => {
  it('Worker 结果事务只应用结果，不额外重算', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: false,
        recomputeRequested: false,
        workerResultReceived: true,
        docChanged: false,
      }),
    ).toBe('skip');
  });

  it('语言切换时立即重算', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: true,
        recomputeRequested: false,
        docChanged: true,
      }),
    ).toBe('recompute');
  });

  it('收到重算请求（防抖超时）时重算', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: false,
        recomputeRequested: true,
        docChanged: false,
      }),
    ).toBe('recompute');
  });

  it('仅文档变化时只做位移映射，不重新 tokenize', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: false,
        recomputeRequested: false,
        docChanged: true,
      }),
    ).toBe('remap');
  });

  it('仅视口变化（滚动）时重新 tokenize 可见区域', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: false,
        recomputeRequested: false,
        docChanged: false,
        viewportChanged: true,
      }),
    ).toBe('recompute');
  });

  it('文档变化优先于视口变化，走位移映射', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: false,
        recomputeRequested: false,
        docChanged: true,
        viewportChanged: true,
      }),
    ).toBe('remap');
  });

  it('无相关变化时跳过', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: false,
        recomputeRequested: false,
        docChanged: false,
      }),
    ).toBe('skip');
  });
});

describe('computeShikiHighlightRange', () => {
  it('默认从文档首行切片，下沿按可见区 + overscan', () => {
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 100,
        lastVisibleLine: 160,
        totalLines: 500,
        overscanLines: 40,
        fromDocumentStart: true,
      }),
    ).toEqual({ startLine: 1, endLine: 200 });
  });

  it('从文档首行切片时下沿夹取到文档末行', () => {
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 460,
        lastVisibleLine: 500,
        totalLines: 500,
        overscanLines: 40,
        fromDocumentStart: true,
      }),
    ).toEqual({ startLine: 1, endLine: 500 });
  });

  it('退化为窗口时上沿按可见区 - overscan，并夹取到第 1 行', () => {
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 30,
        lastVisibleLine: 90,
        totalLines: 500,
        overscanLines: 40,
        fromDocumentStart: false,
      }),
    ).toEqual({ startLine: 1, endLine: 130 });
  });

  it('退化为窗口时上沿随可见区下移而大于 1', () => {
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 300,
        lastVisibleLine: 360,
        totalLines: 1000,
        overscanLines: 40,
        fromDocumentStart: false,
      }),
    ).toEqual({ startLine: 260, endLine: 400 });
  });
});

describe('tokenStyleDeclarations', () => {
  it('仅有前景色时只产出 color 声明', () => {
    expect(tokenStyleDeclarations({ content: 'x', offset: 0, color: '#24292f' })).toBe(
      'color:#24292f',
    );
  });

  it('组合前景色 / 背景色与 italic+bold+underline 字形', () => {
    expect(
      tokenStyleDeclarations({
        content: 'x',
        offset: 0,
        color: '#cf222e',
        bgColor: '#ffffff',
        fontStyle: 1 | 2 | 4,
      }),
    ).toBe(
      'color:#cf222e;background-color:#ffffff;font-style:italic;font-weight:600;text-decoration:underline',
    );
  });

  it('无任何样式信息时产出空串', () => {
    expect(tokenStyleDeclarations({ content: 'x', offset: 0 })).toBe('');
  });
});
