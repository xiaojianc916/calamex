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
  it('Worker 结果事务只应