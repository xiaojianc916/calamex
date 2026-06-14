import type { TAiProviderType } from '@/types/ai';
import { getModelContextWindow } from '@/lib/model-catalog';

/* ============================================================================
 * Global defaults (供 ai-config.ts / store / UI 等下游 import)
 * ========================================================================== */

/** Mastra 路由的 provider type。当前系统仅 Mastra 一种 provider —— 后续接入 LiteLLM 直连时扩展。 */
export const DEFAULT_PROVIDER_TYPE: TAiProviderType = 'mastra';

/** Mastra 默认主模型 id。 */
export const DEFAULT_MASTRA_MODEL_ID = 'deepseek/deepseek-v4-pro';

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
  /**
   * 模型上下文窗口(单位:token),用作用量进度条的分母。
   * - 数值为官方/权威来源核实的窗口大小;部分按"默认窗口"而非"可选上限"取值(见各模型注释)。
   * - 留空(undefined)表示窗口**真正未知**(如 ollama 本地模型,取决于运行时 num_ctx),
   *   此时 UI 应显示"未知"而不是猜一个错误数字。
   * - 注意:此字段现在是"种子兜底"值。运行时优先走 `@/lib/model-catalog`
   *   (models.dev),仅当目录未收录该模型(如刚发布)或离线时才回退到这里。
   */
  contextWindow?: number;
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
      // GPT-5.x 标准窗口 272K;1M 为需显式开启(model_context_window)的可选上限,
      // 超 272K 按 2x 计费。进度条按默认 272K 取值。
      { id: 'openai/gpt-5.5', label: 'GPT5.5', contextWindow: 272_000 },
      { id: 'openai/gpt-5.4', label: 'GPT5.4', contextWindow: 272_000 },
      { id: 'openai/gpt-5.4-pro', label: 'GPT5.4 Pro', contextWindow: 272_000 },
      { id: 'openai/gpt-5.4-mini', label: 'GPT5.4 Mini', contextWindow: 272_000 },
      { id: 'openai/gpt-5.4-nano', label: 'GPT5.4 Nano', contextWindow: 272_000 },
    ],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: '',
    defaultModel: 'anthropic/claude-opus-4-6',
    models: [
      // 4.6/4.7 代 Claude API 已 GA 1M;4.5 代及更早为 200K。
      { id: 'anthropic/claude-opus-4-7', label: 'Claude Opus 4.7', contextWindow: 1_000_000 },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 1_000_000 },
      { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6', contextWindow: 1_000_000 },
      {
        id: 'anthropic/claude-opus-4-5-20251101',
        label: 'Claude Opus 4.5',
        contextWindow: 200_000,
      },
      {
        id: 'anthropic/claude-sonnet-4-5-20250929',
        label: 'Claude Sonnet 4.5',
        contextWindow: 200_000,
      },
      {
        id: 'anthropic/claude-haiku-4-5-20251001',
        label: 'Claude Haiku 4.5',
        contextWindow: 200_000,
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: '',
    defaultModel: 'deepseek/deepseek-v4-pro',
    models: [
      // DeepSeek V4 官方默认 1M 上下文(api-docs.deepseek.com)。
      { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek-v4-pro', contextWindow: 1_000_000 },
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek-v4-flash', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    baseUrl: '',
    defaultModel: 'google/gemini-3.1-pro-preview',
    models: [
      // Gemini 系列 1M 上下文(1,048,576)。
      {
        id: 'google/gemini-3.1-pro-preview',
        label: 'gemini-3.1-pro-preview',
        contextWindow: 1_048_576,
      },
      {
        id: 'google/gemini-3-flash-preview',
        label: 'gemini-3-flash-preview',
        contextWindow: 1_048_576,
      },
      {
        id: 'google/gemini-3.1-flash-lite-preview',
        label: 'gemini-3.1-flash-lite-preview',
        contextWindow: 1_048_576,
      },
      { id: 'google/gemini-2.5-pro', label: 'gemini-2.5-pro', contextWindow: 1_048_576 },
      { id: 'google/gemini-2.5-flash', label: 'gemini-2.5-flash', contextWindow: 1_048_576 },
    ],
  },
  {
    id: 'moonshotai',
    label: 'Moonshot Kimi',
    baseUrl: '',
    defaultModel: 'moonshotai/kimi-k2.6',
    models: [
      // Kimi K2 全系 256K(262,144)。
      { id: 'moonshotai/kimi-k2.6', label: 'Kimi-k2.6', contextWindow: 262_144 },
      { id: 'moonshotai/kimi-k2.5', label: 'Kimi-k2.5', contextWindow: 262_144 },
      { id: 'moonshotai/kimi-k2', label: 'Kimi-k2', contextWindow: 262_144 },
      { id: 'moonshotai/kimi-k2-thinking', label: 'Kimi-k2-thinking', contextWindow: 262_144 },
      {
        id: 'moonshotai/kimi-k2-thinking-turbo',
        label: 'Kimi-k2-thinking-turbo',
        contextWindow: 262_144,
      },
      {
        id: 'moonshotai/kimi-k2-turbo-preview',
        label: 'Kimi-k2-turbo-preview',
        contextWindow: 262_144,
      },
    ],
  },
  {
    id: 'alibaba',
    label: '阿里云百炼',
    baseUrl: '',
    defaultModel: 'alibaba/qwen3.6-plus',
    models: [
      // 阿里云百炼托管 Qwen3.6 默认 1M 上下文(开源权重默认 256K,此处为托管口径)。
      { id: 'alibaba/qwen3.6-plus', label: 'Qwen3.6-plus', contextWindow: 1_000_000 },
      { id: 'alibaba/qwen3.6-max-preview', label: 'Qwen3.6-max-preview', contextWindow: 1_000_000 },
      { id: 'alibaba/qwen3.6-flash', label: 'Qwen3.6-flash', contextWindow: 1_000_000 },
    ],
  },
  {
    id: 'zhipuai',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'zhipuai/glm-4.7-flash',
    models: [
      // GLM-4.7-Flash 约 200K(202,752);其余 GLM 系为 128K。
      { id: 'zhipuai/glm-4-flash', label: 'GLM-4-Flash', contextWindow: 128_000 },
      { id: 'zhipuai/glm-4.7-flash', label: 'GLM-4.7-Flash', contextWindow: 202_752 },
      { id: 'zhipuai/glm-4.5-flash', label: 'GLM-4.5-Flash', contextWindow: 128_000 },
      { id: 'zhipuai/glm-4-plus', label: 'GLM-4-Plus', contextWindow: 128_000 },
      { id: 'zhipuai/glm-4-air', label: 'GLM-4-Air', contextWindow: 128_000 },
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: '',
    defaultModel: 'ollama/qwen3-coder-next',
    models: [
      // 本地模型上下文取决于运行时 num_ctx,无法静态确定 → 留空,UI 显示"未知"。
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

/**
 * 解析某个 model id 的上下文窗口(token 数)。
 *
 * 优先级:
 * 1. ollama 本地模型 → 直接 undefined(窗口取决于运行时 num_ctx,不可静态确定,
 *    更不能让目录瞎猜一个云端口径的值)。
 * 2. models.dev 目录(`@/lib/model-catalog`)→ 维护良好、随模型发布自动更新。
 * 3. 手写种子兜底 → 目录未收录(如刚发布)或离线时使用。
 * 4. 都没有 → undefined。
 */
export const findModelContextWindow = (modelId: string | null | undefined): number | undefined => {
  const normalizedModelId = modelId?.trim() ?? '';
  if (!normalizedModelId) {
    return undefined;
  }

  // 本地模型:真实窗口取决于运行时 num_ctx,保持"未知"语义。
  if (normalizedModelId.startsWith('ollama/')) {
    return undefined;
  }

  // 优先用维护中的 models.dev 目录(随模型发布自动更新)。
  const fromCatalog = getModelContextWindow(normalizedModelId);
  if (typeof fromCatalog === 'number') {
    return fromCatalog;
  }

  // 回退:目录尚未收录(如刚发布的新模型)或离线时,用手写种子值。
  for (const platform of AI_SERVICE_PLATFORM_PRESETS) {
    const matched = platform.models.find((model) => model.id === normalizedModelId);
    if (matched) {
      return typeof matched.contextWindow === 'number' ? matched.contextWindow : undefined;
    }
  }
  return undefined;
};
