import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';
import { useAiTokenContext } from '@/composables/ai/useAiTokenContext';
import type { IAiChatMessage } from '@/types/ai';
import type { IAiContextReference } from '@/types/ai/context';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

const createMessage = (content: string): IAiChatMessage => ({
  id: 'message-1',
  role: 'assistant',
  content,
  createdAt: '2026-05-09T10:00:00.000Z',
  references: [],
});

const createModelStartedEvent = (projectedInputTokens: number): TAgentRuntimeEvent => ({
  id: 'runtime-token-1',
  type: 'agent.model.started',
  runId: 'run-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
  timestamp: '2026-05-09T10:00:01.000Z',
  seq: 1,
  schemaVersion: 1,
  redacted: true,
  visibility: 'debug',
  level: 'info',
  projectedInputTokens,
  projectedInputTokensAvailable: true,
});

const createContext = (options?: {
  mode?: 'chat' | 'agent' | 'plan';
  runtimeEvents?: ReturnType<typeof ref<readonly TAgentRuntimeEvent[]>>;
  messages?: ReturnType<typeof ref<IAiChatMessage[]>>;
  estimationMessages?: ReturnType<typeof ref<IAiChatMessage[]>>;
  contextReferences?: ReturnType<typeof ref<IAiContextReference[]>>;
  hasPendingRequest?: ReturnType<typeof ref<boolean>>;
  draft?: ReturnType<typeof ref<string>>;
  officialUsage?: ReturnType<typeof ref<LanguageModelUsage | null | undefined>>;
}) => {
  const runtimeEvents = options?.runtimeEvents ?? ref<readonly TAgentRuntimeEvent[]>([]);
  const messages = options?.messages ?? ref<IAiChatMessage[]>([]);
  const estimationMessages = options?.estimationMessages ?? ref<IAiChatMessage[]>(messages.value);
  const contextReferences = options?.contextReferences ?? ref<IAiContextReference[]>([]);
  const hasPendingRequest = options?.hasPendingRequest ?? ref(false);
  const draft = options?.draft ?? ref('');
  const officialUsage = options?.officialUsage ?? ref<LanguageModelUsage | null>(null);

  return useAiTokenContext({
    mode: computed(() => options?.mode ?? 'chat'),
    modelId: computed(() => 'deepseek/deepseek-v4-pro'),
    runtimeEvents: computed(() => runtimeEvents.value),
    messages: computed(() => messages.value),
    estimationMessages: computed(() => estimationMessages.value),
    contextReferences: computed(() => contextReferences.value),
    hasPendingRequest: computed(() => hasPendingRequest.value),
    draft: computed(() => draft.value),
    officialUsage: computed(() => officialUsage.value),
  });
};

describe('useAiTokenContext', () => {
  it('resolves the deepseek context window (1M) from the model catalog', () => {
    const context = useAiTokenContext({
      mode: computed(() => 'chat'),
      modelId: computed(() => 'deepseek/deepseek-v4-flash'),
      runtimeEvents: computed(() => []),
      messages: computed(() => []),
      estimationMessages: computed(() => []),
      contextReferences: computed(() => []),
      hasPendingRequest: computed(() => false),
      draft: computed(() => ''),
    });

    expect(context.contextProps.value.maxTokens).toBe(1_000_000);
  });

  it('resolves the context window from the model catalog for GLM models', () => {
    const context = useAiTokenContext({
      mode: computed(() => 'chat'),
      modelId: computed(() => 'zhipuai/glm-4-flash'),
      runtimeEvents: computed(() => []),
      messages: computed(() => []),
      estimationMessages: computed(() => []),
      contextReferences: computed(() => []),
      hasPendingRequest: computed(() => false),
      draft: computed(() => ''),
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

  it('ignores runtime projections and uses official stream usage', () => {
    const messages = ref<IAiChatMessage[]>([
      {
        ...createMessage('上一轮回复'),
        stream: {
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
        },
      },
    ]);
    const runtimeEvents = ref<readonly TAgentRuntimeEvent[]>([createModelStartedEvent(999)]);
    const context = createContext({
      mode: 'chat',
      messages,
      estimationMessages: messages,
      runtimeEvents,
    });

    expect(context.contextProps.value.usedTokens).toBe(13);
    expect(context.contextProps.value.usage.inputTokens).toBe(13);
    expect(context.contextProps.value.usage.outputTokens).toBe(5);
    expect(context.contextProps.value.usageSource).toBe('official');
  });

  it('accumulates official stream usage for the current conversation', () => {
    const messages = ref<IAiChatMessage[]>([
      {
        ...createMessage('第一轮回复'),
        id: 'message-1',
        stream: {
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
        },
      },
      {
        ...createMessage('第二轮回复'),
        id: 'message-2',
        stream: {
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
        },
      },
    ]);
    const context = createContext({
      mode: 'chat',
      messages,
      estimationMessages: messages,
    });

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

  it('prioritizes official sidecar usage over stream usage', () => {
    const messages = ref<IAiChatMessage[]>([
      {
        ...createMessage('这条消息的流式 usage 不应覆盖官方 usage。'),
        stream: {
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
        },
      },
    ]);
    const runtimeEvents = ref<readonly TAgentRuntimeEvent[]>([createModelStartedEvent(999)]);
    const officialUsage = ref<LanguageModelUsage>({
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
      mode: 'plan',
      messages,
      estimationMessages: ref<IAiChatMessage[]>([]),
      runtimeEvents,
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
