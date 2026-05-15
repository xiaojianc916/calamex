import type { IAiChatMessage } from '@/types/ai';
import { aiChatMessageSchema } from '@/types/ai.schema';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { z } from 'zod';

export const AI_CONVERSATION_HISTORY_LIMIT = 20;
const TEMPORARY_TITLE_MAX_CHARS = 24;
const GENERATED_TITLE_MAX_CHARS = 10;

export type TAiConversationTitleStatus = 'temporary' | 'generating' | 'generated' | 'failed';

export interface IAiConversationFirstRound {
  userMessage: string;
  assistantMessage: string;
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

export interface IAiConversationScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distanceFromBottom: number;
  updatedAt: string;
}

const aiConversationTitleStatusSchema = z.enum([
  'temporary',
  'generating',
  'generated',
  'failed',
]);

const aiConversationThreadSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  titleStatus: aiConversationTitleStatusSchema.catch('temporary'),
  updatedAt: z.string().min(1),
  createdAt: z.string().min(1),
  messages: z.array(aiChatMessageSchema),
  scrollState: z.object({
    scrollTop: z.number().finite().nonnegative(),
    scrollHeight: z.number().finite().nonnegative(),
    clientHeight: z.number().finite().nonnegative(),
    distanceFromBottom: z.number().finite().nonnegative(),
    updatedAt: z.string().min(1),
  }).optional(),
});

const aiConversationPersistSchema = z.object({
  activeThreadId: z.string().min(1).nullable(),
  threads: z.array(aiConversationThreadSchema),
});

const legacyPersistSchema = z.object({
  activeMessages: z.array(aiChatMessageSchema),
});

type IAiConversationPersistShape = z.infer<typeof aiConversationPersistSchema>;

