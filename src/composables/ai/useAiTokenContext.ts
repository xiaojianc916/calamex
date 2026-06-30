import type { ComputedRef } from 'vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { findModelContextWindow } from '@/constants/ai/providers';
import type { IAiLanguageModelUsage } from '@/types/ai';
import type { TAiAssistantMode } from '@/types/ai/assistant-mode';
import type { IAiThreadAssistantMessageEntry, IAiThreadEntry } from '@/types/ai/thread';

export interface IAiTokenContextProps {
  usedTokens: number;
  maxTokens: number;
  modelId?: string;
  usage: IAiLanguageModelUsage;
  usageSource: TAiTokenUsageSource;
}

export type TAiTokenContextMode = TAiAssistantMode;
export type TAiTokenUsageSource = 'official' | 'estimated';

interface IUseAiTokenContextOptions {
  mode: ComputedRef<TAiTokenContextMode>;
  modelId: ComputedRef<string | null | undefined>;
  entries: ComputedRef<readonly IAiThreadEntry[]>;
  officialUsage?: ComputedRef<IAiLanguageModelUsage | null | undefined>;
}

const isPositiveFiniteNumber = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const toNonNegativeFiniteNumber = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const resolveUsageInputTokens = (usage: IAiLanguageModelUsage | undefined): number | undefined => {
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
  usage: IAiLanguageModelUsage | null | undefined,
): usage is IAiLanguageModelUsage =>
  resolveUsageInputTokens(usage ?? undefined) !== undefined ||
  toNonNegativeFiniteNumber(usage?.outputTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.totalTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.outputTokenDetails?.reasoningTokens) !== undefined ||
  toNonNegativeFiniteNumber(usage?.inputTokenDetails?.cacheReadTokens) !== undefined;

const createUsage = (
  inputTokens: number,
  options?: {
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
  },
): IAiLanguageModelUsage => {
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
  usage: IAiLanguageModelUsage;
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
  usage: IAiLanguageModelUsage,
): NonNullable<IAiLanguageModelUsage['inputTokenDetails']> => {
  const inputTokens = resolveUsageInputTokens(usage) ?? 0;
  const cacheReadTokens = toNonNegativeFiniteNumber(usage.inputTokenDetails?.cacheReadTokens) ?? 0;

  return {
    noCacheTokens:
      toNonNegativeFiniteNumber(usage.inputTokenDetails?.noCacheTokens) ??
      Math.max(0, inputTokens - cacheReadTokens),
    cacheReadTokens,
    cacheWriteTokens: toNonNegativeFiniteNumber(usage.inputTokenDetails?.cacheWriteTokens) ?? 0,
  };
};

const resolveAggregationOutputTokenDetails = (
  usage: IAiLanguageModelUsage,
): NonNullable<IAiLanguageModelUsage['outputTokenDetails']> => {
  const outputTokens = toNonNegativeFiniteNumber(usage.outputTokens) ?? 0;
  const reasoningTokens = toNonNegativeFiniteNumber(usage.outputTokenDetails?.reasoningTokens) ?? 0;

  return {
    textTokens:
      toNonNegativeFiniteNumber(usage.outputTokenDetails?.textTokens) ??
      Math.max(0, outputTokens - reasoningTokens),
    reasoningTokens,
  };
};

