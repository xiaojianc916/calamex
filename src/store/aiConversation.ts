import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import type { IAiChatMessage } from '@/types/ai';
import {
  aiConversationLegacyPersistSchema,
  aiConversationPersistSchema,
} from '@/types/ai/conversation.schema';
import { getAiConversationPersistStorage } from './plugins/debouncedPersistStorage';

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

export const AI_CONVERSATION_HISTORY_LIMIT = 20;

const TEMPORARY_TITLE_MAX_CHARS = 24;
const GENERATED_TITLE_MAX_CHARS = 10;

export type TAiConversationTitleStatus = 'temporary' | 'generating' | 'generated' | 'failed';

export interface IAiConversationFirstRound {
  userMessage: string;
  assistantMessage: string;
}

export interface IAiConversationScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  updatedAt: string;
}

export interface IAiConversationThread {
  id: string;
  title: string;
  titleStatus: TAiConversationTitleStatus;
  updatedAt: string;
  createdAt: string;
  messages: IAiChatMessage[];
  scrollState?: IAiConversationScrollState;
}

/**
 * 持久化形状; 与 store 内部状态结构一致, 使用手写接口而非
 * z.infer<typeof aiConversationPersistSchema>, 避免 IAiChatMessage 与
 * aiChatMessageSchema 推断类型漂移引发 TS2322。
 *
 * afterHydrate 中对 parse 结果做一次 boundary cast (as unknown as) 即可。
 * 长期方案: 把 IAiChatMessage 改为 z.infer<typeof aiChatMessageSchema>。
 */