const createThreadId = (): string => `ai-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
  value
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .trim();

const clipUnicodeText = (value: string, maxChars: number): string => {
  const characters = Array.from(value);

  if (characters.length <= maxChars) {
    return value;
  }

  return `${characters.slice(0, maxChars).join('')}…`;
};

const deriveTemporaryConversationTitle = (messages: IAiChatMessage[]): string => {
  const firstUserMessage = messages.find((message) => message.role === 'user' && message.content.trim());
  const source = firstUserMessage?.content.trim() ?? messages[0]?.content.trim() ?? '';
  if (!source) return '新对话';
  return clipUnicodeText(normalizeTitleSource(source), TEMPORARY_TITLE_MAX_CHARS);
};

const normalizeGeneratedTitle = (title: string): string => {
  const normalized = normalizeTitleSource(title)
    .replace(/^["'“”‘’《》【】「」『』\s]+/gu, '')
    .replace(/["'“”‘’《》【】「」『』\s]+$/gu, '');

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
  const titleStatus = thread.titleStatus ?? 'temporary';
  const generatedTitle = titleStatus === 'generated'
    ? normalizeGeneratedTitle(thread.title)
    : '';

  return {
    ...thread,
    title: generatedTitle || deriveTemporaryConversationTitle(thread.messages),
    titleStatus: generatedTitle ? 'generated' : titleStatus,
    updatedAt: thread.messages.at(-1)?.createdAt ?? thread.updatedAt,
  };
};

const getFirstRoundFromMessages = (messages: IAiChatMessage[]): IAiConversationFirstRound | null => {
  const firstUserIndex = messages.findIndex((message) =>
    message.role === 'user' && message.content.trim().length > 0,
  );

  if (firstUserIndex < 0) {
    return null;
  }

  const firstUserMessage = messages[firstUserIndex];
  const firstAssistantMessage = messages.slice(firstUserIndex + 1).find((message) =>
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
    ? threads.find((thread) => thread.id === activeThreadId) ?? null
    : null;
  const trimmedNonEmptyThreads = threads
    .filter((thread) => thread.messages.length > 0)
    .slice(-AI_CONVERSATION_HISTORY_LIMIT);

  if (activeThread && activeThread.messages.length === 0) {
    return [...trimmedNonEmptyThreads, activeThread];
  }

  return trimmedNonEmptyThreads;
};

const normalizeThreads = (
  threads: IAiConversationThread[],
  activeThreadId: string | null,
): IAiConversationThread[] =>
  trimThreads(
    threads.map((thread) => syncThreadMeta(thread)),
    activeThreadId,
  );

const normalizeHydratedThreads = (
  threads: IAiConversationThread[],
  activeThreadId: string | null,
): IAiConversationThread[] =>
  trimThreads(
    threads.map((thread) => syncThreadMeta({
      ...thread,
      messages: normalizeMessages(thread.messages),
    })),
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

  const resolvedActiveThreadId = activeThreadId && threads.some((thread) => thread.id === activeThreadId)
    ? activeThreadId
    : threads.at(-1)?.id ?? null;

  return {
    activeThreadId: resolvedActiveThreadId,
    threads,
  };
};

export const useAiConversationStore = defineStore('ai-conversation', () => {
  const threads = ref<IAiConversationThread[]>([createThread()]);
  const activeThreadId = ref<string | null>(threads.value[0]?.id ?? null);

  const activeThread = computed<IAiConversationThread | null>(() =>
    threads.value.find((thread) => thread.id === activeThreadId.value) ?? null,
  );

  const activeMessages = computed<IAiChatMessage[]>(() => activeThread.value?.messages ?? []);
  const historyThreads = computed<IAiConversationThread[]>(() =>
    threads.value.filter((thread) => thread.messages.length > 0),
  );
  const hasMessages = computed(() => activeMessages.value.length > 0);

  const replaceThreadsState = (nextState: IAiConversationPersistShape): void => {
    const normalizedThreads = normalizeThreads(nextState.threads, nextState.activeThreadId);
    const resolvedState = ensureActiveThread(nextState.activeThreadId, normalizedThreads);
    threads.value = resolvedState.threads;
    activeThreadId.value = resolvedState.activeThreadId;
  };

  const patchActiveThread = (updater: (thread: IAiConversationThread) => IAiConversationThread): void => {
    const currentThread = activeThread.value;
    if (!currentThread) {
      const emptyThread = createThread();
      replaceThreadsState({
        activeThreadId: emptyThread.id,
        threads: [emptyThread],
      });
      return patchActiveThread(updater);
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
        thread.id === threadId ? updater(thread) : thread,
      ),
    });
  };

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
    patchThread(threadId, (thread) => ({
      ...syncThreadMeta({
        ...thread,
        messages,
      }),
    }));
  };

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
    const nextActiveThreadId = activeThreadId.value === threadId
      ? remainingThreads.at(-1)?.id ?? null
      : activeThreadId.value;

    replaceThreadsState({
      activeThreadId: nextActiveThreadId,
      threads: [...remainingThreads],
    });

    return true;
  };

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
    activeThreadId,
    threads,
    activeThread,
    activeMessages,
    historyThreads,
    hasMessages,
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
}, {
  persist: {
    key: 'shell-ide.ai-conversation',
    pick: ['activeThreadId', 'threads'],
    afterHydrate(ctx) {
      const store = ctx.store as unknown as IAiConversationPersistShape & { activeMessages?: IAiChatMessage[] };
      const parsedCurrent = aiConversationPersistSchema.safeParse({
        activeThreadId: store.activeThreadId,
        threads: store.threads,
      });
      if (parsedCurrent.success) {
        const normalized = ensureActiveThread(
          parsedCurrent.data.activeThreadId,
          normalizeHydratedThreads(parsedCurrent.data.threads, parsedCurrent.data.activeThreadId),
        );
        store.activeThreadId = normalized.activeThreadId;
        store.threads = normalized.threads;
        return;
      }

      const parsedLegacy = legacyPersistSchema.safeParse({
        activeMessages: store.activeMessages ?? [],
      });
      const migrated = parsedLegacy.success
        ? migrateLegacyMessages(parsedLegacy.data.activeMessages)
        : ensureActiveThread(null, []);
      store.activeThreadId = migrated.activeThreadId;
      store.threads = migrated.threads;
    },
  },
});
