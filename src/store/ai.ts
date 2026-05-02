import { aiService } from '@/services/modules/ai';
import { DEFAULT_LITELLM_BASE_URL, DEFAULT_LITELLM_MODEL_ID } from '@/constants/ai-providers';
import type {
  IAiConfigPayload,
  IAiProviderConnectionPayload,
  IAiProviderConnectionRequest,
  IAiProviderTestPayload,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  TAiProviderType,
  TAiStatus,
} from '@/types/ai';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER_TYPE: TAiProviderType = 'litellm';

const createDefaultConfig = (): IAiConfigPayload => ({
  providerType: DEFAULT_PROVIDER_TYPE,
  selectedModel: DEFAULT_LITELLM_MODEL_ID,
  baseUrl: DEFAULT_LITELLM_BASE_URL,
  activeProfileId: null,
  isBaseUrlConfigured: true,
  hasCredentials: false,
  isConfigured: false,
  inlineCompletionEnabled: false,
  chatEnabled: true,
  agentEnabled: false,
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAiStore = defineStore('ai', () => {
  const config = ref<IAiConfigPayload>(createDefaultConfig());
  const status = ref<TAiStatus>('idle');
  const errorMessage = ref<string | null>(null);

  const providerType = computed<TAiProviderType>(() => config.value.providerType);
  const selectedModel = computed(() => config.value.selectedModel);
  const isConfigured = computed(() => config.value.isConfigured);

  /**
   * 把任意返回 IAiConfigPayload 的远端调用结果落盘到 config,并把同一份回传给调用方。
   * 远端 reject 时不写入,异常按原样向上抛(由调用方决定是否走 setStatus('error', ...))。
   */
  const applyConfigUpdate = async (
    request: Promise<IAiConfigPayload>,
  ): Promise<IAiConfigPayload> => {
    config.value = await request;
    return config.value;
  };

  const loadConfig = (): Promise<IAiConfigPayload> =>
    applyConfigUpdate(aiService.getConfig());

  const saveConfig = (payload: IAiSaveConfigRequest): Promise<IAiConfigPayload> =>
    applyConfigUpdate(aiService.saveConfig(payload));

  const saveCredentials = (
    payload: IAiSaveCredentialsRequest,
  ): Promise<IAiConfigPayload> => applyConfigUpdate(aiService.saveCredentials(payload));

  const testProvider = (): Promise<IAiProviderTestPayload> => aiService.testProvider();

  const testProviderConfig = (
    payload: IAiProviderConnectionRequest,
  ): Promise<IAiProviderTestPayload> => aiService.testProviderConfig(payload);

  const connectProvider = async (
    payload: IAiProviderConnectionRequest,
  ): Promise<IAiProviderConnectionPayload> => {
    const result = await aiService.connectProvider(payload);
    config.value = result.config;
    return result;
  };

  const setStatus = (nextStatus: TAiStatus, message: string | null = null): void => {
    status.value = nextStatus;
    errorMessage.value = message;
  };

  return {
    config,
    status,
    errorMessage,
    providerType,
    selectedModel,
    isConfigured,
    loadConfig,
    saveConfig,
    saveCredentials,
    testProvider,
    testProviderConfig,
    connectProvider,
    setStatus,
  };
});
