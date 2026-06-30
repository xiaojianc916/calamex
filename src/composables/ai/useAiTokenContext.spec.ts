import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import { useAiTokenContext } from '@/composables/ai/useAiTokenContext';
import type { IAiLanguageModelUsage } from '@/types/ai';
import type { IAiThreadAssistantMessageEntry, IAiThreadEntry } from '@/types/ai/thread';

type TAssistantStream = IAiThreadAssistantMessageEntry['stream'];

const createAssistantEntry = (id: string, stream?: TAssistantStream): IAiThreadEntry => ({
  type: 'assistant_message',
  id,
  createdAt: '2026-05-09T10:00:00.000Z',
  chunks: [{ type: 'message', block: { type: 'text', text: '回复' } }],
  ...(stream !== undefined ? { stream } : {}),
});

const createContext = (options?: {
  mode?: 'chat' | 'agent' | 'plan';
  entries?: ReturnType<typeof ref<IAiThreadEntry[]>>;
  officialUsage?: ReturnType<typeof ref<IAiLanguageModelUsage | null | undefined>>;
}) => {
  const entries = options?.entries ?? ref<IAiThreadEntry[]>([]);
  const officialUsage = options?.officialUsage ?? ref<IAiLanguageModelUsage | null>(null);

  return useAiTokenContext({
    mode: computed(() => options?.mode ?? 'chat'),
    modelId: computed(() => 'deepseek/deepseek-v4-pro'),
    entries: computed(() => entries.value),
    officialUsage: computed(() => officialUsage.value),
  });
};

describe('useAiTokenContext', () => {
  it('resolves the deepseek context window (1M) from the model catalog', () => {
    const context = useAiTokenContext({
      mode: computed(() => 'chat'),
      modelId: computed(() => 'deepseek/deepseek-v4-flash'),
      entries: computed(() => []),
    });

    expect(context.contextProps.value.maxTokens).toBe(1_000_000);
  });

  it('resolves the context window from the model catalog for GLM models', () => {
    const context = useAiTokenContext({
      mode: computed(() => 'chat'),
      modelId: computed(() => 'zhipuai/glm-4-flash'),
      entries: computed(() => []),
    });

    expect(context.contextProps.value.maxTokens).toBe(128_000);
  });

  it('reports zero usage before the model returns official usage', () => {
    const context = createContext({ mode: 'chat' });

    expect(context.contextProps.value.usedTokens).toBe(0);
    expect(context.contextProps.value.usage.inputTokens).toBe(0);
    expect(context.contextProps.value.usage.outputTokens).toBe(0);
    expect(context.contextProps.value.usageSource).toBe('official');
  });

  it('reads official stream usage from assistant entries', () => {
    const entries = ref<IAiThreadEntry[]>([
      createAssistantEntry('assistant-1', {
        status: 'completed',
        inputTokens: 13,
        outputTokens: 5,
        totalTokens: 18,
        usage: {
          inputTokens: 13,
          inputTokenDetails: {
            noCacheTokens: 13,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 5,
          outputTokenDetails: {
            textTokens: 4,
            reasoningTokens: 1,
          },
          totalTokens: 18,
          cachedInputTokens: 0,
          reasoningTokens: 1,
        },
      }),
    ]);
    const context = createContext({ mode: 'chat', entries });

    expect(context.contextProps.value.usedTokens).toBe(13);
    expect(context.contextProps.value.usage.inputTokens).toBe(13);
    expect(context.contextProps.value.usage.outputTokens).toBe(5);
    expect(context.contextProps.value.usageSource).toBe('official');
  });

  it('accumulates official stream usage across assistant entries', () => {
    const entries = ref<IAiThreadEntry[]>([
      createAssistantEntry('assistant-1', {
        status: 'completed',
        usage: {
          inputTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 8,
            cacheReadTokens: 2,
            cacheWriteTokens: 0,
          },
          outputTokens: 5,
          outputTokenDetails: {
            textTokens: 4,
            reasoningTokens: 1,
          },
          totalTokens: 15,
          cachedInputTokens: 2,
          reasoningTokens: 1,
        },
      }),
      createAssistantEntry('assistant-2', {
        status: 'completed',
        usage: {
          inputTokens: 20,
          inputTokenDetails: {
            noCacheTokens: 15,
            cacheReadTokens: 5,
            cacheWriteTokens: 0,
          },
          outputTokens: 7,
          outputTokenDetails: {
            textTokens: 5,
            reasoningTokens: 2,
          },
          totalTokens: 27,
          cachedInputTokens: 5,
          reasoningTokens: 2,
        },
      }),
    ]);
    const context = createContext({ mode: 'chat', entries });

    expect(context.contextProps.value.usedTokens).toBe(30);
    expect(context.contextProps.value.usage).toMatchObject({
      inputTokens: 30,
      inputTokenDetails: {
        noCacheTokens: 23,
        cacheReadTokens: 7,
        cacheWriteTokens: 0,
      },
      outputTokens: 12,
      outputTokenDetails: {
        textTokens: 9,
        reasoningTokens: 3,
      },
      totalTokens: 42,
      cachedInputTokens: 7,
      reasoningTokens: 3,
    });
    expect(context.contextProps.value.usageSource).toBe('official');
  });

  it('prioritizes official sidecar usage over accumulated stream usage', () => {
    const entries = ref<IAiThreadEntry[]>([
      createAssistantEntry('assistant-1', {
        status: 'completed',
        usage: {
          inputTokens: 10,
          inputTokenDetails: {
            noCacheTokens: 10,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          outputTokens: 3,
          outputTokenDetails: {
            textTokens: 3,
            reasoningTokens: 0,
          },
          totalTokens: 13,
          cachedInputTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ]);
    const officialUsage = ref<IAiLanguageModelUsage>({
      inputTokens: 41,
      inputTokenDetails: {
        noCacheTokens: 37,
        cacheReadTokens: 4,
        cacheWriteTokens: 0,
      },
      outputTokens: 9,
      outputTokenDetails: {
        textTokens: 6,
        reasoningTokens: 3,
      },
      totalTokens: 50,
      cachedInputTokens: 4,
      reasoningTokens: 3,
    });
    const context = createContext({
      mode: 'chat',
      entries,
      officialUsage,
    });

    expect(context.contextProps.value.usedTokens).toBe(41);
    expect(context.contextProps.value.usage).toMatchObject({
      inputTokens: 41,
      outputTokens: 9,
      totalTokens: 50,
      reasoningTokens: 3,
      cachedInputTokens: 4,
    });
    expect(context.contextProps.value.usageSource).toBe('official');
  });
});
