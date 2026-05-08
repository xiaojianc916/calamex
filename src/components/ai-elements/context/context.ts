import type { LanguageModelUsage } from 'ai';
import type { ComputedRef, InjectionKey } from 'vue';
import { inject } from 'vue';

export type TContextModelId = string;

export interface IContextValue {
  usedTokens: ComputedRef<number>;
  maxTokens: ComputedRef<number>;
  usage: ComputedRef<LanguageModelUsage | undefined>;
  modelId: ComputedRef<TContextModelId | undefined>;
}

export const ContextKey: InjectionKey<IContextValue> = Symbol('ContextContext');

export const useContextValue = (): IContextValue => {
  const context = inject(ContextKey);
  if (!context) {
    throw new Error('Context 组件必须在 Context 内部使用。');
  }

  return context;
};
