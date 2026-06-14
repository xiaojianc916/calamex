import { beforeEach, describe, expect, it, vi } from 'vitest';

// 全面 mock tokenlens:不依赖其真实导出表,只提供适配器用到的几个 helper。
vi.mock('tokenlens', () => ({
  getModels: vi.fn(() => ({ kind: 'static' })),
  fetchModels: vi.fn(),
  getContext: vi.fn(),
  getTokenCosts: vi.fn(),
}));

import * as tokenlens from 'tokenlens';
import {
  getModelContextWindow,
  getModelFacts,
  getModelMaxOutputTokens,
  refreshModelCatalogFromRemote,
} from '@/lib/model-catalog';

// 通过 cast 访问桩,避免依赖 tokenlens 真实类型表面(版本间可能变动)。
type MockFn = ReturnType<typeof vi.fn>;
const tl = tokenlens as unknown as {
  getModels: MockFn;
  fetchModels: MockFn;
  getContext: MockFn;
  getTokenCosts: MockFn;
};

beforeEach(() => {
  vi.clearAllMocks();
  tl.getModels.mockReturnValue({ kind: 'static' });
});

describe('getModelContextWindow', () => {
  it('优先取 totalMax 作为上下文窗口', () => {
    tl.getContext.mockReturnValue({ totalMax: 200_000, inputMax: 150_000 });
    expect(getModelContextWindow('anthropic/claude-x')).toBe(200_000);
  });

  it('无 total 类字段时回退到 maxInput 等变体', () => {
    tl.getContext.mockReturnValue({ maxInput: 128_000 });
    expect(getModelContextWindow('foo/bar')).toBe(128_000);
  });

  it('getContext 抛错时返回 undefined(不崩溃)', () => {
    tl.getContext.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(getModelContextWindow('x/y')).toBeUndefined();
  });

  it('非正数/缺失字段视为未知', () => {
    tl.getContext.mockReturnValue({ totalMax: 0, inputMax: -1, maxInput: Number.NaN });
    expect(getModelContextWindow('x/y')).toBeUndefined();
  });

  it('getContext 返回非对象时返回 undefined', () => {
    tl.getContext.mockReturnValue(undefined);
    expect(getModelContextWindow('x/y')).toBeUndefined();
  });
});

describe('getModelMaxOutputTokens', () => {
  it('读取 outputMax', () => {
    tl.getContext.mockReturnValue({ outputMax: 8_192 });
    expect(getModelMaxOutputTokens('x/y')).toBe(8_192);
  });

  it('回退到 maxOutput 变体', () => {
    tl.getContext.mockReturnValue({ maxOutput: 4_096 });
    expect(getModelMaxOutputTokens('x/y')).toBe(4_096);
  });
});

describe('getModelFacts', () => {
  it('解析到任一事实时 source 为 catalog,并按百万 token 估算单价', () => {
    tl.getContext.mockReturnValue({ totalMax: 100, outputMax: 50 });
    tl.getTokenCosts.mockImplementation((_id: string, usage: unknown) => {
      const u = usage as { prompt_tokens: number; completion_tokens: number };
      return {
        inputUSD: u.prompt_tokens > 0 ? 3 : 0,
        outputUSD: u.completion_tokens > 0 ? 15 : 0,
      };
    });
    expect(getModelFacts('x/y')).toMatchObject({
      contextWindow: 100,
      maxOutputTokens: 50,
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      source: 'catalog',
    });
  });

  it('什么都解析不到时 source 为 unknown', () => {
    tl.getContext.mockReturnValue(undefined);
    tl.getTokenCosts.mockReturnValue(undefined);
    const facts = getModelFacts('x/y');
    expect(facts.source).toBe('unknown');
    expect(facts.contextWindow).toBeUndefined();
    expect(facts.inputUsdPerMillion).toBeUndefined();
  });

  it('getTokenCosts 抛错不影响其他事实', () => {
    tl.getContext.mockReturnValue({ totalMax: 100 });
    tl.getTokenCosts.mockImplementation(() => {
      throw new Error('no pricing');
    });
    const facts = getModelFacts('x/y');
    expect(facts.contextWindow).toBe(100);
    expect(facts.inputUsdPerMillion).toBeUndefined();
    expect(facts.source).toBe('catalog');
  });
});

describe('refreshModelCatalogFromRemote', () => {
  it('联网失败时静默降级返回 false', async () => {
    tl.fetchModels.mockRejectedValue(new Error('offline'));
    await expect(refreshModelCatalogFromRemote()).resolves.toBe(false);
  });

  it('拉取成功时返回 true', async () => {
    tl.fetchModels.mockResolvedValue({ kind: 'remote' });
    await expect(refreshModelCatalogFromRemote()).resolves.toBe(true);
  });
});