interface IAiConversationPersistShape {
  activeThreadId: string | null;
  threads: IAiConversationThread[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const createThreadId = (): string =>
  `ai-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const normalizeHydratedMessage = (message: IAiChatMessage): IAiChatMessage => {
  if (message.stream?.status !== 'streaming') return message;
  return {
    ...message,
    stream: {
      ...message.stream,
      status: 'cancelled',
    },
  };
};

const normalizeMessages = (messages: IAiChatMessage[]): IAiChatMessage[] =>
  messages.map(normalizeHydratedMessage);

const normalizeTitleSource = (value: string): string =>
  value.normalize('NFC').replace(/\s+/gu, ' ').trim();

const clipUnicodeText = (value: string, maxChars: number): string => {
  const characters = Array.from(value);
  if (characters.length <= maxChars) {
    return value;
  }
  return `${characters.slice(0, maxChars).join('')}…`;
};

const deriveTemporaryConversationTitle = (messages: IAiChatMessage[]): string => {
  const firstUserMessage = messages.find(
    (message) => message.role === 'user' && message.content.trim(),
  );
  const source = firstUserMessage?.content.trim() ?? messages[0]?.content.trim() ?? '';
  if (!source) return '新对话';
  return clipUnicodeText(normalizeTitleSource(source), TEMPORARY_TITLE_MAX_CHARS);
};

// 头尾各类引号/括号字符;命中即剥除。
const TITLE_TRIM_LEADING = /^["'“”‘’《》【】「」『』\s]+/gu;
const TITLE_TRIM_TRAILING = /["'“”‘’《》【】「」『』\s]+$/gu;

const normalizeGeneratedTitle = (title: string): string => {
  const normalized = normalizeTitleSource(title)
    .replace(TITLE_TRIM_LEADING, '')
    .replace(TITLE_TRIM_TRAILING, '');
  return clipUnicodeText(normalized, GENERATED_TITLE_MAX_CHARS).replace(/…$/u, '');
};

const createThread = (messages: IAiChatMessage[] = []): IAiConversationThread => {
  const timestamp = new Date().toISOString();
  return {
    id: createThreadId(),
    title: deriveTemporaryConversationTitle(messages),
    titleStatus: 'temporary',
    updatedAt: messages.at(-1)?.createdAt ?? timestamp,
    createdAt: timestamp,
    messages,
  };
};

const syncThreadMeta = (thread: IAiConversationThread): IAiConversationThread => {
  const generatedTitle =
    thread.titleStatus === 'generated' ? normalizeGeneratedTitle(thread.title) : '';
  return {
    ...thread,
    title: generatedTitle || deriveTemporaryConversationTitle(thread.messages),
    titleStatus: generatedTitle ? 'generated' : thread.titleStatus,
    updatedAt: thread.messages.at(-1)?.createdAt ?? thread.updatedAt,
  };
};

const getFirstRoundFromMessages = (
  messages: IAiChatMessage[],
): IAiConversationFirstRound | null => {
  const firstUserIndex = messages.findIndex(
    (message) => message.role === 'user' && message.content.trim().length > 0,
  );
  if (firstUserIndex < 0) {
    return null;
  }
  const firstUserMessage = messages[firstUserIndex];
  const firstAssistantMessage = messages
    .slice(firstUserIndex + 1)
    .find(
      (message) =>
        message.role === 'assistant' &&
        message.content.trim().length > 0 &&
        message.stream?.status !== 'streaming' &&
        message.stream?.status !== 'cancelled',
    );
  if (!firstUserMessage || !firstAssistantMessage) {
    return null;
  }
  return {
    userMessage: normalizeTitleSource(firstUserMessage.content),
    assistantMessage: normalizeTitleSource(firstAssistantMessage.content),
  };
};

const trimThreads = (
  threads: IAiConversationThread[],
  activeThreadId: string | null,
): IAiConversationThread[] => {
  const activeThread = activeThreadId
    ? (threads.find((thread) => thread.id === activeThreadId) ?? null)
    : null;
  const trimmedNonEmptyThreads = threads
    .filter((thread) => thread.messages.length > 0)
    .slice(-AI_CONVERSATION_HISTORY_LIMIT);
  if (activeThread && activeThread.messages.length === 0) {
    return [...trimmedNonEmptyThreads, activeThread];
  }
  return trimmedNonEmptyThreads;
};

const normalizeHydratedThreads = (
  threads: IAiConversationThread[],
  activeThreadId: string | null,
): IAiConversationThread[] =>
  trimThreads(
    threads.map((thread) =>
      syncThreadMeta({
        ...thread,
        messages: normalizeMessages(thread.messages),
      }),
    ),
    activeThreadId,
  );

const migrateLegacyMessages = (messages: IAiChatMessage[]): IAiConversationPersistShape => {
  const normalizedMessages = normalizeMessages(messages);
  if (normalizedMessages.length === 0) {
    const emptyThread = createThread();
    return {
      activeThreadId: emptyThread.id,
      threads: [emptyThread],
    };
  }
  const thread = createThread(normalizedMessages);
  return {
    activeThreadId: thread.id,
    threads: [thread],
  };
};

const ensureActiveThread = (
  activeThreadId: string | null,
  threads: IAiConversationThread[],
): IAiConversationPersistShape => {
  if (threads.length === 0) {
    const emptyThread = createThread();
    return {
      activeThreadId: emptyThread.id,
      threads: [emptyThread],
    };
  }
  const resolvedActiveThreadId =
    activeThreadId && threads.some((thread) => thread.id === activeThreadId)
      ? activeThreadId
      : (threads.at(-1)?.id ?? null);
  return {
    activeThreadId: resolvedActiveThreadId,
    threads,
  };
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAiConversationStore = defineStore(
  'ai-conversation',
  () => {
    // ── State
    const threads = ref<IAiConversationThread[]>([createThread()]);
    const activeThreadId = ref<string | null>(threads.value[0]?.id ?? null);

    // ── Getters
    const activeThread = computed<IAiConversationThread | null>(
      () => threads.value.find((thread) => thread.id === activeThreadId.value) ?? null,
    );

    const activeMessages = computed<IAiChatMessage[]>(() => activeThread.value?.messages ?? []);

    const historyThreads = computed<IAiConversationThread[]>(() =>
      threads.value.filter((thread) => thread.messages.length > 0),
    );

    const hasMessages = computed(() => activeMessages.value.length > 0);

    // ── Internal helpers

    /**
     * 提交线程状态。
     *
     * 性能不变量: threads 中每个线程对象始终处于'已 syncThreadMeta 归一化'状态
     * —— 初始 [createThread()] 已归一化, hydrate 经 normalizeHydratedThreads 归一化,
     * 之后每次 mutation 要么追加由 createThread() 生成的归一化线程, 要么仅对被改动
     * 的那条线程调用 syncThreadMeta(见 patchActiveThread / patchThread)。
     * 因此这里无需再对全部线程重跑 syncThreadMeta, 只做 trim + 选定 active,
     * 未改动线程保持原对象引用(结构共享)。
     */
    const replaceThreadsState = (nextState: IAiConversationPersistShape): void => {
      const trimmedThreads = trimThreads(nextState.threads, nextState.activeThreadId);
      const resolvedState = ensureActiveThread(nextState.activeThreadId, trimmedThreads);
      threads.value = resolvedState.threads;
      activeThreadId.value = resolvedState.activeThreadId;
    };

    /**
     * 把 updater 应用到当前 active thread;若不存在 active thread 则先创建一个。
     * (原实现用递归 self-call,改成显式串联以杜绝边界条件下的递归风险。)
     */
    const patchActiveThread = (
      updater: (thread: IAiConversationThread) => IAiConversationThread,
    ): void => {
      if (!activeThread.value) {
        const emptyThread = createThread();
        replaceThreadsState({
          activeThreadId: emptyThread.id,
          threads: [...threads.value, emptyThread],
        });
      }
      const currentThread = activeThread.value;
      if (!currentThread) {
        // 理论不可达 (ensureActiveThread 已保证存在);留一个静默 guard 兜底。
        return;
      }
      replaceThreadsState({
        activeThreadId: currentThread.id,
        threads: threads.value.map((thread) =>
          thread.id === currentThread.id ? syncThreadMeta(updater(thread)) : thread,
        ),
      });
    };

    const patchThread = (
      threadId: string,
      updater: (thread: IAiConversationThread) => IAiConversationThread,
    ): void => {
      if (!threads.value.some((thread) => thread.id === threadId)) return;
      replaceThreadsState({
        activeThreadId: activeThreadId.value,
        threads: threads.value.map((thread) =>
          thread.id === threadId ? syncThreadMeta(updater(thread)) : thread,
        ),
      });
    };

    // ── Actions: messages

    const appendMessage = (message: IAiChatMessage): void => {
      patchActiveThread((thread) => ({
        ...thread,
        messages: [...thread.messages, message],
      }));
    };

    const replaceMessages = (messages: IAiChatMessage[]): void => {
      patchActiveThread((thread) => ({
        ...thread,
        messages,
      }));
    };

    const replaceThreadMessages = (threadId: string, messages: IAiChatMessage[]): void => {
      // patchThread 已对变更线程统一调用 syncThreadMeta, 此处无需重复。
      patchThread(threadId, (thread) => ({
        ...thread,
        messages,
      }));
    };

    // ── Actions: thread lifecycle

    const switchThread = (threadId: string): void => {
      if (!threads.value.some((thread) => thread.id === threadId)) return;
      activeThreadId.value = threadId;
    };

    const startNewThread = (): void => {
      const nextThread = createThread();
      replaceThreadsState({
        activeThreadId: nextThread.id,
        threads: [...threads.value, nextThread],
      });
    };

    /**
     * 注: 语义是「删除当前 active thread 并新建一个空 thread 顶替」,
     * 不是「清空当前 thread 的消息」。 (与原实现一致, 此处保留以免破坏调用方。)
     */
    const clearActiveThread = (): void => {
      const currentThread = activeThread.value;
      if (!currentThread) {
        startNewThread();
        return;
      }
      const remainingThreads = threads.value.filter((thread) => thread.id !== currentThread.id);
      const nextThread = createThread();
      replaceThreadsState({
        activeThreadId: nextThread.id,
        threads: [...remainingThreads, nextThread],
      });
    };

    const updateThreadScrollState = (
      threadId: string,
      scrollState: IAiConversationScrollState,
    ): void => {
      patchThread(threadId, (thread) => ({
        ...thread,
        scrollState,
      }));
    };

    const deleteThread = (threadId: string): boolean => {
      if (!threads.value.some((thread) => thread.id === threadId)) {
        return false;
      }
      const remainingThreads = threads.value.filter((thread) => thread.id !== threadId);
      const nextActiveThreadId =
        activeThreadId.value === threadId
          ? (remainingThreads.at(-1)?.id ?? null)
          : activeThreadId.value;
      replaceThreadsState({
        activeThreadId: nextActiveThreadId,
        threads: remainingThreads,
      });
      return true;
    };

    // ── Actions: title generation

    const getThreadTitleStatus = (threadId: string): TAiConversationTitleStatus => {
      const thread = threads.value.find((item) => item.id === threadId);
      return thread?.titleStatus ?? 'temporary';
    };

    const getFirstRoundForTitle = (threadId: string): IAiConversationFirstRound | null => {
      const thread = threads.value.find((item) => item.id === threadId);
      return thread ? getFirstRoundFromMessages(thread.messages) : null;
    };

    const markThreadTitleGenerating = (threadId: string): void => {
      patchThread(threadId, (thread) => ({
        ...thread,
        titleStatus: thread.titleStatus === 'generated' ? 'generated' : 'generating',
      }));
    };

    const completeThreadTitleGeneration = (threadId: string, title: string): void => {
      const normalizedTitle = normalizeGeneratedTitle(title);
      patchThread(threadId, (thread) => {
        if (!normalizedTitle) {
          return {
            ...thread,
            titleStatus: 'failed',
          };
        }
        return {
          ...thread,
          title: normalizedTitle,
          titleStatus: 'generated',
        };
      });
    };

    const failThreadTitleGeneration = (threadId: string): void => {
      patchThread(threadId, (thread) => ({
        ...thread,
        titleStatus: thread.titleStatus === 'generated' ? 'generated' : 'failed',
      }));
    };

    return {
      // state
      activeThreadId,
      threads,
      // getters
      activeThread,
      activeMessages,
      historyThreads,
      hasMessages,
      // actions
      appendMessage,
      replaceMessages,
      replaceThreadMessages,
      switchThread,
      startNewThread,
      clearActiveThread,
      updateThreadScrollState,
      deleteThread,
      getThreadTitleStatus,
      getFirstRoundForTitle,
      markThreadTitleGenerating,
      completeThreadTitleGeneration,
      failThreadTitleGeneration,
    };
  },
  {
    persist: {
      key: 'shell-ide.ai-conversation',
      pick: ['activeThreadId', 'threads'],
      storage: getAiConversationPersistStorage(),
      afterHydrate(ctx) {
        const store = ctx.store as unknown as IAiConversationPersistShape & {
          activeMessages?: IAiChatMessage[];
        };

        // ── 当前版本快照
        const parsedCurrent = aiConversationPersistSchema.safeParse({
          activeThreadId: store.activeThreadId,
          threads: store.threads,
        });
        if (parsedCurrent.success) {
          // 边界 cast: parse 成功 → 运行时形状与 IAiConversationPersistShape 等价;
          // TS 看到的差异仅来自 IAiChatMessage 手写接口与 aiChatMessageSchema
          // 推断类型的字面量 union 命名漂移。
          const parsed = parsedCurrent.data as unknown as IAiConversationPersistShape;
          const normalized = ensureActiveThread(
            parsed.activeThreadId,
            normalizeHydratedThreads(parsed.threads, parsed.activeThreadId),
          );
          store.activeThreadId = normalized.activeThreadId;
          store.threads = normalized.threads;
          return;
        }

        // ── 旧版本快照 (单数组 activeMessages)
        const parsedLegacy = aiConversationLegacyPersistSchema.safeParse({
          activeMessages: store.activeMessages ?? [],
        });
        const migrated = parsedLegacy.success
          ? migrateLegacyMessages(parsedLegacy.data.activeMessages as unknown as IAiChatMessage[])
          : ensureActiveThread(null, []);
        store.activeThreadId = migrated.activeThreadId;
        store.threads = migrated.threads;
      },
    },
  },
);
