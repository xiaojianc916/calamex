import { computed, type Ref, ref } from 'vue';
import { DEFAULT_LITELLM_MODEL_ID, findAiServicePlatformByModel } from '@/constants/ai/providers';
import { aiService } from '@/services/ipc/ai.service';
import { createDefaultAiConfigPayload } from '@/services/ipc/ai-config.service';
import type { IAiConfigPayload, IAiProviderConnectionRequest, TAiModelRole } from '@/types/ai';

export interface IUseAiProviderConfigDeps {
  workspaceRootPath: Ref<string | null>;
  errorMessage: Ref<string>;
}

export const useAiProviderConfig = ({
  workspaceRootPath,
  errorMessage,
}: IUseAiProviderConfigDeps) => {
  const config = ref<IAiConfigPayload>(createDefaultAiConfigPayload());

  const providerLabel = computed(() =>
    config.value.chatEnabled
      ? `${config.value.providerType} · ${config.value.selectedModel ?? DEFAULT_LITELLM_MODEL_ID}`
      : '未启用 Chat',
  );

  const loadConfig = async (): Promise<void> => {
    // aiService.getConfig() 是 Tauri 生成的 IPC 绑定，类型标注为 AiConfigPayload，但后端在
    // 配置文件尚未创建/反序列化为空时可能回传 null/undefined。直接赋值会让
    // config.value 变为 nullish，导致面板里所有读取 config.value.selectedModel 的 computed
    // 崩溃（Vue render failed）。这里用默认配置兜底，保证 config 永远是合法 payload，
    // 正常返回值时行为不变。
    config.value = (await aiService.getConfig()) ?? createDefaultAiConfigPayload();
  };

  const saveConfig = async (
    nextConfig: IAiConfigPayload,
    role: TAiModelRole = 'main',
  ): Promise<void> => {
    config.value = await aiService.saveConfig({
      role,
      providerType:
        role === 'narrator' ? nextConfig.narrator.providerType : nextConfig.providerType,
      selectedModel:
        role === 'narrator' ? nextConfig.narrator.selectedModel : nextConfig.selectedModel,
      baseUrl: role === 'narrator' ? nextConfig.narrator.baseUrl : nextConfig.baseUrl,
      inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,
      chatEnabled: nextConfig.chatEnabled,
      agentEnabled: nextConfig.agentEnabled,
    });
  };

  const saveCredentials = async (
    apiKey: string,
    providerId: string,
    alias?: string,
  ): Promise<void> => {
    config.value = await aiService.saveCredentials({
      providerId,
      alias,
      apiKey,
    });
  };

  const getProviderIdForRoleConfig = (nextConfig: IAiConfigPayload, role: TAiModelRole): string => {
    const selectedModel =
      role === 'narrator' ? nextConfig.narrator.selectedModel : nextConfig.selectedModel;

    return findAiServicePlatformByModel(selectedModel).id;
  };

  const createProviderConnectionRequest = (
    nextConfig: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole = 'main',
  ): IAiProviderConnectionRequest => ({
    role,
    providerId: getProviderIdForRoleConfig(nextConfig, role),
    providerType: role === 'narrator' ? nextConfig.narrator.providerType : nextConfig.providerType,
    selectedModel:
      role === 'narrator' ? nextConfig.narrator.selectedModel : nextConfig.selectedModel,
    baseUrl: role === 'narrator' ? nextConfig.narrator.baseUrl : nextConfig.baseUrl,
    inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,
    chatEnabled: nextConfig.chatEnabled,
    agentEnabled: nextConfig.agentEnabled,
    apiKey: apiKey.trim() || null,
  });

  const testProviderConfig = async (
    nextConfig: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole = 'main',
  ): Promise<string> => {
    const result = await aiService.testProviderConfig(
      createProviderConnectionRequest(nextConfig, apiKey, role),
    );

    if (!result.ok) {
      errorMessage.value = result.message;
      throw new Error(result.message);
    }

    return result.message;
  };

  const connectProvider = async (
    nextConfig: IAiConfigPayload,
    apiKey: string,
    role: TAiModelRole = 'main',
  ): Promise<string> => {
    const result = await aiService.connectProvider(
      createProviderConnectionRequest(nextConfig, apiKey, role),
    );

    // 关键不变量：后端是「先落盘、再做非致命验证」。只要 connectProvider 返回，
    // 凭证与配置就已写入 keyring + ai.json（刷新/重启后依然存在），因此无论连接测试
    // 是否通过都要把本地 config 刷新为已保存的快照。
    config.value = result.config;

    if (!result.test.ok) {
      // 已保存成功，但在线验证未通过：如实告知，而不是谎报成功，也不是抛错——
      // 抛错会被上层误读为「保存失败」，与实际状态相悖。
      errorMessage.value = result.test.message;
      return `已保存凭证，但连接测试未通过：${result.test.message}`;
    }

    return result.test.message;
  };

  const resolveWorkspaceRootPath = (): string => {
    const workspaceRootPathValue = workspaceRootPath.value?.trim();

    if (!workspaceRootPathValue) {
      throw new Error('当前工作区路径不可用。');
    }

    return workspaceRootPathValue;
  };

  const loadTavilyApiKey = async (): Promise<string> =>
    aiService.loadTavilyApiKey(resolveWorkspaceRootPath());

  const saveTavilyApiKey = async (apiKey: string): Promise<string> => {
    await aiService.saveTavilyApiKey(resolveWorkspaceRootPath(), apiKey);
    const health = await aiService.sidecarRestart();

    return apiKey.trim()
      ? `Tavily API Key 已保存，Agent sidecar 已重启（${health.status}）`
      : `Tavily API Key 已清除，Agent sidecar 已重启（${health.status}）`;
  };

  const testProvider = async (): Promise<string> => {
    const result = await aiService.testProvider();

    if (!result.ok) {
      errorMessage.value = result.message;
      throw new Error(result.message);
    }

    return result.message;
  };

  return {
    config,
    providerLabel,
    loadConfig,
    saveConfig,
    saveCredentials,
    loadTavilyApiKey,
    saveTavilyApiKey,
    testProviderConfig,
    connectProvider,
    testProvider,
  };
};
