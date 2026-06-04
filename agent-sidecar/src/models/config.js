import { getProviderConfig, ModelRouterLanguageModel, parseModelString, } from '@mastra/core/llm';
import { AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID, createDeepSeekGatewayModelId, createDeepSeekMastraGateway, } from './providers/deepseek-mastra-gateway.js';
const MODEL_ID_ENV = 'AGENT_SIDECAR_MODEL';
const API_KEY_ENV = 'AGENT_SIDECAR_API_KEY';
const BASE_URL_ENV = 'AGENT_SIDECAR_BASE_URL';
const OBSERVER_MODEL_ID_ENV = 'AGENT_SIDECAR_OBSERVER_MODEL';
const REFLECTOR_MODEL_ID_ENV = 'AGENT_SIDECAR_REFLECTOR_MODEL';
const DEFAULT_MODEL_ID = 'deepseek/deepseek-v4-flash';
const SMALL_MODEL_BY_PROVIDER = {
    openai: 'openai/gpt-5.4-mini',
    anthropic: 'anthropic/claude-haiku-4-5',
    deepseek: 'deepseek/deepseek-v4-flash',
    google: 'google/gemini-3.1-flash-lite',
    alibaba: 'alibaba/qwen3.6-flash',
    zhipuai: 'zhipuai/glm-4.7-flash',
    moonshotai: 'moonshotai/kimi-k2-turbo-preview',
};
const readEnv = (key, env = process.env) => {
    const value = env[key]?.trim();
    return value ? value : null;
};
const normalizeBaseUrl = (value) => value.trim().replace(/\/+$/u, '');
const assertValidUrl = (value, source) => {
    try {
        new URL(value);
    }
    catch {
        throw new Error(`[mastra-model-config] ${source} 不是合法的 URL: "${value}"`);
    }
    return value;
};
const resolveProviderModelId = (modelId) => {
    const parsed = parseModelString(modelId);
    const providerId = parsed.provider?.trim();
    const providerModelId = parsed.modelId.trim();
    if (!providerId || !providerModelId) {
        throw new Error(`[mastra-model-config] 模型标识必须使用 provider/model 形式，当前收到：${modelId}`);
    }
    return {
        providerId,
        providerModelId,
    };
};
const resolveProviderBaseUrl = (providerId, explicitBaseUrl) => {
    const rawBaseUrl = explicitBaseUrl ?? getProviderConfig(providerId)?.url?.trim();
    if (!rawBaseUrl) {
        return undefined;
    }
    return assertValidUrl(normalizeBaseUrl(rawBaseUrl), BASE_URL_ENV);
};
const createCustomGateways = (options) => {
    if (options.providerId !== AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID) {
        return [];
    }
    return [
        createDeepSeekMastraGateway({
            apiKey: options.apiKey,
            baseUrl: options.baseUrl,
        }),
    ];
};
const createMastraModel = (options) => {
    if (options.providerId === AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID) {
        return new ModelRouterLanguageModel(createDeepSeekGatewayModelId(options.providerModelId), options.customGateways);
    }
    return new ModelRouterLanguageModel({
        providerId: options.providerId,
        modelId: options.providerModelId,
        ...(options.baseUrl ? { url: options.baseUrl } : {}),
        apiKey: options.apiKey,
    }, options.customGateways);
};
export const createMastraOpenAICompatibleModelConfig = (options) => {
    const normalizedModelId = options.modelId.trim();
    if (!normalizedModelId) {
        throw new Error('[mastra-model-config] modelId 不能为空。');
    }
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
        throw new Error('[mastra-model-config] apiKey 不能为空。');
    }
    const { providerId, providerModelId, } = resolveProviderModelId(normalizedModelId);
    const baseUrl = resolveProviderBaseUrl(providerId, options.baseUrl?.trim() ?? null);
    const customGateways = createCustomGateways({
        providerId,
        apiKey,
        baseUrl,
    });
    return {
        modelId: normalizedModelId,
        providerId,
        providerModelId,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        model: createMastraModel({
            providerId,
            providerModelId,
            apiKey,
            ...(baseUrl ? { baseUrl } : {}),
            customGateways,
        }),
        customGateways,
    };
};
export const createMastraModelConfigFromRequest = (input) => {
    if (!input) {
        return null;
    }
    const modelId = input.modelId.trim();
    const apiKey = input.apiKey.trim();
    const baseUrl = input.baseUrl?.trim();
    if (!modelId || !apiKey) {
        return null;
    }
    return createMastraOpenAICompatibleModelConfig({
        modelId,
        apiKey,
        baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : undefined,
    });
};
export const createMastraModelConfigFromEnv = (env = process.env) => {
    const apiKey = readEnv(API_KEY_ENV, env);
    if (!apiKey) {
        return null;
    }
    return createMastraOpenAICompatibleModelConfig({
        modelId: readEnv(MODEL_ID_ENV, env) ?? DEFAULT_MODEL_ID,
        apiKey,
        baseUrl: readEnv(BASE_URL_ENV, env) ?? undefined,
    });
};
const resolveSmallModelId = (baseModel) => SMALL_MODEL_BY_PROVIDER[baseModel.providerId] ?? baseModel.modelId;
const resolveBackgroundModelOverride = (envKey, baseModel, env = process.env) => {
    const modelId = readEnv(envKey, env) ?? resolveSmallModelId(baseModel);
    return createMastraOpenAICompatibleModelConfig({
        modelId,
        apiKey: baseModel.apiKey,
        baseUrl: baseModel.baseUrl,
    });
};
export const createMastraObserverModelConfig = (baseModel, env = process.env) => resolveBackgroundModelOverride(OBSERVER_MODEL_ID_ENV, baseModel, env);
export const createMastraReflectorModelConfig = (baseModel, env = process.env) => resolveBackgroundModelOverride(REFLECTOR_MODEL_ID_ENV, baseModel, env);
