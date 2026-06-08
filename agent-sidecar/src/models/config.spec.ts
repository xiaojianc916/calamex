import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMastraModelConfigFromEnv,
  createMastraModelConfigFromRequest,
  createMastraObserverModelConfig,
  createMastraOpenAICompatibleModelConfig,
  createMastraReflectorModelConfig,
} from './config.js';

test('createMastraModelConfigFromRequest：规范化请求级 baseUrl 并附带模型能力', () => {
  const config = createMastraModelConfigFromRequest({
    modelId: ' deepseek/deepseek-v4-pro ',
    apiKey: ' test-key ',
    baseUrl: ' https://api.deepseek.com/v1/// ',
  });

  assert.ok(config);
  assert.equal(config.modelId, 'deepseek/deepseek-v4-pro');
  assert.equal(config.providerId, 'deepseek');
  assert.equal(config.providerModelId, 'deepseek-v4-pro');
  assert.equal(config.apiKey, 'test-key');
  assert.equal(config.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(config.capabilities.modelId, 'deepseek/deepseek-v4-pro');
  assert.equal(config.capabilities.supportsTools, true);
  assert.equal(config.capabilities.supportsStreamingTools, true);
  assert.equal(config.capabilities.supportsThinking, true);
  assert.equal(config.capabilities.toolSchemaFormat, 'openai-compatible');
});

test('createMastraOpenAICompatibleModelConfig：拒绝非 HTTP(S) baseUrl', () => {
  for (const baseUrl of ['file:///tmp/llm', 'ftp://example.com/model']) {
    assert.throws(
      () => createMastraOpenAICompatibleModelConfig({
        modelId: 'deepseek/deepseek-v4-pro',
        apiKey: 'test-key',
        baseUrl,
      }),
      /仅允许 http\/https 协议/u,
      baseUrl,
    );
  }
});

test('createMastraModelConfigFromEnv：环境变量 baseUrl 使用同一套校验', () => {
  assert.throws(
    () => createMastraModelConfigFromEnv({
      AGENT_SIDECAR_API_KEY: 'test-key',
      AGENT_SIDECAR_MODEL: 'deepseek/deepseek-v4-pro',
      AGENT_SIDECAR_BASE_URL: 'file:///tmp/llm',
    }),
    /仅允许 http\/https 协议/u,
  );
});

test('background model config：默认使用 capability registry 推荐的小模型并继承鉴权边界', () => {
  const baseModel = createMastraOpenAICompatibleModelConfig({
    modelId: 'deepseek/deepseek-v4-pro',
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/v1',
  });

  const observer = createMastraObserverModelConfig(baseModel, {});
  const reflector = createMastraReflectorModelConfig(baseModel, {});

  for (const config of [observer, reflector]) {
    assert.equal(config.modelId, 'deepseek/deepseek-v4-flash');
    assert.equal(config.providerId, 'deepseek');
    assert.equal(config.providerModelId, 'deepseek-v4-flash');
    assert.equal(config.apiKey, 'test-key');
    assert.equal(config.baseUrl, 'https://api.deepseek.com/v1');
    assert.equal(config.capabilities.modelId, 'deepseek/deepseek-v4-flash');
    assert.equal(config.capabilities.supportsThinking, true);
  }
});

test('background model config：显式环境变量可覆盖后台模型', () => {
  const baseModel = createMastraOpenAICompatibleModelConfig({
    modelId: 'deepseek/deepseek-v4-pro',
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/v1',
  });

  const observer = createMastraObserverModelConfig(baseModel, {
    AGENT_SIDECAR_OBSERVER_MODEL: 'deepseek/deepseek-v4-pro',
  });
  const reflector = createMastraReflectorModelConfig(baseModel, {
    AGENT_SIDECAR_REFLECTOR_MODEL: 'deepseek/deepseek-v4-pro',
  });

  assert.equal(observer.modelId, 'deepseek/deepseek-v4-pro');
  assert.equal(reflector.modelId, 'deepseek/deepseek-v4-pro');
  assert.equal(observer.capabilities.modelId, 'deepseek/deepseek-v4-pro');
  assert.equal(reflector.capabilities.modelId, 'deepseek/deepseek-v4-pro');
});

test('background model config：未知 provider 复用基础模型但保留 fail-soft 能力边界', () => {
  const baseModel = createMastraOpenAICompatibleModelConfig({
    modelId: 'custom/my-local-model',
    apiKey: 'test-key',
  });

  const observer = createMastraObserverModelConfig(baseModel, {});

  assert.equal(observer.modelId, 'custom/my-local-model');
  assert.equal(observer.capabilities.supportsStreamingTools, false);
  assert.equal(observer.capabilities.supportsThinking, false);
  assert.equal(observer.capabilities.toolSchemaFormat, 'json-schema');
});
