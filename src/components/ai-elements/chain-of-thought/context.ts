import { inject, type InjectionKey, type Ref } from 'vue';

export const ChainOfThoughtContextKey: InjectionKey<Ref<boolean>> = Symbol('ChainOfThoughtContext');

export function useChainOfThought() {
  const isOpen = inject(ChainOfThoughtContextKey);

  if (!isOpen) {
    throw new Error('useChainOfThought must be used within a <ChainOfThought> component');
  }

  const setIsOpen = (open: boolean): void => {
    isOpen.value = open;
  };

  return { isOpen, setIsOpen };
}
