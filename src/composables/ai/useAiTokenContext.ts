import type { LanguageModelUsage } from 'ai';
import { getContext } from 'tokenlens';
import type { ComputedRef } from 'vue';
import { computed } from 'vue';
import { findModelContextWindow } from '@/constants/ai/providers';
import type { IAiChatMessage } from '@/types/ai';
import type { TAiAssistantMode } from '@/types/ai/assistant-mode';
import type { IAiContextReference } from '@/types/ai/context';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';

export interface IAiTokenContextProps {
  usedTokens: number;
  maxTokens: number;
  modelId?: string;
  usage: LanguageModelUsage;
  usageSource: TAiTokenUsageSource;
}

export type TAiTokenContextMode = TAiAssistantMode;
export type TAiTokenUsageSource = 'official' | 'estimated';

interface IUseAiTokenContextOptions {
  mode: ComputedRef<TAiTokenContextMode>;
  modelId: ComputedRef<string | null | undefined>;
  runtimeEvents: ComputedRef<readonly TAgentRuntimeEvent[]>;
  messages: ComputedRef<readonly IAiChatMessage[]>;
  estimationMessages?: ComputedRef<readonly IAiChatMessage[]>;
  contextReferences: ComputedRef<readonly IAiContextReference[]>;
  hasPendingRequest: ComputedRef<boolean>;
  draft: ComputedRef<string>;
  officialUsage?: ComputedRef<LanguageModelUsage | null | undefined>;
}

const isPositiveFiniteNumber = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const toNonNegativeFiniteNumber = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const resolveUsageInputTokens = (usage: LanguageModelUsage | undefined): number | undefined => {
  const inputTokens = toNonNegativeFiniteNumber(usage?.inputTokens);
  if (inputTokens !== undefined) {
    return inputTokens;
  }

  const totalTokens = toNonNegativeFiniteNumber(usage?.totalTokens);
  const outputTokens = toNonNegativeFiniteNumber(usage?.outputTokens);
  if (totalTokens !== undefined && outputTokens !== undefined) {
    return Math.max(0, totalTokens - outputTokens);
  }

  return undefined;
};

const hasUsableUsage = (
  usage: LanguageModelUsage | null | undefined,
): usage is LanguageModelUsage =>
  resolveUsageInputTokens(usage ?? undefined) !== undefined ||
  toNonNegativeFiniteNumber(usage?.outputTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.totalTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.reasoningTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.cachedInputTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.inputTokenDetails?.cacheReadTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.outputTokenDetails?.reasoningTokens) !== undefined;

const createUsage = (
  inputTokens: number,
  options?: {
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  },
): LanguageModelUsage => {
  const outputTokens = toNonNegativeFiniteNumber(options?.outputTokens) ?? 0;
  const reasoningTokens = toNonNegativeFiniteNumber(options?.reasoningTokens) ?? 0;
  const totalTokens = toNonNegativeFiniteNumber(options?.totalTokens) ?? inputTokens + outputTokens;

  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: Math.max(0, outputTokens - reasoningTokens),
      reasoningTokens,
    },
    totalTokens,
    cachedInputTokens: 0,
    reasoningTokens,
  };
};

interface IResolvedTokenUsage {
  source: TAiTokenUsageSource;
  usage: LanguageModelUsage;
}

const sumTokenCounts = (
  left: number | undefined,
  right: number | undefined,
): number | undefined => {
  if (left === undefined && right === undefined) {
    return undefined;
  }

  return (left ?? 0) + (right ?? 0);
};

const sumRequiredTokenCounts = (left: number | undefined, right: number | undefined): number =>
  (left ?? 0) + (right ?? 0);

const resolveAggregationInputTokenDetails = (
  usage: LanguageModelUsage,
): NonNullable<LanguageModelUsage['inputTokenDetails']> => {
  const inputTokens = resolveUsageInputTokens(usage) ?? 0;
  const cacheReadTokens =
    toNonNegativeFiniteNumber(usage.inputTokenDetails?.cacheReadTokens) ??
    toNonNegativeFiniteNumber(usage.cachedInputTokens) ??
    0;

  return {
    noCacheTokens:
      toNonNegativeFiniteNumber(usage.inputTokenDetails?.noCacheTokens) ??
      Math.max(0, inputTokens - cacheReadTokens),
    cacheReadTokens,
    cacheWriteTokens: toNonNegativeFiniteNumber(usage.inputTokenDetails?.cacheWriteTokens) ?? 0,
  };
};

const resolveAggregationOutputTokenDetails = (
  usage: LanguageModelUsage,
): NonNullable<LanguageModelUsage['outputTokenDetails']> => {
  const outputTokens = toNonNegativeFiniteNumber(usage.outputTokens) ?? 0;
  const reasoningTokens =
    toNonNegativeFiniteNumber(usage.outputTokenDetails?.reasoningTokens) ??
    toNonNegativeFiniteNumber(usage.reasoningTokens) ??
    0;

  return {
    textTokens:
      toNonNegativeFiniteNumber(usage.outputTokenDetails?.textTokens) ??
      Math.max(0, outputTokens - reasoningTokens),
    reasoningTokens,
  };
};

