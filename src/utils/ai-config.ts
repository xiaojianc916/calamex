import {
  DEFAULT_MASTRA_BASE_URL,
  DEFAULT_MASTRA_MODEL_ID,
  DEFAULT_NARRATOR_MODEL_ID,
  DEFAULT_PROVIDER_TYPE,
  findAiServicePlatformByModel,
} from '@/constants/ai-providers';
import type {
  IAiConfigPayload,
  IAiModelEndpointConfigPayload,
  TAiModelRole,
} from '@/types/ai';

/**
 * 取出指定 model 的 base URL。
 *
 * 顺序:
 * 1. 该 model 所属 platform 的 baseUrl(如能匹配到 platform)
 * 2. 全局 Mastra 默认 baseUrl
 * 3. null(让上层显式处理"无可用端点"的情况)
 *
 * 用 `||` 而非 `??`:空字符串 `''` 是"未配置"的哨兵值,需要被当作 falsy
 * 链式 fallback,最终返回 null 让上层 prompt 用户配置。
 */
export const resolveDefaultAiBaseUrl = (selectedModel: string): string | null => {
  const platform = findAiServicePlatformByModel(selectedModel);
  return platform.baseUrl || DEFAULT_MASTRA_BASE_URL || null;
};

export const createDefaultAiModelEndpointConfig = (
  selectedModel: string = DEFAULT_MASTRA_MODEL_ID,
): IAiModelEndpointConfigPayload => ({
  providerType: DEFAULT_PROVIDER_TYPE,
  selectedModel,
  baseUrl: resolveDefaultAiBaseUrl(selectedModel),
  activeProfileId: null,
  isBaseUrlConfigured: true,
  hasCredentials: false,
  isConfigured: false,
});

export const createDefaultAiConfigPayload = (): IAiConfigPayload => ({
  providerType: DEFAULT_PROVIDER_TYPE,
  selectedModel: DEFAULT_MASTRA_MODEL_ID,
  baseUrl: resolveDefaultAiBaseUrl(DEFAULT_MASTRA_MODEL_ID),
  activeProfileId: null,
  isBaseUrlConfigured: true,
  hasCredentials: false,
  isConfigured: false,
  inlineCompletionEnabled: false,
  chatEnabled: true,
  agentEnabled: false,
  narrator: createDefaultAiModelEndpointConfig(DEFAULT_NARRATOR_MODEL_ID),
});

export const cloneAiConfigPayload = (
  config: IAiConfigPayload,
): IAiConfigPayload => ({
  ...config,
  narrator: { ...config.narrator },
});

/**
 * 把 IAiConfigPayload 的 "main" 端点字段(扁平存储)抽取成 endpoint payload 形状。
 * 单独抽出来,确保 `getAiModelEndpointConfig` 两条分支返回的对象身份一致(都是新对象)。
 */
const extractMainEndpointConfig = (
  config: IAiConfigPayload,
): IAiModelEndpointConfigPayload => ({
  providerType: config.providerType,
  selectedModel: config.selectedModel,
  baseUrl: config.baseUrl,
  activeProfileId: config.activeProfileId,
  isBaseUrlConfigured: config.isBaseUrlConfigured,
  hasCredentials: config.hasCredentials,
  isConfigured: config.isConfigured,
});

/**
 * 用 never 触发的穷尽性检查 —— TAiModelRole 加新成员时,
 * `assertExhaustiveRole(role)` 这一句会编译失败,提示来这里加分支。
 */
const assertExhaustiveRole = (role: never): never => {
  throw new Error(`Unhandled AI model role: ${String(role)}`);
};

/**
 * 读取指定 role 的 endpoint 配置。
 *
 * 注意:返回值始终是**新对象**(包括 narrator —— 不再回传 config.narrator
 * 的引用),避免外部 mutate 污染原 config。需要写回时用 `patchAiModelEndpointConfig`。
 */
export const getAiModelEndpointConfig = (
  config: IAiConfigPayload,
  role: TAiModelRole,
): IAiModelEndpointConfigPayload => {
  switch (role) {
    case 'narrator':
      return { ...config.narrator };
    case 'main':
      return extractMainEndpointConfig(config);
    default:
      return assertExhaustiveRole(role);
  }
};

/**
 * 把 patch 写入对应 role 的 endpoint 配置。
 *
 * 维持 in-place mutate 风格(Pinia store 内常见用法),但 narrator 路径
 * 改写 `config.narrator` 整体引用 —— 避免响应性追踪的边界 case。
 */
export const patchAiModelEndpointConfig = (
  config: IAiConfigPayload,
  role: TAiModelRole,
  patch: Partial<Pick<IAiModelEndpointConfigPayload,
    'providerType' | 'selectedModel' | 'baseUrl'>>,
): void => {
  switch (role) {
    case 'narrator':
      config.narrator = {
        ...config.narrator,
        ...patch,
      };
      return;
    case 'main':
      if (patch.providerType !== undefined) {
        config.providerType = patch.providerType;
      }
      if (patch.selectedModel !== undefined) {
        config.selectedModel = patch.selectedModel;
      }
      if (patch.baseUrl !== undefined) {
        config.baseUrl = patch.baseUrl;
      }
      return;
    default:
      assertExhaustiveRole(role);
  }
};
