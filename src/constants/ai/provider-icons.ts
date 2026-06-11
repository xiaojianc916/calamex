import anthropicIconUrl from '@/assets/icons/ai-providers/anthropic.svg';
import deepseekIconUrl from '@/assets/icons/ai-providers/deepseek-color.svg';
import geminiIconUrl from '@/assets/icons/ai-providers/google-gemini.svg';
import moonshotIconUrl from '@/assets/icons/ai-providers/moonshot.svg';
import ollamaIconUrl from '@/assets/icons/ai-providers/ollama.svg';
import openaiIconUrl from '@/assets/icons/ai-providers/openai.svg';
import qwenIconUrl from '@/assets/icons/ai-providers/qwen-color.svg';
import zhipuIconUrl from '@/assets/icons/ai-providers/zhipu-color.svg';
import type { TAiServicePlatformId } from '@/constants/ai/providers';

export interface IAiProviderIconDefinition {
  label: string;
  iconUrl: string | null;
  background: string;
}

export const AI_PROVIDER_ICON_DEFINITIONS = {
  openai: {
    label: 'OpenAI',
    iconUrl: openaiIconUrl,
    background: 'transparent',
  },
  anthropic: {
    label: 'Anthropic',
    iconUrl: anthropicIconUrl,
    background: 'transparent',
  },
  deepseek: {
    label: 'DeepSeek',
    iconUrl: deepseekIconUrl,
    background: 'transparent',
  },
  google: {
    label: 'Google Gemini',
    iconUrl: geminiIconUrl,
    background: 'transparent',
  },
  moonshotai: {
    label: 'Kimi',
    iconUrl: moonshotIconUrl,
    background: 'transparent',
  },
  alibaba: {
    label: 'Qwen',
    iconUrl: qwenIconUrl,
    background: 'transparent',
  },
  zhipuai: {
    label: '智谱 GLM',
    iconUrl: zhipuIconUrl,
    background: 'transparent',
  },
  ollama: {
    label: 'Ollama',
    iconUrl: ollamaIconUrl,
    background: 'transparent',
  },
} as const satisfies Record<TAiServicePlatformId, IAiProviderIconDefinition>;

const FALLBACK_AI_PROVIDER_ICON_DEFINITION: IAiProviderIconDefinition = {
  label: '未知平台',
  iconUrl: null,
  background: 'var(--text-tertiary)',
};

const isAiProviderIconPlatformId = (platformId: string): platformId is TAiServicePlatformId =>
  Object.hasOwn(AI_PROVIDER_ICON_DEFINITIONS, platformId);

export const findAiProviderIconDefinition = (
  platformId: string | null | undefined,
): IAiProviderIconDefinition => {
  const normalizedPlatformId = platformId?.trim() ?? '';

  if (normalizedPlatformId && isAiProviderIconPlatformId(normalizedPlatformId)) {
    return AI_PROVIDER_ICON_DEFINITIONS[normalizedPlatformId];
  }

  return FALLBACK_AI_PROVIDER_ICON_DEFINITION;
};