const aggregateUsage = (
  current: LanguageModelUsage | undefined,
  next: LanguageModelUsage,
): LanguageModelUsage => {
  const currentInputDetails = current ? resolveAggregationInputTokenDetails(current) : undefined;
  const nextInputDetails = resolveAggregationInputTokenDetails(next);
  const currentOutputDetails = current ? resolveAggregationOutputTokenDetails(current) : undefined;
  const nextOutputDetails = resolveAggregationOutputTokenDetails(next);
  const cachedInputTokens = sumTokenCounts(
    current?.cachedInputTokens ?? currentInputDetails?.cacheReadTokens,
    next.cachedInputTokens ?? nextInputDetails.cacheReadTokens,
  );
  const reasoningTokens = sumTokenCounts(
    current?.reasoningTokens ?? currentOutputDetails?.reasoningTokens,
    next.reasoningTokens ?? nextOutputDetails.reasoningTokens,
  );

  return {
    inputTokens: sumRequiredTokenCounts(current?.inputTokens, next.inputTokens),
    inputTokenDetails: {
      noCacheTokens: sumRequiredTokenCounts(
        currentInputDetails?.noCacheTokens,
        nextInputDetails.noCacheTokens,
      ),
      cacheReadTokens: sumRequiredTokenCounts(
        currentInputDetails?.cacheReadTokens,
        nextInputDetails.cacheReadTokens,
      ),
      cacheWriteTokens: sumRequiredTokenCounts(
        currentInputDetails?.cacheWriteTokens,
        nextInputDetails.cacheWriteTokens,
      ),
    },
    outputTokens: sumRequiredTokenCounts(current?.outputTokens, next.outputTokens),
    outputTokenDetails: {
      textTokens: sumRequiredTokenCounts(
        currentOutputDetails?.textTokens,
        nextOutputDetails.textTokens,
      ),
      reasoningTokens: sumRequiredTokenCounts(
        currentOutputDetails?.reasoningTokens,
        nextOutputDetails.reasoningTokens,
      ),
    },
    totalTokens: sumRequiredTokenCounts(current?.totalTokens, next.totalTokens),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
};

const resolveStreamOfficialUsage = (
  stream: IAiChatMessage['stream'] | undefined,
): LanguageModelUsage | undefined => {
  if (!stream) {
    return undefined;
  }

  if (hasUsableUsage(stream.usage)) {
    return stream.usage;
  }

  if (stream.status !== 'completed') {
    return undefined;
  }

  const promptTokens = toNonNegativeFiniteNumber(stream.promptTokens);
  const completionTokens = toNonNegativeFiniteNumber(stream.completionTokens);
  const totalTokens = toNonNegativeFiniteNumber(stream.totalTokens);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return createUsage(promptTokens ?? 0, {
    outputTokens: completionTokens,
    totalTokens,
  });
};

const resolveAccumulatedStreamUsage = (
  messages: readonly IAiChatMessage[],
): IResolvedTokenUsage | undefined => {
  const usage = messages.reduce<LanguageModelUsage | undefined>((current, message) => {
    const streamUsage = resolveStreamOfficialUsage(message.stream);

    if (!streamUsage) {
      return current;
    }

    return aggregateUsage(current, streamUsage);
  }, undefined);

  return usage ? { source: 'official', usage } : undefined;
};

const resolveMaxTokens = (modelId: string | undefined): number => {
  if (!modelId) {
    return 0;
  }

  // 优先用应用自己的模型目录(覆盖 Mastra 路由的别名/未来模型,tokenlens 目录可能不识别)。
  const catalogContextWindow = findModelContextWindow(modelId);
  if (isPositiveFiniteNumber(catalogContextWindow)) {
    return catalogContextWindow;
  }

  // 目录未命中或窗口未知时,兜底查 tokenlens;仍拿不到则返回 0(UI 显示"未知")。
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

  const accumulatedStreamUsage = computed(() =>
    resolveAccumulatedStreamUsage(options.messages.value),
  );
  const latestOfficialUsage = computed<IResolvedTokenUsage | undefined>(() => {
    const usage = options.officialUsage?.value;

    if (!hasUsableUsage(usage)) {
      return undefined;
    }

    return {
      source: 'official',
      usage,
    };
  });
  const latestCompletedUsage = computed(
    () => latestOfficialUsage.value ?? accumulatedStreamUsage.value,
  );

  const usedTokens = computed(
    () => resolveUsageInputTokens(latestCompletedUsage.value?.usage) ?? 0,
  );
  const usage = computed<LanguageModelUsage>(
    () => latestCompletedUsage.value?.usage ?? createUsage(0),
  );
  const usageSource = computed<TAiTokenUsageSource>(() => 'official');
  const maxTokens = computed(() => resolveMaxTokens(normalizedModelId.value));

  const contextProps = computed<IAiTokenContextProps>(() => ({
    usedTokens: usedTokens.value,
    maxTokens: maxTokens.value,
    ...(normalizedModelId.value ? { modelId: normalizedModelId.value } : {}),
    usage: usage.value,
    usageSource: usageSource.value,
  }));

  return {
    contextProps,
  };
};
