import type { TAiProviderType } from '@/types/ai';

/* ============================================================================
 * Global defaults (供 ai-config.ts / store / UI 等下游 import)
 * ========================================================================== */

/** Mastra 路由的 provider type。当前系统仅 Mastra 一种 provider —— 后续接入 LiteLLM 直连时扩展。 */
export const DEFAULT_PROVIDER_TYPE: TAiProviderType = 'mastra';

/** Mastra 默认主模型 id。 */
export const DEFAULT_MASTRA_MODEL_ID = 'openai/gpt-5.5';

/**
 * Mastra 默认 baseUrl。空字符串 `''` 是"未配置"的哨兵值,下游用 `||` 链式
 * fallback 到 `null` 后再 prompt 用户配置 —— **不要改成 `??`,会破坏这个语义**。
 */
export const DEFAULT_MASTRA_BASE_URL = '';

/** Narrator(解说员)endpoint 的默认 model,用更便宜的小模型。 */
export const DEFAULT_NARRATOR_MODEL_ID = 'zhipuai/glm-4.7-flash';

/**
 * LiteLLM 直连模式预留 model id。当前 `findAiProviderPreset` 固定返回
 * Mastra preset,LiteLLM 通路尚未接入。等需要时扩展 findAiProviderPreset。
 */
export const DEFAULT_LITELLM_MODEL_ID = 'litellm-default-model';

/* ============================================================================
 * Service platform catalog
 * ========================================================================== */

export type TAiServicePlatformId =
  | 'openai'
  | 'anthropic'
  | 'deepseek'
  | 'google'
  | 'moonshotai'
  | 'alibaba'
  | 'zhipuai'
  | 'ollama';

export interface IAiServicePlatformModel {
  id: string;
  label: string;
}

