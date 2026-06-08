export type TAgentModelProviderId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'google'
  | 'openrouter'
  | 'alibaba'
  | 'zhipuai'
  | 'moonshotai'
  | string;

export type TAgentToolSchemaFormat =
  | 'json-schema'
  | 'openai-compatible'
  | 'anthropic-compatible'
  | 'google-compatible';

export interface IAgentModelCapabilities {
  providerId: TAgentModelProviderId;
  providerModelId: string;
  modelId: string;
  supportsTools: boolean;
  supportsStreamingTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsNetworkTools: boolean;
  supportsPromptCacheKey: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  toolSchemaFormat: TAgentToolSchemaFormat;
  defaultThinkingEffort?: string;
  preferredSmallModelId?: string;
}

export interface IResolveAgentModelCapabilitiesInput {
  providerId: string;
  providerModelId: string;
  modelId?: string | undefined;
}

interface IProviderCapabilityDefaults {
  supportsTools: boolean;
  supportsStreamingTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsImages: boolean;
  supportsThinking: boolean;
  supportsNetworkTools: boolean;
  supportsPromptCacheKey: boolean;
  contextWindowTokens: number;
  maxOutputTokens: number;
  toolSchemaFormat: TAgentToolSchemaFormat;
  preferredSmallModelId?: string;
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

const PROVIDER_DEFAULTS: Readonly<Record<string, IProviderCapabilityDefaults>> = {
  openai: {
    supportsTools: true,
    supportsStreamingTools: true,
    supportsParallelToolCalls: true,
    supportsImages: true,
    supportsThinking: true,
    supportsNetworkTools: false,
    supportsPromptCacheKey: true,
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    toolSchemaFormat: 'openai-compatible',
    preferredSmallModelId: 'openai/gpt-5.4-mini',
  },
  anthropic: {
    supportsTools: true,
    supportsStreamingTools: true,
    supportsParallelToolCalls: false,
    supportsImages: true,
    supportsThinking: true,
    supportsNetworkTools: false,
    supportsPromptCacheKey: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    toolSchemaFormat: 'anthropic-compatible',
    preferredSmallModelId: 'anthropic/claude-haiku-4-5',
  },
  deepseek: {
    supportsTools: true,
    supportsStreamingTools: true,
    supportsParallelToolCalls: true,
    supportsImages: false,
    supportsThinking: true,
    supportsNetworkTools: false,
    supportsPromptCacheKey: false,
    contextWindowTokens: 128_000,
    maxOutputTokens: 64_000,
    toolSchemaFormat: 'openai-compatible',
    preferredSmallModelId: 'deepseek/deepseek-v4-flash',
  },
  google: {
    supportsTools: true,
    supportsStreamingTools: false,
    supportsParallelToolCalls: true,
    supportsImages: true,
    supportsThinking: true,
    supportsNetworkTools: false,
    supportsPromptCacheKey: false,
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    toolSchemaFormat: 'google-compatible',
    preferredSmallModelId: 'google/gemini-3.1-flash-lite',
  },
  openrouter: {
    supportsTools: true,
    supportsStreamingTools: true,
    supportsParallelToolCalls: true,
    supportsImages: true,
    supportsThinking: false,
    supportsNetworkTools: false,
    supportsPromptCacheKey: false,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    toolSchemaFormat: 'openai-compatible',
  },
  alibaba: {
    supportsTools: true,
    supportsStreamingTools: true,
    supportsParallelToolCalls: true,
    supportsImages: false,
    supportsThinking: true,
    supportsNetworkTools: false,
    supportsPromptCacheKey: false,
    contextWindowTokens: 128_000,
    maxOutputTokens: 32_768,
    toolSchemaFormat: 'openai-compatible',
    preferredSmallModelId: 'alibaba/qwen3.6-flash',
  },
  zhipuai: {
    supportsTools: true,
    supportsStreamingTools: true,
    supportsParallelToolCalls: true,
    supportsImages: true,
    supportsThinking: false,
    supportsNetworkTools: false,
    supportsPromptCacheKey: false,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    toolSchemaFormat: 'openai-compatible',
    preferredSmallModelId: 'zhipuai/glm-4.7-flash',
  },
  moonshotai: {
    supportsTools: true,
    supportsStreamingTools: true,
    supportsParallelToolCalls: true,
    supportsImages: false,
    supportsThinking: false,
    supportsNetworkTools: false,
    supportsPromptCacheKey: false,
    contextWindowTokens: 256_000,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    toolSchemaFormat: 'openai-compatible',
    preferredSmallModelId: 'moonshotai/kimi-k2-turbo-preview',
  },
};

const normalizeToken = (value: string): string => value.trim().toLowerCase();

const isOpenAiReasoningModel = (modelId: string): boolean => {
  const id = normalizeToken(modelId);
  return id.startsWith('o') || id.startsWith('gpt-5');
};

const isAnthropicThinkingModel = (modelId: string): boolean => {
  const id = normalizeToken(modelId);
  return id.includes('claude-4') || id.includes('opus-4') || id.includes('sonnet-4');
};

const isGoogleThinkingModel = (modelId: string): boolean => {
  const id = normalizeToken(modelId);
  return id.startsWith('gemini-2.5-') || id.startsWith('gemini-3');
};

const resolveProviderDefaults = (providerId: string): IProviderCapabilityDefaults =>
  PROVIDER_DEFAULTS[normalizeToken(providerId)] ?? {
    supportsTools: true,
    supportsStreamingTools: false,
    supportsParallelToolCalls: false,
    supportsImages: false,
    supportsThinking: false,
    supportsNetworkTools: false,
    supportsPromptCacheKey: false,
    contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    toolSchemaFormat: 'json-schema',
  };

const resolveThinkingSupport = (
  providerId: string,
  providerModelId: string,
  defaults: IProviderCapabilityDefaults,
): boolean => {
  const provider = normalizeToken(providerId);
  if (provider === 'openai') {
    return isOpenAiReasoningModel(providerModelId);
  }
  if (provider === 'anthropic') {
    return isAnthropicThinkingModel(providerModelId);
  }
  if (provider === 'google') {
    return isGoogleThinkingModel(providerModelId);
  }
  return defaults.supportsThinking;
};

const resolveDefaultThinkingEffort = (
  providerId: string,
  providerModelId: string,
): string | undefined => {
  const provider = normalizeToken(providerId);
  const model = normalizeToken(providerModelId);
  if (provider === 'google' && model.startsWith('gemini-3') && model.includes('pro')) {
    return 'high';
  }
  if (provider === 'google' && model.startsWith('gemini-3')) {
    return 'minimal';
  }
  if (provider === 'anthropic' && isAnthropicThinkingModel(model)) {
    return 'medium';
  }
  return undefined;
};

export const resolveAgentModelCapabilities = (
  input: IResolveAgentModelCapabilitiesInput,
): IAgentModelCapabilities => {
  const providerId = normalizeToken(input.providerId);
  const providerModelId = input.providerModelId.trim();
  if (!providerId) {
    throw new Error('[model-capabilities] providerId 不能为空。');
  }
  if (!providerModelId) {
    throw new Error('[model-capabilities] providerModelId 不能为空。');
  }

  const defaults = resolveProviderDefaults(providerId);
  const modelId = input.modelId?.trim() || `${providerId}/${providerModelId}`;
  const supportsThinking = resolveThinkingSupport(providerId, providerModelId, defaults);
  const defaultThinkingEffort = supportsThinking
    ? resolveDefaultThinkingEffort(providerId, providerModelId)
    : undefined;

  return {
    providerId,
    providerModelId,
    modelId,
    supportsTools: defaults.supportsTools,
    supportsStreamingTools: defaults.supportsStreamingTools,
    supportsParallelToolCalls: defaults.supportsParallelToolCalls,
    supportsImages: defaults.supportsImages,
    supportsThinking,
    supportsNetworkTools: defaults.supportsNetworkTools,
    supportsPromptCacheKey: defaults.supportsPromptCacheKey,
    contextWindowTokens: defaults.contextWindowTokens,
    maxOutputTokens: defaults.maxOutputTokens,
    toolSchemaFormat: defaults.toolSchemaFormat,
    ...(defaultThinkingEffort ? { defaultThinkingEffort } : {}),
    ...(defaults.preferredSmallModelId ? { preferredSmallModelId: defaults.preferredSmallModelId } : {}),
  };
};

export const resolveAgentModelCapabilitiesFromModelId = (
  modelId: string,
): IAgentModelCapabilities => {
  const normalized = modelId.trim();
  const separatorIndex = normalized.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === normalized.length - 1) {
    throw new Error('[model-capabilities] 模型标识必须使用 provider/model 形式。');
  }

  return resolveAgentModelCapabilities({
    providerId: normalized.slice(0, separatorIndex),
    providerModelId: normalized.slice(separatorIndex + 1),
    modelId: normalized,
  });
};

export const selectPreferredBackgroundModelId = (
  capabilities: IAgentModelCapabilities,
): string => capabilities.preferredSmallModelId ?? capabilities.modelId;
