import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { MastraModelGateway, } from '@mastra/core/llm';
import { deepseekReasoningFetch } from './deepseek-reasoning-fetch.js';
// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_DEEPSEEK_MODELS = [
    'deepseek-v4-flash',
    'deepseek-v4-pro',
];
const DEFAULT_API_KEY_ENV_VAR = 'AGENT_SIDECAR_API_KEY';
export const AGENT_SIDECAR_MASTRA_GATEWAY_ID = 'agent-sidecar';
export const AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID = 'deepseek';
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const toNonEmptyString = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};
const normalizeBaseUrl = (value) => value.trim().replace(/\/+$/u, '');
const assertValidHttpUrl = (value, source) => {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`[deepseek-mastra-gateway] ${source} 不是合法的 URL: "${value}"`);
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        throw new Error(`[deepseek-mastra-gateway] ${source} 仅允许 http/https 协议，收到: "${url.protocol}"`);
    }
    return value;
};
const dedupeModels = (models) => {
    const seen = new Set();
    const out = [];
    for (const raw of models) {
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        if (!trimmed || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
};
const buildGatewayProviderModelId = (providerId, modelId) => `${AGENT_SIDECAR_MASTRA_GATEWAY_ID}/${providerId}/${modelId}`;
const assertPlainOptions = (options) => {
    if (options === null || typeof options !== 'object') {
        throw new Error('[deepseek-mastra-gateway] options 不能为空。');
    }
    return options;
};
// ---------------------------------------------------------------------------
// Gateway 实现
// ---------------------------------------------------------------------------
export class DeepSeekMastraGateway extends MastraModelGateway {
    id = AGENT_SIDECAR_MASTRA_GATEWAY_ID;
    name = 'Agent Sidecar Gateway';
    apiKey;
    baseUrl;
    models;
    apiKeyEnvVar;
    gatewayPrefix;
    providerPrefix;
    constructor(options) {
        super();
        const safeOptions = assertPlainOptions(options);
        const apiKey = toNonEmptyString(safeOptions.apiKey);
        if (!apiKey) {
            throw new Error('[deepseek-mastra-gateway] apiKey 不能为空。');
        }
        this.apiKey = apiKey;
        const rawBaseUrl = toNonEmptyString(safeOptions.baseUrl) ?? DEFAULT_DEEPSEEK_BASE_URL;
        this.baseUrl = assertValidHttpUrl(normalizeBaseUrl(rawBaseUrl), 'baseUrl');
        const requested = safeOptions.models ? dedupeModels(safeOptions.models) : [];
        this.models = requested.length > 0 ? requested : [...DEFAULT_DEEPSEEK_MODELS];
        this.apiKeyEnvVar =
            toNonEmptyString(safeOptions.apiKeyEnvVar) ?? DEFAULT_API_KEY_ENV_VAR;
        this.gatewayPrefix = `${this.id}/${AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID}/`;
        this.providerPrefix = `${AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID}/`;
    }
    // -------------------------------------------------------------------------
    // 内部辅助
    // -------------------------------------------------------------------------
    /** 判断给定 modelId 是否属于本 gateway。 */
    matchesThisGateway(modelId) {
        if (modelId === AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID)
            return true;
        if (modelId.startsWith(this.gatewayPrefix)) {
            return modelId.length > this.gatewayPrefix.length;
        }
        if (modelId.startsWith(this.providerPrefix)) {
            return modelId.length > this.providerPrefix.length;
        }
        return false;
    }
    /** 把可能带前缀的 modelId 还原为 DeepSeek 原生 modelId。 */
    stripGatewayPrefix(modelId) {
        if (modelId.startsWith(this.gatewayPrefix)) {
            return modelId.slice(this.gatewayPrefix.length);
        }
        if (modelId.startsWith(this.providerPrefix)) {
            return modelId.slice(this.providerPrefix.length);
        }
        return modelId;
    }
    // -------------------------------------------------------------------------
    // MastraModelGateway 接口
    // -------------------------------------------------------------------------
    async fetchProviders() {
        return {
            [AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID]: {
                url: this.baseUrl,
                apiKeyEnvVar: this.apiKeyEnvVar,
                apiKeyHeader: 'Authorization',
                name: 'DeepSeek',
                models: [...this.models],
                gateway: this.id,
            },
        };
    }
    buildUrl(modelId, _envVars = {}) {
        const normalized = modelId.trim();
        if (!normalized)
            return undefined;
        return this.matchesThisGateway(normalized) ? this.baseUrl : undefined;
    }
    async getApiKey(_modelId) {
        return this.apiKey;
    }
    async resolveLanguageModel(args) {
        if (args.providerId !== AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID) {
            throw new Error(`[deepseek-mastra-gateway] 不支持的 provider: ${args.providerId}`);
        }
        const effectiveApiKey = toNonEmptyString(args.apiKey) ?? this.apiKey;
        const nativeModelId = this.stripGatewayPrefix(args.modelId.trim());
        if (!nativeModelId) {
            throw new Error('[deepseek-mastra-gateway] modelId 不能为空。');
        }
        return createOpenAICompatible({
            name: args.providerId,
            apiKey: effectiveApiKey,
            baseURL: this.baseUrl,
            ...(args.headers ? { headers: args.headers } : {}),
            fetch: deepseekReasoningFetch,
            supportsStructuredOutputs: true,
        }).chatModel(nativeModelId);
    }
    serializeForSpan() {
        return {
            id: this.id,
            name: this.name,
            provider: AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID,
            modelCount: this.models.length,
        };
    }
}
// ---------------------------------------------------------------------------
// 工厂 / 助手导出
// ---------------------------------------------------------------------------
export const createDeepSeekMastraGateway = (options) => new DeepSeekMastraGateway(options);
export const createDeepSeekGatewayModelId = (modelId) => buildGatewayProviderModelId(AGENT_SIDECAR_DEEPSEEK_PROVIDER_ID, modelId);
