import assert from 'node:assert/strict';
import { test } from 'node:test';
import { languageModelUsageSchema } from './usage.js';

test('languageModelUsageSchema 接受最小必填用量', () => {
  const parsed = languageModelUsageSchema.parse({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
  assert.equal(parsed.inputTokens, 10);
  assert.equal(parsed.outputTokens, 5);
  assert.equal(parsed.totalTokens, 15);
  assert.equal(parsed.inputTokenDetails, undefined);
  assert.equal(parsed.outputTokenDetails, undefined);
});

test('languageModelUsageSchema 接受完整的缓存 / 推理明细', () => {
  const parsed = languageModelUsageSchema.parse({
    inputTokens: 100,
    inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40, cacheWriteTokens: 0 },
    outputTokens: 50,
    outputTokenDetails: { textTokens: 40, reasoningTokens: 10 },
    totalTokens: 150,
    cachedInputTokens: 40,
    reasoningTokens: 10,
    raw: { provider: 'deepseek' },
  });
  assert.equal(parsed.inputTokenDetails?.cacheReadTokens, 40);
  assert.equal(parsed.outputTokenDetails.outputTokenDetails.reasoningTokens, 10);
  assert.deepEqual(parsed.raw, { provider: 'deepseek' });
});

test('languageModelUsageSchema 严格模式拒绝未知字段', () => {
  assert.throws(() =>
    languageModelUsageSchema.parse({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      unexpected: true,
    }),
  );
});

test('languageModelUsageSchema 严格模式拒绝明细里的未知字段', () => {
  assert.throws(() =>
    languageModelUsageSchema.parse({
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, extra: 1 },
    }),
  );
});

test('languageModelUsageSchema 拒绝负数 token', () => {
  assert.throws(() =>
    languageModelUsageSchema.parse({
      inputTokens: -1,
      outputTokens: 1,
      totalTokens: 0,
    }),
  );
});