export interface IAiServicePlatformPreset {
  id: TAiServicePlatformId;
  label: string;
  baseUrl: string;
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

/** 默认 service platform。当 model 无法匹配任何 platform 时回退到这里。 */
export const DEFAULT_AI_SERVICE_PLATFORM_ID: TAiServicePlatformId = 'openai';

export const AI_SERVICE_PLATFORM_PRESETS = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: '',
    defaultModel: 'openai/gpt-5.5',
    models: [
      { id: 'openai/gpt-5.5', label: 'GPT5.5' },
      { id: 'openai/gpt-5.4', label: 'GPT5.4' },
      { id: 'openai/gpt-5.4-pro', label: 'GPT5.4 Pro' },
      { id: 'openai/gpt-5.4-mini', label: 'GPT5.4 Mini' },
      { id: 'openai/gpt-5.4-nano', label: 'GPT5.4 Nano' },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: '',
    defaultModel: 'anthropic/claude-opus-4-6',
    models: [
      { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7' },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
      { id: 'anthropic/claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
      { id: 'anthropic/claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
      { id: 'anthropic/claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: '',
    defaultModel: 'deepseek/deepseek-v4-pro',
    models: [
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek-v4-pro' },
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek-v4-flash' },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: '',
    defaultModel: 'google/gemini-3.1-pro-preview',
    models: [
      { id: 'google/gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview' },
      { id: 'google/gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
      { id: 'google/gemini-3.1-flash-lite-preview', label: 'gemini-3.1-flash-lite-preview' },
      { id: 'google/gemini-2.5-pro', label: 'gemini-2.5-pro' },
      { id: 'google/gemini-2.5-flash', label: 'gemini-2.5-flash' },
    ],
  },
  {
    id: 'moonshotai',
    label: 'Moonshot Kimi',
    baseUrl: '',
    defaultModel: 'moonshotai/kimi-k2.6',
    models: [
      { id: 'moonshotai/kimi-k2.6', label: 'Kimi-k2.6' },
      { id: 'moonshotai/kimi-k2.5', label: 'Kimi-k2.5' },
      { id: 'moonshotai/kimi-k2', label: 'Kimi-k2' },
      { id: 'moonshotai/kimi-k2-thinking', label: 'Kimi-k2-thinking' },
      { id: 'moonshotai/kimi-k2-thinking-turbo', label: 'Kimi-k2-thinking-turbo' },
      { id: 'moonshotai/kimi-k2-turbo-preview', label: 'Kimi-k2-turbo-preview' },
    ],
  },
  {
    id: 'alibaba',
    label: '阿里云百炼',
    baseUrl: '',
    defaultModel: 'alibaba/qwen3.6-plus',
    models: [
      { id: 'alibaba/qwen3.6-plus', label: 'Qwen3.6-plus' },
      { id: 'alibaba/qwen3.6-max-preview', label: 'Qwen3.6-max-preview' },
      { id: 'alibaba/qwen3.6-flash', label: 'Qwen3.6-flash' },
    ],
  },
  {
    id: 'zhipuai',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'zhipuai/glm-4.7-flash',
    models: [
      { id: 'zhipuai/glm-4-flash', label: 'GLM-4-Flash' },
      { id: 'zhipuai/glm-4.7-flash', label: 'GLM-4.7-Flash' },
      { id: 'zhipuai/glm-4.5-flash', label: 'GLM-4.5-Flash' },
      { id: 'zhipuai/glm-4-plus', label: 'GLM-4-Plus' },
      { id: 'zhipuai/glm-4-air', label: 'GLM-4-Air' },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: '',
    defaultModel: 'ollama/qwen3-coder-next',
    models: [
      { id: 'ollama/qwen3-coder-next', label: 'Qwen3-coder-next' },
      { id: 'ollama/qwen3-coder', label: 'Qwen3-coder' },
      { id: 'ollama/qwen3', label: 'Qwen3' },
      { id: 'ollama/qwen3-vl', label: 'Qwen3-vl' },
    ],
  },
] as const satisfies readonly IAiServicePlatformPreset[];

/* ============================================================================
 * Provider preset (current: only Mastra)
 * ========================================================================== */

const MASTRA_PROVIDER_PRESET = {
  id: 'mastra',
  label: 'Mastra',
  description: 'Mastra 模型路由，统一通过 Mastra 官方模型能力调用与切换模型。',
  baseUrl: DEFAULT_MASTRA_BASE_URL,
  defaultModel: DEFAULT_MASTRA_MODEL_ID,
  models: AI_SERVICE_PLATFORM_PRESETS.flatMap((platform) =>
    platform.models.map((model) => model.id),
  ),
  apiKeyHint: 'sk-xxxxxxxxxxxx',
  iconUrl: null,
  isEndpointEditable: true,
  isAvailable: true,
} as const satisfies IAiProviderPreset;

/* ============================================================================
 * Preset lookup helpers
 *
 * 设计约束:所有 finder 函数都**保证返回非 null**(对未知输入回退到默认 preset)。
 * 调用方可以安全 `.baseUrl` `.defaultModel` 等访问,不需要 `?.` 守卫。
 * ========================================================================== */

const getDefaultAiServicePlatformPreset = (): IAiServicePlatformPreset => {
  const preset = AI_SERVICE_PLATFORM_PRESETS.find(
    (platform) => platform.id === DEFAULT_AI_SERVICE_PLATFORM_ID,
  );
  if (!preset) {
    return AI_SERVICE_PLATFORM_PRESETS[0];
  }
  return preset;
};

export const findAiProviderPreset = (_providerType: TAiProviderType): IAiProviderPreset =>
  MASTRA_PROVIDER_PRESET;

export const findAiServicePlatformPreset = (
  platformId: TAiServicePlatformId,
): IAiServicePlatformPreset =>
  AI_SERVICE_PLATFORM_PRESETS.find((platform) => platform.id === platformId) ??
  getDefaultAiServicePlatformPreset();

export const findAiServicePlatformByModel = (
  modelId: string | null | undefined,
): IAiServicePlatformPreset => {
  const normalizedModelId = modelId?.trim() ?? '';
  if (!normalizedModelId) {
    return getDefaultAiServicePlatformPreset();
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
  return matchedByPrefix ?? getDefaultAiServicePlatformPreset();
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
