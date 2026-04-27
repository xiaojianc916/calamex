import { aiService } from '@/services/modules/ai';
import type {
  IAiConfigPayload,
  IAiProviderTestPayload,
  IAiSaveConfigRequest,
  IAiSaveCredentialsRequest,
  TAiProviderType,
  TAiStatus,
} from '@/types/ai';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

const createDefaultConfig = (): IAiConfigPayload => ({
  providerType: 'mock',
  selectedModel: 'mock-ide-assistant',
  baseUrl: null,
  isBaseUrlConfigured: false,
  hasCredentials: false,
  isConfigured: true,
  inlineCompletionEnabled: false,
  chatEnabled: true,
  agentEnabled: false,
});

export const useAiStore = defineStore('ai', () => {
  const config = ref<IAiConfigPayload>(createDefaultConfig());
  const status = ref<TAiStatus>('idle');
  const errorMessage = ref<string | null>(null);

  const providerType = computed<TAiProviderType>(() => config.value.providerType);
  const selectedModel = computed(() => config.value.selectedModel);
  const isConfigured = computed(() => config.value.isConfigured);

  const loadConfig = async (): Promise<IAiConfigPayload> => {
    config.value = await aiService.getConfig();
    return config.value;
  };

  const saveConfig = async (payload: IAiSaveConfigRequest): Promise<IAiConfigPayload> => {
    config.value = await aiService.saveConfig(payload);
    return config.value;
  };

  const saveCredentials = async (
    payload: IAiSaveCredentialsRequest,
  ): Promise<IAiConfigPayload> => {
    config.value = await aiService.saveCredentials(payload);
    return config.value;
  };

  const testProvider = async (): Promise<IAiProviderTestPayload> => aiService.testProvider();

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
    setStatus,
  };
});
