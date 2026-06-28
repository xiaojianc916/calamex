import { computed, type Ref, ref } from 'vue';
import {
  DEFAULT_LITELLM_MODEL_ID,
  DEFAULT_PROVIDER_TYPE,
  findAiProviderPreset,
  findAiServicePlatformByModel,
} from '@/constants/ai/providers';
import { aiService } from '@/services/ipc/ai.service';
import { createDefaultAiConfigPayload } from '@/services/ipc/ai-config.service';
import type { IAiConfigPayload, IAiProviderConnectionRequest, TAiModelRole } from '@/types/ai';

export interface IUseAiProviderConfigDeps {
  workspaceRootPath: Ref<string | null>;
  errorMessage: Ref<string>;
}

/**
 * 「全量可切换模型清单」本会话是否已下发过的幂等守卫（模块级，跨实例共享）。
 *
 * 清单（MASTRA_PROVIDER_PRESET.models）是静态常量，整个运行期只需下发一次。由于后端
 * set_seeded_models 会重启「正在运行的」Kimi 以刷新候选池，loadConfig 可能被多次调用，
 * 若每次都下发会平白触发重启。故用此守卫保证每会话仅下发一次（启动时 Kimi 通常尚未
 * 拉起，重启为空操作）。下发失败会重置为 false 以便下次重试。
 */
let hasSeededSwitchableModelsThisSession = false;

export const useAiProviderConfig = ({ errorMessage }: IUseAiProviderConfigDeps) => {
  const config = ref<IAiConfigPayload>(createDefaultAiConfigPayload());

  const providerLabel = computed(() =>
    config.value.chatEnabled
      ? `${config.value.providerType} · ${config.value.selectedModel ?? DEFAULT_LITELLM_MODEL_ID}`
      : '未启用 Chat',
  );

  /**
   * 把内置的「全量可切换模型清单」（findAiProviderPreset(mastra).models）持久化进后端
   * ai.json 的 seeded_models。后端在 Kimi 启动时据此把整张清单 seed 进 config.toml，使 Kimi
   * 原生 session/set_config_option 的候选池覆盖整张清单 → 切换模型零重启（仅清单本身
   * 变更才需重启）。
   *
   * 幂等：清单为静态常量，每会话仅下发一次（hasSeededSwitchableModelsThisSession 守卫），
   * 避免重复触发后端对运行中 Kimi 的重启。fire-and-forget：失败仅告警吃掉，绝不阻断
   * 配置加载 / 面板渲染（回退到「仅 main+narrator 可切换」的既有行为）。
   */
  const seedSwitchableModels = async (): Promise<void> => {
    if (hasSeededSwitchableModelsThisSession) {
      return;
    }
    hasSeededSwitchableModelsThisSession = true;
    try {
      await aiService.setSeededModels({
        models: [...findAiProviderPreset(DEFAULT_PROVIDER_TYPE).models],
      });
    } catch (error) {
      // 下发失败不影响本次配置加载；重置守卫以便下次启动重试。
      hasSeededSwitchableModelsThisSession = false;
      console.warn('[ai] 下发可切换模型清单失败（不影响当前配置）：', error);
    }
  };

  const loadConfig = async (): Promise<void> => {
    // aiService.getConfig() 是 Tauri 生成的 IPC 绑定，类型标注为 AiConfigPayload，但后端在
    // 配置文件尚未创建/反序列化为空时可能回传 null/undefined。直接赋值会让
    // config.value 变为 nullish，导致面板里所有读取 config.value.selectedModel 的 computed
    // 崩溃（Vue render failed）。这里用默认配置兜底，保证 config 永远是合法 payload，
    // 正常返回值时行为不变。
    config.value =
      ((await aiService.getConfig()) as IAiConfigPayload) ?? createDefaultAiConfigPayload();

    // 配置就绪后下发「全量可切换模型清单」（详见 seedSwitchableModels）。
    // fire-and-forget：不 await、不阻断配置加载；seedSwitchableModels 内部自吞错误。
    void seedSwitchableModels();
  };

  const saveConfig = async (
    nextConfig: IAiConfigPayload,
    role: TAiModelRole = 'main',
  ): Promise<void> => {
    config.value = (await aiService.saveConfig({
      role,
      providerType:
        role === 'narrator' ? nextConfig.narrator.providerType : nextConfig.providerType,
      selectedModel:
        role === 'narrator' ? nextConfig.narrator.selectedModel : nextConfig.selectedModel,
      baseUrl: role === 'narrator' ? nextConfig.narrator.baseUrl : nextConfig.baseUrl,
      inlineCompletionEnabled: nextConfig.inlineCompletionEnabled,
      chatEnabled: nextConfig.chatEnabled,
      agentEnabled: nextConfig.agentEnabled,
    })) as IAiConfigPayload;
  };

  const saveCredentials = async (
    apiKey: string,
    providerId: string,
    alias?: string,
  ): Promise<void> => {
    config.value = (await aiService.saveCredentials({
      providerId,
      alias,
      apiKey,
    })) as IAiConfigPayload;
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

    // connect_provider 现在是「纯保存」：后端只把配置/凭证落盘（keyring + ai.json），
    // 不在保存时做在线连通性验证。因此保存 Key 不会因为一次网络往返的超时/失败被打断，
    // 也不会误报「连接测试未通过」。连接测试改由用户显式点击「测试」按钮触发
    // （testProviderConfig / testProvider）。
    config.value = result.config as IAiConfigPayload;

    // 返回后端给出的保存确认文案（纯保存模式下 test 恒为 ok，仅作为「已保存」反馈）。
    return result.test.message;
  };

  const loadTavilyApiKey = async (): Promise<string> => aiService.loadTavilyApiKey();

  const saveTavilyApiKey = async (apiKey: string): Promise<string> => {
    await aiService.saveTavilyApiKey(apiKey);
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
