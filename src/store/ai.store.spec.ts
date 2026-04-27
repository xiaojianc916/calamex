import { aiService } from '@/services/modules/ai';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAiStore } from './ai';

const tauriServiceMock = vi.hoisted(() => ({
  aiGetConfig: vi.fn(),
  aiSaveConfig: vi.fn(),
  aiClearCredentials: vi.fn(),
  aiTestProvider: vi.fn(),
  aiChat: vi.fn(),
  aiInlineComplete: vi.fn(),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: tauriServiceMock,
}));

describe('AI service and store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('service 通过统一 tauriService 调用 chat', async () => {
    const payload = {
      providerType: 'mock',
      model: 'mock-ide-assistant',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'ok',
        createdAt: '2026-04-27T00:00:00.000Z',
        references: [],
      },
    };
    tauriServiceMock.aiChat.mockResolvedValueOnce(payload);

    await expect(aiService.chat({ threadId: null, messages: [payload.message], references: [] }))
      .resolves.toBe(payload);
  });

  it('store 只保存非敏感配置', async () => {
    tauriServiceMock.aiGetConfig.mockResolvedValueOnce({
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

    const store = useAiStore();
    await store.loadConfig();

    expect(store.config.providerType).toBe('mock');
    expect('apiKey' in store.config).toBe(false);
  });
});
