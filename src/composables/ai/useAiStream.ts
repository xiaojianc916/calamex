import { computed, getCurrentScope, onScopeDispose, ref } from 'vue';

type TAiStreamStatus = 'idle' | 'streaming' | 'completed' | 'cancelled';

export interface IUseAiStreamOptions {
  messageId?: string;
}

export interface IAiStreamStartOptions {
  messageId?: string;
}

/**
 * AI 流式文本累加器。
 *
 * 平滑流式输出（逐字渐进显示）已交由 markstream-vue 内置的 smoothStreaming 能力处理，
 * 因此这里不再手写 requestAnimationFrame 逐字素节流，只负责：
 * - 维护流式状态机（idle/streaming/completed/cancelled）；
 * - 把原始增量内容直接累加成完整文本，再由渲染层平滑呈现。
 *
 * 对外暴露的 API 与此前保持一致，避免影响上层调用方（如 useAiAssistant）。
 */
export const useAiStream = (options: IUseAiStreamOptions = {}) => {
  void options;

  const content = ref('');
  const status = ref<TAiStreamStatus>('idle');

  const start = (startOptions: Readonly<IAiStreamStartOptions> = {}): void => {
    void startOptions;
    content.value = '';
    status.value = 'streaming';
  };

  const append = (chunk: string): void => {
    if (status.value !== 'streaming' || !chunk) {
      return;
    }

    content.value += chunk;
  };

  const flushNow = (): void => {
    // 内容始终保持最新，无需冲刷缓冲；保留方法以兼容既有调用方。
  };

  const complete = (): void => {
    if (status.value !== 'streaming') {
      return;
    }

    status.value = 'completed';
  };

  const stop = (): void => {
    status.value = 'cancelled';
  };

  if (getCurrentScope()) {
    onScopeDispose(() => {
      content.value = '';
      status.value = 'idle';
    });
  }

  return {
    content,
    bufferedGraphemeCount: computed(() => 0),
    isStreaming: computed(() => status.value === 'streaming'),
    maxBufferedGraphemeCount: computed(() => 0),
    status: computed(() => status.value),
    start,
    append,
    flushNow,
    complete,
    stop,
  };
};
