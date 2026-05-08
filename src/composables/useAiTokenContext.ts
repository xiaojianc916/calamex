import type { LanguageModelUsage } from 'ai';
import type { ComputedRef } from 'vue';
import type { TAgentRuntimeEvent } from '@/types/agent-sidecar';
import { getContext } from 'tokenlens';
import { computed } from 'vue';

export interface IAiTokenContextProps {
  usedTokens: number;
  maxTokens: number;
  modelId?: string;
  usage: LanguageModelUsage;
}

interface IUseAiTokenContextOptions {
  modelId: ComputedRef<string | null | undefined>;
  runtimeEvents: ComputedRef<readonly TAgentRuntimeEvent[]>;
}

const createUsage = (inputTokens: number): LanguageModelUsage => ({
  inputTokens,
  inputTokenDetails: {
    noCacheTokens: inputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 0,
  outputTokenDetails: {
    textTokens: 0,
    reasoningTokens: 0,
  },
  totalTokens: inputTokens,
  cachedInputTokens: 0,
  reasoningTokens: 0,
});

const isPositiveFiniteNumber = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const resolveMaxTokens = (modelId: string | undefined): number => {
  if (!modelId) {
    return 0;
  }

  const context = getContext({ modelId });
  const maxTokens = [
    context.maxTotal,
    context.totalMax,
    context.combinedMax,
    context.maxInput,
    context.inputMax,
  ].find(isPositiveFiniteNumber);

  return maxTokens ?? 0;
};

export const useAiTokenContext = (options: IUseAiTokenContextOptions) => {
  const normalizedModelId = computed(() => {
    const value = options.modelId.value?.trim();
    return value ? value : undefined;
  });

  const projectedInputTokens = computed(() => {
    const events = options.runtimeEvents.value;

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event?.type === 'acontext.token.checked' &&
        event.projectedInputTokensAvailable &&
        isPositiveFiniteNumber(event.projectedInputTokens)
      ) {
        return event.projectedInputTokens;
      }
    }

    return 0;
  });

  const usage = computed(() => createUsage(projectedInputTokens.value));
  const maxTokens = computed(() => resolveMaxTokens(normalizedModelId.value));

  const contextProps = computed<IAiTokenContextProps>(() => ({
    usedTokens: usage.value.totalTokens ?? 0,
    maxTokens: maxTokens.value,
    ...(normalizedModelId.value ? { modelId: normalizedModelId.value } : {}),
    usage: usage.value,
  }));

  return {
    contextProps,
  };
};
