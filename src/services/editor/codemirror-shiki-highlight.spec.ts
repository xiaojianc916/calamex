import { describe, expect, it, vi } from 'vitest';

// 避免在测试环境加载真实 Shiki/Oniguruma 包；本用例只验证纯决策函数。
vi.mock('@/services/editor/shiki-highlighter', () => ({
  ensureShikiLanguage: vi.fn(),
  isShikiLanguageLoaded: vi.fn(() => false),
  resolveShikiLanguageId: vi.fn(() => null),
  tokenizeWithShikiSync: vi.fn(() => null),
  SHIKI_BACKGROUND: '#ffffff',
  SHIKI_FOREGROUND: '#000000',
}));

import { resolveShikiHighlightUpdateAction } from './codemirror-shiki-highlight';

describe('resolveShikiHighlightUpdateAction', () => {
  it('语言切换时立即重算', () => {
    expect(
      resolveShikiHighlightUpdateAction({
        languageChanged: true,
        recomputeRequested: false,
        docChanged: true,
      }),
    ).toBe('recompute');
  });

  it('收到重算请求（语法加载完成/防抖超时）时重算', () => {
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
