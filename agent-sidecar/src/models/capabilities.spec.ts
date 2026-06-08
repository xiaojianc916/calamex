import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveAgentModelCapabilities,
  resolveAgentModelCapabilitiesFromModelId,
  selectPreferredBackgroundModelId,
} from './capabilities.js';

test('resolveAgentModelCapabilitiesFromModelId：解析 provider/model 并填充 DeepSeek 能力', () => {
  const capabilities = resolveAgentModelCapabilitiesFromModelId('deepseek/deepseek-v4-pro');

  assert.equal(capabilities.providerId, 'deepseek');
  assert.equal(capabilities.providerModelId, 'deepseek-v4-pro');
  assert.equal(capabilities.modelId, 'deepseek/deepseek-v4-pro');
  assert.equal(capabilities.supportsTools, true);
  assert.equal(capabilities.supportsStreamingTools, true);
  assert.equal(capabilities.supportsThinking, true);
  assert.equal(capabilities.supportsImages, false);
  assert.equal(capabilities.toolSchemaFormat, 'openai-compatible');
  assert.equal(selectPreferredBackgroundModelId(capabilities), 'deepseek/deepseek-v4-flash');
});

test('resolveAgentModelCapabilities：Google Gemini 3 默认 thinking effort 使用模型族规则', () => {
  const flash = resolveAgentModelCapabilities({
    providerId: 'google',
    providerModelId: 'gemini-3.5-flash',
  });
  const pro = resolveAgentModelCapabilities({
    providerId: 'google',
    providerModelId: 'gemini-3.1-pro-preview',
  });

  assert.equal(flash.supportsThinking, true);
  assert.equal(flash.defaultThinkingEffort, 'minimal');
  assert.equal(pro.supportsThinking, true);
  assert.equal(pro.defaultThinkingEffort, 'high');
  assert.equal(pro.contextWindowTokens, 1_048_576);
  assert.equal(pro.maxOutputTokens, 65_536);
});

test('resolveAgentModelCapabilities：OpenAI 只有推理模型默认标记 thinking', () => {
  const gpt4 = resolveAgentModelCapabilitiesFromModelId('openai/gpt-4.1');
  const gpt5 = resolveAgentModelCapabilitiesFromModelId('openai/gpt-5.4');
  const oModel = resolveAgentModelCapabilitiesFromModelId('openai/o3');

  assert.equal(gpt4.supportsThinking, false);
  assert.equal(gpt5.supportsThinking, true);
  assert.equal(oModel.supportsThinking, true);
  assert.equal(gpt5.supportsPromptCacheKey, true);
});

test('resolveAgentModelCapabilities：未知 provider fail-soft 但不声明高级能力', () => {
  const capabilities = resolveAgentModelCapabilitiesFromModelId('custom/my-local-model');

  assert.equal(capabilities.providerId, 'custom');
  assert.equal(capabilities.providerModelId, 'my-local-model');
  assert.equal(capabilities.supportsTools, true);
  assert.equal(capabilities.supportsStreamingTools, false);
  assert.equal(capabilities.supportsParallelToolCalls, false);
  assert.equal(capabilities.supportsImages, false);
  assert.equal(capabilities.supportsThinking, false);
  assert.equal(capabilities.toolSchemaFormat, 'json-schema');
  assert.equal(selectPreferredBackgroundModelId(capabilities), 'custom/my-local-model');
});

test('resolveAgentModelCapabilitiesFromModelId：拒绝不带 provider 的模型标识', () => {
  assert.throws(
    () => resolveAgentModelCapabilitiesFromModelId('deepseek-v4-pro'),
    /provider\/model/u,
  );
});
