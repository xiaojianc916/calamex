import type { TAiProviderType } from '@/types/ai';

export type TAiServicePlatformId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'gemini'
  | 'moonshot'
  | 'dashscope'
  | 'zhipu'
  | 'ollama';

export interface IAiServicePlatformModel {
  id: string;
  label: string;
}

export interface IAiServicePlatformPreset {
  id: TAiServicePlatformId;
  label: string;
  defaultModel: string;
  models: readonly IAiServicePlatformModel[];
}

export interface IAiProviderPreset {
  id: TAiProviderType;
  label: string;
  description: string;
  baseUrl: string;
  defaultModel: string;
  models: readonly string[];
  apiKeyHint: string;
  iconUrl: string | null;
  isEndpointEditable: boolean;
  isAvailable: boolean;
}

const DEFAULT_AI_SERVICE_PLATFORM_ID: TAiServicePlatformId = 'openai';
export const DEFAULT_LITELLM_MODEL_ID = 'openai/gpt-5.5';
export const DEFAULT_LITELLM_BASE_URL = 'http://127.0.0.1:4000/v1';

export const AI_SERVICE_PLATFORM_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'openai/gpt-5.5',
    models: [
      {
        id: 'openai/gpt-5.5',
        label: 'GPT5.5',
      },
      {
        id: 'openai/gpt-5.4',
        label: 'GPT5.4',
      },
      {
        id: 'openai/gpt-5.4-pro',
        label: 'GPT5.4 Pro',
      },
      {
        id: 'openai/gpt-5.4-mini',
        label: 'GPT5.4 Mini',
      },
      {
        id: 'openai/gpt-5.4-nano',
        label: 'GPT5.4 Nano',
      },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'anthropic/claude-opus-4-6',
    models: [
      {
        id: 'anthropic/claude-opus-4-7',
        label: 'Claude Opus 4.7',
      },
      {
        id: 'anthropic/claude-sonnet-4-6',
        label: 'Claude Sonnet 4.6',
      },
      {
        id: 'anthropic/claude-opus-4-6',
        label: 'Claude Opus 4.6',
      },
      {
        id: 'anthropic/claude-opus-4-5-20251101',
        label: 'Claude Opus 4.5',
      },
      {
        id: 'anthropic/claude-sonnet-4-5-20250929',
        label: 'Claude Sonnet 4.5',
      },
      {
        id: 'anthropic/claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek/deepseek-v4-pro',
    models: [
      {
        id: 'deepseek/deepseek-v4-pro',
        label: 'DeepSeek-v4-pro',
      },
      {
        id: 'deepseek/deepseek-v4-flash',
        label: 'DeepSeek-v4-flash',
      },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini/gemini-3.1-pro-preview',
    models: [
      {
        id: 'gemini/gemini-3.1-pro-preview',
        label: 'gemini-3.1-pro-preview',
      },
      {
        id: 'gemini/gemini-3-flash-preview',
        label: 'gemini-3-flash-preview',
      },
      {
        id: 'gemini/gemini-3.1-flash-lite-preview',
        label: 'gemini-3.1-flash-lite-preview',
      },
      {
        id: 'gemini/gemini-2.5-pro',
        label: 'gemini-2.5-pro',
      },
      {
        id: 'gemini/gemini-2.5-flash',
        label: 'gemini-2.5-flash',
      },
    ],
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    defaultModel: 'moonshot/kimi-k2.6',
    models: [
      {
        id: 'moonshot/kimi-k2.6',
        label: 'Kimi-k2.6',
      },
      {
        id: 'moonshot/kimi-k2.5',
        label: 'Kimi-k2.5',
      },
      {
        id: 'moonshot/kimi-k2',
        label: 'Kimi-k2',
      },
      {
        id: 'moonshot/kimi-k2-thinking',
        label: 'Kimi-k2-thinking',
      },
      {
        id: 'moonshot/kimi-k2-thinking-turbo',
        label: 'Kimi-k2-thinking-turbo',
      },
      {
        id: 'moonshot/kimi-k2-turbo-preview',
        label: 'Kimi-k2-turbo-preview',
      },
    ],
  },
  {
    id: 'dashscope',
    label: '阿里云百炼',
    defaultModel: 'dashscope/qwen3.6-plus',
    models: [
      {
        id: 'dashscope/qwen3.6-plus',
        label: 'Qwen3.6-plus',
      },
      {
        id: 'dashscope/qwen3.6-plus-2026-04-02',
        label: 'Qwen3.6-plus',
      },
      {
        id: 'dashscope/qwen3.6-max-preview',
        label: 'Qwen3.6-max-preview',
      },
      {
        id: 'dashscope/qwen3.6-flash',
        label: 'Qwen3.6-flash',
      },
    ],
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    defaultModel: 'zhipu/glm-4-flash',
    models: [
      {
        id: 'zhipu/glm-4-flash',
        label: 'GLM-4-Flash',
      },
      {
        id: 'zhipu/glm-4-plus',
        label: 'GLM-4-Plus',
      },
      {
        id: 'zhipu/glm-4-air',
        label: 'GLM-4-Air',
      },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultModel: 'ollama/qwen3-coder-next',
    models: [
      {
        id: 'ollama/qwen3-coder-next',
        label: 'Qwen3-coder-next',
      },
      {
        id: 'ollama/qwen3-coder',
        label: 'Qwen3-coder',
      },
      {
        id: 'ollama/qwen3',
        label: 'Qwen3',
      },
      {
        id: 'ollama/qwen3-vl',
        label: 'Qwen3-vl',
      },
    ],
  },
] as const satisfies readonly IAiServicePlatformPreset[];

const LITELLM_PROVIDER_PRESET = {
  id: 'litellm',
  label: 'LiteLLM Proxy',
  description: 'LiteLLM Proxy / LLM Gateway，统一通过 OpenAI-compatible API 调用和切换模型。',
  baseUrl: DEFAULT_LITELLM_BASE_URL,
  defaultModel: DEFAULT_LITELLM_MODEL_ID,
  models: AI_SERVICE_PLATFORM_PRESETS.flatMap((platform) =>
    platform.models.map((model) => model.id),
  ),
  apiKeyHint: 'sk-xxxxxxxxxxxx',
  iconUrl: null,
  isEndpointEditable: true,
  isAvailable: true,
} as const satisfies IAiProviderPreset;


export const findAiProviderPreset = (
  providerType: TAiProviderType,
): IAiProviderPreset => {
  void providerType;
  return LITELLM_PROVIDER_PRESET;
};

export const findAiServicePlatformPreset = (
  platformId: TAiServicePlatformId,
): IAiServicePlatformPreset =>
  AI_SERVICE_PLATFORM_PRESETS.find((platform) => platform.id === platformId)
  ?? AI_SERVICE_PLATFORM_PRESETS[0];

export const findAiServicePlatformByModel = (
  modelId: string | null | undefined,
): IAiServicePlatformPreset => {
  const normalizedModelId = modelId?.trim() ?? '';
  if (!normalizedModelId) {
    return findAiServicePlatformPreset(DEFAULT_AI_SERVICE_PLATFORM_ID);
  }

  const matchedByExactModel = AI_SERVICE_PLATFORM_PRESETS.find((platform) =>
    platform.models.some((model) => model.id === normalizedModelId),
  );
  if (matchedByExactModel) {
    return matchedByExactModel;
  }

  const matchedByPrefix = AI_SERVICE_PLATFORM_PRESETS.find((platform) =>
    normalizedModelId.startsWith(`${platform.id}/`),
  );
  return matchedByPrefix ?? findAiServicePlatformPreset(DEFAULT_AI_SERVICE_PLATFORM_ID);
};

export const isAiServicePlatformModel = (
  platformId: TAiServicePlatformId,
  modelId: string | null | undefined,
): boolean => {
  const normalizedModelId = modelId?.trim() ?? '';
  if (!normalizedModelId) {
    return false;
  }

  return findAiServicePlatformPreset(platformId).models.some(
    (model) => model.id === normalizedModelId,
  );
};
