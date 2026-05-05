import { inject, type InjectionKey, type Ref } from 'vue';

export interface IReasoningContextValue {
  isStreaming: Ref<boolean>;
  isOpen: Ref<boolean>;
  setIsOpen: (open: boolean) => void;
  duration: Ref<number | undefined>;
}

export const ReasoningKey: InjectionKey<IReasoningContextValue> = Symbol('ReasoningContext');

export function useReasoningContext(): IReasoningContextValue {
  const context = inject(ReasoningKey);

  if (!context) {
    throw new Error('Reasoning components must be used within <Reasoning>');
  }

  return context;
}
