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
  createShikiHighlightRequestKey,
  findUncachedLineRange,
  isShikiHighlightRangeCovered,
  resolveShikiHighlightUpdateAction,
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

  it('lead-in 与 overscan 非对称：上沿用 leadInLines，下沿用 overscanLines', () => {
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 300,
        lastVisibleLine: 360,
        totalLines: 1000,
        overscanLines: 120,
        leadInLines: 200,
        fromDocumentStart: false,
      }),
    ).toEqual({ startLine: 100, endLine: 480 });
  });

  it('leadInLines 未传时默认等于 overscanLines（向后兼容旧调用点）', () => {
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 300,
        lastVisibleLine: 360,
        totalLines: 1000,
        overscanLines: 50,
        fromDocumentStart: false,
      }),
    ).toEqual({ startLine: 250, endLine: 410 });
  });

  it('fromDocumentStart=true 时 leadInLines 不影响上沿（恒为第 1 行）', () => {
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 300,
        lastVisibleLine: 360,
        totalLines: 1000,
        overscanLines: 120,
        leadInLines: 200,
        fromDocumentStart: true,
      }),
    ).toEqual({ startLine: 1, endLine: 480 });
  });

  it('chunkLines 把下沿向上取整到块边界（滚动时切片按块稳定）', () => {
    // 380 + 40 = 420 → 向上取整到 512 的整数倍 = 512
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 300,
        lastVisibleLine: 380,
        totalLines: 5000,
        overscanLines: 40,
        fromDocumentStart: true,
        chunkLines: 512,
      }),
    ).toEqual({ startLine: 1, endLine: 512 });
  });

  it('chunkLines 量化后的下沿仍夹取到文档末行', () => {
    // 980 + 40 = 1020 → 取整到 1024 → 夹取到 1000
    expect(
      computeShikiHighlightRange({
        firstVisibleLine: 900,
        lastVisibleLine: 980,
        totalLines: 1000,
        overscanLines: 40,
        fromDocumentStart: true,
        chunkLines: 512,
      }),
    ).toEqual({ startLine: 1, endLine: 1000 });
  });

  it('同一块内视口移动产生相同量化下沿（切片串稳定的前提）', () => {
    const a = computeShikiHighlightRange({
      firstVisibleLine: 10,
      lastVisibleLine: 60,
      totalLines: 5000,
      overscanLines: 40,
      fromDocumentStart: true,
      chunkLines: 512,
    });
    const b = computeShikiHighlightRange({
      firstVisibleLine: 80,
      lastVisibleLine: 130,
      totalLines: 5000,
      overscanLines: 40,
      fromDocumentStart: true,
      chunkLines: 512,
    });
    expect(a.endLine).toBe(b.endLine);
    expect(a.endLine).toBe(512);
  });
});

describe('isShikiHighlightRangeCovered', () => {
  it('请求范围完全落在已覆盖范围内时返回 true', () => {
    expect(
      isShikiHighlightRangeCovered({
        coveredStartLine: 1,
        coveredEndLine: 200,
        requestedStartLine: 80,
        requestedEndLine: 120,
      }),
    ).toBe(true);
  });

  it('已覆盖范围缺失或只部分相交时返回 false', () => {
    expect(
      isShikiHighlightRangeCovered({
        coveredStartLine: null,
        coveredEndLine: 200,
        requestedStartLine: 80,
        requestedEndLine: 120,
      }),
    ).toBe(false);

    expect(
      isShikiHighlightRangeCovered({
        coveredStartLine: 80,
        coveredEndLine: 120,
        requestedStartLine: 60,
        requestedEndLine: 100,
      }),
    ).toBe(false);
  });
});

describe('createShikiHighlightRequestKey', () => {
  it('同一文档版本、语言和切片范围生成稳定 key', () => {
    expect(
      createShikiHighlightRequestKey({
        language: 'typescript',
        docVersion: 3,
        startLine: 1,
        endLine: 120,
        codeLength: 4096,
      }),
    ).toBe('typescript:3:1:120:4096');
  });

  it('文档版本变化会得到不同 key，避免旧切片复用', () => {
    const base = {
      language: 'typescript',
      startLine: 1,
      endLine: 120,
      codeLength: 4096,
    };

    expect(createShikiHighlightRequestKey({ ...base, docVersion: 3 })).not.toBe(
      createShikiHighlightRequestKey({ ...base, docVersion: 4 }),
    );
  });
});

describe('findUncachedLineRange', () => {
  it('全部命中缓存时返回 null（无需重新 tokenize）', () => {
    const cached = new Set([1, 2, 3, 4, 5]);
    expect(
      findUncachedLineRange({ startLine: 1, endLine: 5, isCached: (line) => cached.has(line) }),
    ).toBeNull();
  });

  it('返回缺失行的最小包络范围', () => {
    const cached = new Set([1, 2, 5]);
    expect(
      findUncachedLineRange({ startLine: 1, endLine: 5, isCached: (line) => cached.has(line) }),
    ).toEqual({ startLine: 3, endLine: 4 });
  });

  it('缺失行不连续时返回首末包络（含中间已缓存行）', () => {
    const cached = new Set([1, 3, 5]);
    expect(
      findUncachedLineRange({ startLine: 1, endLine: 5, isCached: (line) => cached.has(line) }),
    ).toEqual({ startLine: 2, endLine: 4 });
  });

  it('整段都未缓存时返回整段', () => {
    const cached = new Set<number>();
    expect(
      findUncachedLineRange({ startLine: 10, endLine: 14, isCached: (line) => cached.has(line) }),
    ).toEqual({ startLine: 10, endLine: 14 });
  });

  it('仅末尾未缓存时上沿等于首个缺失行', () => {
    const cached = new Set([10, 11, 12]);
    expect(
      findUncachedLineRange({ startLine: 10, endLine: 14, isCached: (line) => cached.has(line) }),
    ).toEqual({ startLine: 13, endLine: 14 });
  });
});
