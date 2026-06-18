import { describe, expect, it } from 'vitest';

import { parseAcpUsage } from './from-acp-usage';

describe('parseAcpUsage', () => {
  it('解析合法用量（三必填 token 字段）', () => {
    expect(parseAcpUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('strip 未声明字段并保留 raw 透传', () => {
    expect(
      parseAcpUsage({
        inputTokens: 1,
        outputTokens: 2,
        totalTokens: 3,
        provider: 'kimi',
        raw: { foo: 'bar' },
      }),
    ).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3, raw: { foo: 'bar' } });
  });

  it('缺必填字段返回 null', () => {
    expect(parseAcpUsage({ inputTokens: 10, outputTokens: 5 })).toBeNull();
  });

  it('字段类型不符返回 null', () => {
    expect(parseAcpUsage({ inputTokens: '10', outputTokens: 5, totalTokens: 15 })).toBeNull();
    expect(parseAcpUsage({ inputTokens: -1, outputTokens: 5, totalTokens: 15 })).toBeNull();
  });

  it('非对象返回 null', () => {
    expect(parseAcpUsage(null)).toBeNull();
    expect(parseAcpUsage(42)).toBeNull();
    expect(parseAcpUsage('usage')).toBeNull();
  });
});