const aggregateUsage = (
  current: IAiLanguageModelUsage | undefined,
  next: IAiLanguageModelUsage,
): IAiLanguageModelUsage => {
  const currentInputDetails = current ? resolveAggregationInputTokenDetails(current) : undefined;
  const nextInputDetails = resolveAggregationInputTokenDetails(next);
  const currentOutputDetails = current ? resolveAggregationOutputTokenDetails(current) : undefined;
  const nextOutputDetails = resolveAggregationOutputTokenDetails(next);
  const cachedInputTokens = sumTokenCounts(
    currentInputDetails?.cacheReadTokens,
    nextInputDetails.cacheReadTokens,
  );
  const reasoningTokens = sumTokenCounts(
    currentOutputDetails?.reasoningTokens,
    nextOutputDetails.reasoningTokens,
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
  stream: IAiThreadAssistantMessageEntry['stream'],
): IAiLanguageModelUsage | undefined => {
  if (!stream) {
    return undefined;
  }

  if (hasUsableUsage(stream.usage)) {
    return stream.usage;
  }

  if (stream.status !== 'completed') {
    return undefined;
  }

  const promptTokens = toNonNegativeFiniteNumber(stream.inputTokens);
  const completionTokens = toNonNegativeFiniteNumber(stream.outputTokens);
  const totalTokens = toNonNegativeFiniteNumber(stream.totalTokens);

  if (promptTokens === undefined && completionTokens === undefined && totalTokens === undefined) {
    return undefined;
  }

  return createUsage(promptTokens ?? 0, {
    outputTokens: completionTokens,
    totalTokens,
  });
};

type TTokenUsageStream = IAiThreadAssistantMessageEntry['stream'];

// 非 chat 模式只计入「与工具回合关联或带运行时事件」的助手流（对标旧的 token 计入过滤）：
// user 重置回合、tool_call 标记本回合涉工具、assistant 结算后复位。
const collectTokenUsageStreams = (
  entries: readonly IAiThreadEntry[],
  mode: TAiTokenContextMode,
): TTokenUsageStream[] => {
  const streams: TTokenUsageStream[] = [];
  let pendingTurnToolCall = false;

  for (const entry of entries) {
    if (entry.type === 'user_message') {
      pendingTurnToolCall = false;
      continue;
    }

    if (entry.type === 'tool_call') {
      pendingTurnToolCall = true;
      continue;
    }

    if (entry.type === 'assistant_message') {
      const hasRuntimeEvents = (entry.stream?.runtimeEvents?.length ?? 0) > 0;

      if (mode === 'chat' || pendingTurnToolCall || hasRuntimeEvents) {
        streams.push(entry.stream);
      }

      pendingTurnToolCall = false;
    }
  }

  return streams;
};

const resolveAccumulatedStreamUsage = (
  streams: readonly TTokenUsageStream[],
): IResolvedTokenUsage | undefined => {
  const usage = streams.reduce<IAiLanguageModelUsage | undefined>((current, stream) => {
    const streamUsage = resolveStreamOfficialUsage(stream);

    if (!streamUsage) {
      return current;
    }

    return aggregateUsage(current, streamUsage);
  }, undefined);

  return usage ? { source: 'official', usage } : undefined;
};

type TTokenlensModule = typeof import('tokenlens');

let tokenlensModulePromise: Promise<TTokenlensModule> | null = null;

const loadTokenlensModule = (): Promise<TTokenlensModule> => {
  tokenlensModulePromise ??= import('tokenlens');
  return tokenlensModulePromise;
};

const resolveCatalogMaxTokens = (modelId: string | undefined): number => {
  if (!modelId) {
    return 0;
  }

  // 首屏只查应用自己的轻量模型目录，避免 AI 面板挂载时同步拉入 tokenlens。
  const catalogContextWindow = findModelContextWindow(modelId);
  return isPositiveFiniteNumber(catalogContextWindow) ? catalogContextWindow : 0;
};

const resolveTokenlensMaxTokens = async (modelId: string): Promise<number> => {
  const { getContext } = await loadTokenlensModule();
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
    resolveAccumulatedStreamUsage(
      collectTokenUsageStreams(options.entries.value, options.mode.value),
    ),
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
  const usage = computed<IAiLanguageModelUsage>(
    () => latestCompletedUsage.value?.usage ?? createUsage(0),
  );
  const usageSource = computed<TAiTokenUsageSource>(() => 'official');
  const maxTokens = ref(0);
  let disposed = false;
  let maxTokensTimer: ReturnType<typeof setTimeout> | null = null;

  const clearMaxTokensTimer = (): void => {
    if (maxTokensTimer !== null) {
      clearTimeout(maxTokensTimer);
      maxTokensTimer = null;
    }
  };

  watch(
    normalizedModelId,
    (modelId) => {
      clearMaxTokensTimer();
      const catalogMaxTokens = resolveCatalogMaxTokens(modelId);
      maxTokens.value = catalogMaxTokens;

      if (!modelId || catalogMaxTokens > 0) {
        return;
      }

      // tokenlens 只作为首屏后的兜底目录：不阻塞 AI 主界面初次显示。
      maxTokensTimer = setTimeout(() => {
        maxTokensTimer = null;
        void resolveTokenlensMaxTokens(modelId)
          .then((resolvedMaxTokens) => {
            if (!disposed && normalizedModelId.value === modelId && resolvedMaxTokens > 0) {
              maxTokens.value = resolvedMaxTokens;
            }
          })
          .catch(() => undefined);
      }, 1_200);
    },
    { immediate: true },
  );

  onBeforeUnmount(() => {
    disposed = true;
    clearMaxTokensTimer();
  });

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
