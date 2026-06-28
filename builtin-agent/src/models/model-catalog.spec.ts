import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getModelContextWindow,
  getModelFacts,
  getModelMaxOutputTokens,
} from './model-catalog.js';

// 使用明显不存在的模型 id,保证结果不依赖 models.dev 上游数据。
const NONEXISTENT_MODEL_ID = '__no_such_provider__/__no_such_model__';

test('getModelFacts:未知模型降级为 source=unknown 且各事实为 undefined', () => {
  const facts = getModelFacts(NONEXISTENT_MODEL_ID);

  assert.equal(facts.source, 'unknown');
  assert.equal(facts.contextWindow, undefined);
  assert.equal(facts.maxOutputTokens, undefined);
  assert.equal(facts.inputUsdPerMillion, undefined);
  assert.equal(facts.outputUsdPerMillion, undefined);
});

test('getModelContextWindow / getModelMaxOutputTokens:未知模型返回 undefined', () => {
  assert.equal(getModelContextWindow(NONEXISTENT_MODEL_ID), undefined);
  assert.equal(getModelMaxOutputTokens(NONEXISTENT_MODEL_ID), undefined);
});

test('空字符串模型 id 不报错且返回 undefined', () => {
  assert.equal(getModelContextWindow(''), undefined);
  assert.equal(getModelMaxOutputTokens('   '), undefined);
  assert.equal(getModelFacts('').source, 'unknown');
});
