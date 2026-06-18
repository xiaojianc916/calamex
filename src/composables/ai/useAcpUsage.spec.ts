import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';

import { type IUseAcpUsageReturn, useAcpUsage } from './useAcpUsage';

const mount = () => {
  const scope = effectScope();
  let api: IUseAcpUsageReturn;
  scope.run(() => {
    api = useAcpUsage();
  });

  return { api: api!, scope };
};

describe('useAcpUsage', () => {
  it('初始为空', () => {
    const { api, scope } = mount();
    expect(api.hasUsage.value).toBe(false);
    expect(api.usage.value).toBeNull();
    scope.stop();
  });

  it('applyUsageUpdate 归一并存入 VM', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(api.hasUsage.value).toBe(true);
    expect(api.usage.value).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    scope.stop();
  });

  it('整份替换（后一次覆盖前一次）', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    api.applyUsageUpdate({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(api.usage.value).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    scope.stop();
  });

  it('解析失败 no-op：保留既有用量', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    api.applyUsageUpdate({ inputTokens: 'bad', outputTokens: 1, totalTokens: 2 });
    expect(api.usage.value).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    scope.stop();
  });

  it('reset 清空', () => {
    const { api, scope } = mount();
    api.applyUsageUpdate({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    api.reset();
    expect(api.hasUsage.value).toBe(false);
    scope.stop();
  });
});
