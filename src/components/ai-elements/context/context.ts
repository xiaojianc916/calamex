import type { LanguageModelUsage } from 'ai';
import type { ComputedRef, InjectionKey } from 'vue';
import { inject } from 'vue';
import type { TAiTokenUsageSource } from '@/composables/ai/useAiTokenContext';

export type TContextModelId = string;

export interface IContextUsageCost {
  inputCostText?: string;
  outputCostText?: string;
  totalCostText?: string;
  cacheHitInputCostText?: string;
  cacheMissInputCostText?: string;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
}

export interface IContextValue {
  usedTokens: ComputedRef<number>;
  maxTokens: ComputedRef<number>;
  usage: ComputedRef<LanguageModelUsage | undefined>;
  usageSource: ComputedRef<TAiTokenUsageSource>;
  modelId: ComputedRef<TContextModelId | undefined>;
  cost: ComputedRef<IContextUsageCost | undefined>;
}

export const ContextKey: InjectionKey<IContextValue> = Symbol('ContextContext');

export const useContextValue = (): IContextValue => {
  const context = inject(ContextKey);
  if (!context) {
    throw new Error('Context 组件必须在 Context 内部使用。');
  }

  return context;
};
