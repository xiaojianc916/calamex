import { useAiTokenContext } from '@/composables/useAiTokenContext';
import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';
import type { IAiChatMessage } from '@/types/ai';
import type { IAiContextReference } from '@/types/ai-context';
import type { LanguageModelUsage } from 'ai';
import { describe, expect, it } from 'vitest';
import { computed, ref } from 'vue';

const createMessage = (content: string): IAiChatMessage => ({
  id: 'message-1',
  role: 'assistant',
  content,
  createdAt: '2026-05-09T10:00:00.000Z',
  references: [],
});

const createPendingReference = (contentPreview: string): IAiContextReference => ({
  id: 'reference-1',
  kind: 'current-file',
  label: '当前文件',
  path: '/workspace/src/example.ts',
  range: null,
  contentPreview,
  redacted: true,
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
  it('uses 1M context window for deepseek models', () => {
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

  it('estimates visible conversation tokens before runtime token events arrive', () => {
    const messages = ref<IAiChatMessage[]>([
      createMessage('总的来说，我可以帮你读写文件、搜索代码、分析日志。'),
    ]);
    const draft = ref('');
    const hasPendingRequest = ref(false);
    const context = createContext({
      mode: 'chat',
      messages,
      estimationMessages: messages,
      draft,
      hasPendingRequest,
    });

    const initialTokens = context.contextProps.value.usedTokens;
    draft.value = '继续解释 Git 操作。';
    hasPendingRequest.value = true;

    expect(initialTokens).toBeGreaterThan(0);
    expect(context.contextProps.value.usedTokens).toBeGreaterThan(initialTokens);
  });

  it('uses runtime projected input tokens when available', () => {
    const messages = ref<IAiChatMessage[]>([
      createMessage('这条本地估算内容会被 runtime token 覆盖。'),
    ]);
    const runtimeEvents = ref<readonly TAgentRuntimeEvent[]>([createModelStartedEvent(12345)]);
    const context = useAiTokenContext({
      mode: computed(() => 'chat'),
      modelId: computed(() => 'openai/gpt-5'),
      runtimeEvents: computed(() => runtimeEvents.value),
      messages: computed(() => messages.value),
      estimationMessages: computed(() => messages.value),
      contextReferences: computed(() => []),
      hasPendingRequest: computed(() => false),
      draft: computed(() => ''),
    });

    expect(context.contextProps.value.usedTokens).toBe(12345);
    expect(context.contextProps.value.usage.inputTokens).toBe(12345);
  });

  it('includes pending references in local estimation', () => {
    const contextReferences = ref<IAiContextReference[]>([]);
    const hasPendingRequest = ref(false);
    const context = createContext({
      mode: 'chat',
      contextReferences,
      hasPendingRequest,
    });

    const withoutReferences = context.contextProps.value.usedTokens;
    contextReferences.value = [createPendingReference('上下文内容'.repeat(20))];
    hasPendingRequest.value = true;

    expect(withoutReferences).toBe(0);
    expect(context.contextProps.value.usedTokens).toBeGreaterThan(withoutReferences);
  });

  it('uses stream usage when there is no pending user input', () => {
    const messages = ref<IAiChatMessage[]>([
      {
        ...createMessage('上一轮回复'),
        stream: {
          status: 'completed',
          promptTokens: 13,
          completionTokens: 5,
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

  it('prioritizes official sidecar usage over runtime and local estimates', () => {
    const messages = ref<IAiChatMessage[]>([
      createMessage('这条消息的本地估算不应覆盖官方 usage。'.repeat(20)),
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

  it('does not let stale runtime estimates override a new draft', () => {
    const draft = ref('');
    const runtimeEvents = ref<readonly TAgentRuntimeEvent[]>([createModelStartedEvent(1)]);
    const hasPendingRequest = ref(false);
    const context = createContext({
      mode: 'chat',
      runtimeEvents,
      draft,
      hasPendingRequest,
    });

    expect(context.contextProps.value.usedTokens).toBe(1);

    draft.value = '这是一个需要重新估算的草稿。'.repeat(12);
    hasPendingRequest.value = true;

    expect(context.contextProps.value.usedTokens).toBeGreaterThan(1);
    expect(context.contextProps.value.usage.outputTokens).toBe(0);
  });

  it('ignores chat history when estimating a new agent request', () => {
    const messages = ref<IAiChatMessage[]>([
      createMessage('历史对话内容。'.repeat(80)),
    ]);
    const estimationMessages = ref<IAiChatMessage[]>([]);
    const draft = ref('帮我检查当前文件。');
    const hasPendingRequest = ref(true);
    const chatContext = createContext({
      mode: 'chat',
      messages,
      estimationMessages: messages,
      draft,
      hasPendingRequest,
    });
    const agentContext = createContext({
      mode: 'agent',
      messages,
      estimationMessages,
      draft,
      hasPendingRequest,
    });

    expect(agentContext.contextProps.value.usedTokens).toBeLessThan(chatContext.contextProps.value.usedTokens);
  });

  it('estimates plan output tokens from the current flow message when real usage is unavailable', () => {
    const messages = ref<IAiChatMessage[]>([
      {
        ...createMessage('计划执行完成，已生成最终结论。'.repeat(6)),
        id: 'agent-flow:run-1',
      },
    ]);
    const context = createContext({
      mode: 'plan',
      messages,
      estimationMessages: ref<IAiChatMessage[]>([]),
    });

    expect(context.contextProps.value.usedTokens).toBe(0);
    expect(context.contextProps.value.usage.outputTokens).toBeGreaterThan(0);
  });

  it('can estimate plan step input while the plan run is active', () => {
    const estimationMessages = ref<IAiChatMessage[]>([
      {
        id: 'plan-system',
        role: 'system',
        content: '你正在执行 IDE Agent Plan 的单个步骤。',
        createdAt: '2026-05-09T10:00:00.000Z',
        references: [],
      },
      {
        id: 'plan-user',
        role: 'user',
        content: '任务目标：完成修复\n当前步骤：验证结果\n步骤目标：验证结果',
        createdAt: '2026-05-09T10:00:00.000Z',
        references: [],
      },
    ]);
    const contextReferences = ref<IAiContextReference[]>([createPendingReference('当前文件内容'.repeat(10))]);
    const hasPendingRequest = ref(true);
    const context = createContext({
      mode: 'plan',
      messages: ref<IAiChatMessage[]>([]),
      estimationMessages,
      contextReferences,
      hasPendingRequest,
    });

    expect(context.contextProps.value.usedTokens).toBeGreaterThan(0);
    expect(context.contextProps.value.usage.outputTokens).toBe(0);
  });
});
