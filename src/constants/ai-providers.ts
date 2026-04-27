import type { TAiProviderType } from '@/types/ai';

export interface IAiProviderPreset {
  id: TAiProviderType;
  label: string;
  description: string;
  baseUrl: string | null;
  defaultModel: string;
  apiKeyHint: string;
  iconUrl: string | null;
  isEndpointEditable: boolean;
  isAvailable: boolean;
}

const LOBE_ICONS_BASE_URL = 'https://unpkg.com/@lobehub/icons-static-svg@latest/icons';

export const AI_PROVIDER_PRESETS: IAiProviderPreset[] = [
  {
    id: 'mock',
    label: 'MockProvider',
    description: '本地测试 Provider，不需要 API Key。',
    baseUrl: null,
    defaultModel: 'mock-ide-assistant',
    apiKeyHint: '无需配置',
    iconUrl: null,
    isEndpointEditable: false,
    isAvailable: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 官方 API，兼容 /v1/chat/completions。',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4.1-mini',
    apiKeyHint: 'sk-...',
    iconUrl: `${LOBE_ICONS_BASE_URL}/openai.svg`,
    isEndpointEditable: false,
    isAvailable: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek 官方 OpenAI-compatible API。',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-v4-pro',
    apiKeyHint: 'sk-...',
    iconUrl: `${LOBE_ICONS_BASE_URL}/deepseek-color.svg`,
    isEndpointEditable: false,
    isAvailable: true,
  },
  {
    id: 'moonshot',
    label: 'Moonshot Kimi',
    description: 'Moonshot AI OpenAI-compatible API。',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    apiKeyHint: 'sk-...',
    iconUrl: `${LOBE_ICONS_BASE_URL}/moonshot.svg`,
    isEndpointEditable: false,
    isAvailable: true,
  },
  {
    id: 'dashscope',
    label: '阿里云百炼 / DashScope',
    description: 'DashScope 兼容 OpenAI 模式。',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    apiKeyHint: 'sk-...',
    iconUrl: `${LOBE_ICONS_BASE_URL}/qwen-color.svg`,
    isEndpointEditable: false,
    isAvailable: true,
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    description: '智谱 OpenAI-compatible API。',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4-plus',
    apiKeyHint: '填写智谱 API Key',
    iconUrl: `${LOBE_ICONS_BASE_URL}/zhipu-color.svg`,
    isEndpointEditable: false,
    isAvailable: true,
  },
  {
    id: 'siliconflow',
    label: 'SiliconFlow',
    description: 'SiliconFlow OpenAI-compatible API。',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'Qwen/Qwen2.5-Coder-32B-Instruct',
    apiKeyHint: 'sk-...',
    iconUrl: `${LOBE_ICONS_BASE_URL}/siliconcloud-color.svg`,
    isEndpointEditable: false,
    isAvailable: true,
  },
  {
    id: 'openai-compatible',
    label: '自定义 OpenAI-Compatible',
    description: '企业网关、本地代理或其它兼容 /chat/completions 的服务。',
    baseUrl: 'https://api.example.com/v1',
    defaultModel: 'gpt-4.1-mini',
    apiKeyHint: '填写该网关的 API Key',
    iconUrl: null,
    isEndpointEditable: true,
    isAvailable: true,
  },
  {
    id: 'claude-compatible',
    label: 'Claude',
    description: '规划中：需单独 Provider adapter，不伪装为已接入。',
    baseUrl: null,
    defaultModel: 'claude-3-5-sonnet-latest',
    apiKeyHint: '暂不支持保存',
    iconUrl: `${LOBE_ICONS_BASE_URL}/claude-color.svg`,
    isEndpointEditable: false,
    isAvailable: false,
  },
  {
    id: 'local',
    label: 'Local model',
    description: '规划中：本地模型需要独立安全策略。',
    baseUrl: null,
    defaultModel: 'local-model',
    apiKeyHint: '暂不支持保存',
    iconUrl: null,
    isEndpointEditable: false,
    isAvailable: false,
  },
  {
    id: 'custom-gateway',
    label: 'Custom Gateway',
    description: '规划中：企业网关协议需单独配置 schema。',
    baseUrl: null,
    defaultModel: 'custom-model',
    apiKeyHint: '暂不支持保存',
    iconUrl: null,
    isEndpointEditable: false,
    isAvailable: false,
  },
];

export const findAiProviderPreset = (providerType: TAiProviderType): IAiProviderPreset =>
  AI_PROVIDER_PRESETS.find((preset) => preset.id === providerType) ?? AI_PROVIDER_PRESETS[0];

