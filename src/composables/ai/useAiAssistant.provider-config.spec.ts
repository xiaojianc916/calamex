import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiService } from '@/services/ipc/ai.service';
import { useAiProviderConfig } from './useAiAssistant.provider-config';

// 仅 mock 运行期依赖；类型 import 在编译期被擦除，无需 mock。
vi.mock('@/services/ipc/ai.service', () => ({
  aiService: {
    connectProvider: vi.fn(),
  },
}));

vi.mock('@/services/ipc/ai-config.service', () => ({
  createDefaultAiConfigPayload: () => ({
    providerType: 'mastra',
    selectedModel: 'deepseek/deepseek-v4-pro',
    baseUrl: null,
    isBaseUrlConfigured: false,
    hasCredentials: false,
    isConfigured: false,
    inlineCompletionEnabled: true,
    chatEnabled: true,
    agentEnabled: false,
    narrator: {
      providerType: 'mastra',
      selectedModel: 'zhipuai/glm-4.7-flash',
      baseUrl: null,
      isBaseUrlConfigured: false,
      hasCredentials: false,
      isConfigured: false,
    },
    credentials: [],
  }),
}));

vi.mock('@/constants/ai/providers', () => ({
  DEFAULT_LITELLM_MODEL_ID: 'deepseek/deepseek-v4-pro',
  findAiServicePlatformByModel: () => ({ id: 'deepseek' }),
}));

type TConnectResult = Awaited<ReturnType<typeof aiService.connectProvider>>;

const buildConfigInput = () => ({
  providerType: 'mastra',
  selectedModel: 'deepseek/deepseek-v4-pro',
  baseUrl: null,
  isBaseUrlConfigured: false,
  hasCredentials: false,
  isConfigured: false,
  inlineCompletionEnabled: true,
  chatEnabled: true,
  agentEnabled: false,
  narrator: {
    providerType: 'mastra',
    selectedModel: 'zhipuai/glm-4.7-flash',
    baseUrl: null,
    isBaseUrlConfigured: false,
    hasCredentials: false,
    isConfigured: false,
  },
  credentials: [],
});

const buildSavedConfig = () => ({
  ...buildConfigInput(),
  hasCredentials: true,
  isConfigured: true,
});

const setup = () => {
  const errorMessage = ref('');
  const { config, connectProvider } = useAiProviderConfig({
    workspaceRootPath: ref('/tmp/ws'),
    errorMessage,
  });
  return { errorMessage, config, connectProvider };
};

describe('useAiProviderConfig.connectProvider', () => {
  beforeEach(() => {
    vi.mocked(aiService.connectProvider).mockReset();
  });

  it('persists the saved config without running a connection test on save', async () => {
    vi.mocked(aiService.connectProvider).mockResolvedValue({
      config: buildSavedConfig(),
      test: {
        ok: true,
        code: 'AI_PROVIDER_READY',
        message: '凭证与配置已保存。点击「测试」可验证连接。',
      },
    } as TConnectResult);

    const { errorMessage, config, connectProvider } = setup();

    const message = await connectProvider(buildConfigInput(), 'sk-real-key');

    // 纯保存：凭证/配置必须已落盘（刷新/重启后 Key 仍在）。
    expect(config.value.hasCredentials).toBe(true);
    expect(config.value.isConfigured).toBe(true);
    // 保存不做在线验证，返回后端的保存确认文案，且不写入任何错误。
    expect(message).toBe('凭证与配置已保存。点击「测试」可验证连接。');
    expect(errorMessage.value).toBe('');
  });

  it('returns the backend save acknowledgement message verbatim', async () => {
    vi.mocked(aiService.connectProvider).mockResolvedValue({
      config: buildSavedConfig(),
      test: { ok: true, code: 'AI_PROVIDER_READY', message: 'DeepSeek 凭证已保存。' },
    } as TConnectResult);

    const { errorMessage, config, connectProvider } = setup();

    const message = await connectProvider(buildConfigInput(), 'sk-real-key');

    expect(config.value.hasCredentials).toBe(true);
    expect(message).toBe('DeepSeek 凭证已保存。');
    expect(errorMessage.value).toBe('');
  });
});
