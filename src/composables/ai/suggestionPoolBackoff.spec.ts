import { describe, expect, it } from 'vitest';
import {
  computeBackoffDelayMs,
  SUGGESTION_POOL_RETRY_BASE_MS,
  SUGGESTION_POOL_RETRY_MAX_MS,
} from '@/composables/ai/suggestionPoolBackoff';

describe('computeBackoffDelayMs', () => {
  it('从 base 开始按 2 的幂次递增', () => {
    expect(computeBackoffDelayMs(0)).toBe(SUGGESTION_POOL_RETRY_BASE_MS);
    expect(computeBackoffDelayMs(1)).toBe(SUGGESTION_POOL_RETRY_BASE_MS * 2);
    expect(computeBackoffDelayMs(2)).toBe(SUGGESTION_POOL_RETRY_BASE_MS * 4);
    expect(computeBackoffDelayMs(3)).toBe(SUGGESTION_POOL_RETRY_BASE_MS * 8);
  });

  it('封顶在 max，绝不无限增长', () => {
    expect(computeBackoffDelayMs(100)).toBe(SUGGESTION_POOL_RETRY_MAX_MS);
  });

  it('对非法 attempt 退化为首个延迟', () => {
    expect(computeBackoffDelayMs(-5)).toBe(SUGGESTION_POOL_RETRY_BASE_MS);
    expect(computeBackoffDelayMs(Number.NaN)).toBe(SUGGESTION_POOL_RETRY_BASE_MS);
    expect(computeBackoffDelayMs(Number.POSITIVE_INFINITY)).toBe(SUGGESTION_POOL_RETRY_BASE_MS);
  });

  it('尊重自定义 base/max', () => {
    expect(computeBackoffDelayMs(2, 500, 10_000)).toBe(2_000);
    expect(computeBackoffDelayMs(10, 500, 10_000)).toBe(10_000);
  });
});
