import { computed, ref, unref, type MaybeRef } from 'vue';
import { createStreamingFenceParser } from '@/composables/useStreamingFenceParser';
import type { TAiSupportedLang } from '@/types/ai-code';

export interface IUseAiStreamOptions {
  messageId?: MaybeRef<string>;
  contextLang?: MaybeRef<TAiSupportedLang | undefined>;
}

export interface IAiStreamStartOptions {
  messageId?: string;
  contextLang?: TAiSupportedLang;
}

export const useAiStream = (options: IUseAiStreamOptions = {}) => {
  const content = ref('');
  const isStreaming = ref(false);
  const defaultMessageId = `stream-${Date.now()}`;
  let activeMessageId = unref(options.messageId) ?? defaultMessageId;
  let activeContextLang = unref(options.contextLang);
  let parser = createStreamingFenceParser(activeMessageId, activeContextLang);
  const fenceSnapshot = ref(parser.snapshot());

  const start = (startOptions: IAiStreamStartOptions = {}): void => {
    content.value = '';
    isStreaming.value = true;
    activeMessageId = startOptions.messageId ?? unref(options.messageId) ?? defaultMessageId;
    activeContextLang = startOptions.contextLang ?? unref(options.contextLang);
    parser = createStreamingFenceParser(activeMessageId, activeContextLang);
    fenceSnapshot.value = parser.snapshot();
  };

  const append = (chunk: string): void => {
    if (!isStreaming.value) return;
    content.value += chunk;
    fenceSnapshot.value = parser.append(chunk);
  };

  const complete = (): void => {
    fenceSnapshot.value = parser.complete();
    isStreaming.value = false;
  };

  const stop = (): void => {
    fenceSnapshot.value = parser.cancel();
    isStreaming.value = false;
  };

  return {
    content,
    isStreaming,
    fenceSnapshot,
    codeBlocks: computed(() => fenceSnapshot.value.blocks),
    openCodeBlock: computed(() => fenceSnapshot.value.openBlock),
    closedCodeBlockIds: computed(() => fenceSnapshot.value.closedBlockIds),
    stableContent: computed(() => fenceSnapshot.value.stableContent),
    status: computed(() => fenceSnapshot.value.status),
    start,
    append,
    complete,
    stop,
  };
};
