import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultAiModelEndpointConfig } from '@/services/ipc/ai-config.service';
import { useAiStore } from './ai';

const tauriServiceMock = vi.hoisted(() => ({
  aiGetConfig: vi.fn(),
  aiSaveConfig: vi.fn(),
  aiSaveCredentials: vi.fn(),
  aiClearCredentials: vi.fn(),
  aiTestProvider: vi.fn(),
  aiTestProviderConfig: vi.fn(),
  aiConnectProvider: vi.fn(),
  aiChatStream: vi.fn(),
  aiCancel: vi.fn(),
  onAiChatStream: vi.fn(),
  aiInlineComplete: vi.fn(),
  aiCodeAction: vi.fn(),
  aiPlanTask: vi.fn(),
  aiProposePatch: vi.fn(),
  aiApplyPatch: vi.fn(),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));

describe('AI service and store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });
  it('store 只保存非敏感配置', async () => {
    tauriServiceMock.aiGetConfig.mockResolvedValueOnce({
      providerType: 'mastra',
      selectedModel: 'openai/gpt-5.5',
      baseUrl: 'http://127.0.0.1:4000/v1',
      isBaseUrlConfigured: true,
      hasCredentials: false,
      isConfigured: true,
      inlineCompletionEnabled: false,
      chatEnabled: true,
      agentEnabled: false,
      narrator: createDefaultAiModelEndpointConfig('zhipuai/glm-4.7-flash'),
      credentials: [],
    });

    const store = useAiStore();
    await store.loadConfig();

    expect(store.config.providerType).toBe('mastra');
    expect('apiKey' in store.config).toBe(false);
  });

  it('connectProvider 成功后只落非敏感 config，不把 apiKey 放进 store', async () => {
    tauriServiceMock.aiConnectProvider.mockResolvedValueOnce({
      config: {
        providerType: 'mastra',
        selectedModel: 'openai/gpt-5.5',
        baseUrl: 'http://127.0.0.1:4000/v1',
        isBaseUrlConfigured: true,
        hasCredentials: true,
        isConfigured: true,
        inlineCompletionEnabled: true,
        chatEnabled: true,
        agentEnabled: false,
        narrator: createDefaultAiModelEndpointConfig('zhipuai/glm-4.7-flash'),
        credentials: [{ providerId: 'openai', hasCredentials: true }],
      },
      test: {
        ok: true,
        code: 'AI_PROVIDER_READY',
        message: 'AI Provider 可用。',
      },
    });

    const store = useAiStore();
    await store.connectProvider({
      providerId: 'openai',
      providerType: 'mastra',
      selectedModel: 'openai/gpt-5.5',
      baseUrl: 'http://127.0.0.1:4000/v1',
      inlineCompletionEnabled: true,
      chatEnabled: true,
      agentEnabled: false,
      apiKey: 'sk-test-secret-value',
    });

    expect(store.config.providerType).toBe('mastra');
    expect(store.config.hasCredentials).toBe(true);
    expect('apiKey' in store.config).toBe(false);
  });
});
