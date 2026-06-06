import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { IAiChatMessage } from '@/types/ai';
import {
  aiChatMessageSchema,
  aiConversationLegacyPersistSchema,
  aiConversationPersistSchema,
  aiConversationThreadSchema,
} from '@/types/ai/conversation.schema';
import { createUniqueId } from '@/utils/id';
import {
  getAiConversationPersistStorage,
  restoreAttachmentPreviewPointers,
} from './plugins/debouncedPersistStorage';

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
const createThreadId = (): string => createUniqueId('ai-thread');

/**
 * 归一化一条 hydrate 出来的消息。
 *
 * 上一次会话在流式进行中被整体退出 → 重启 hydrate 时已无法继续该流。这里把它
 * 收尾为 'cancelled' 终态(与既有消费方语义兼容: getFirstRoundFromMessages 等
 * 已把 cancelled 视为不可用作回答), 并打上 interrupted 标记, 使 UI 能把它与
 * 用户主动停止区分开, 呈现为"运行被异常终止"。非流式消息原样返回。
 *
 * 导出以便单测(与 salvageHydratedThreads 同惯例)。
 */
export const normalizeHydratedMessage = (message: IAiChatMessage): IAiChatMessage => {
  if (message.stream?.status !== 'streaming') return message;
  return {
    ...message,
    stream: {
      ...message.stream,
      status: 'cancelled',
      interrupted: true,
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

  // 始终保住当前 active 线程: 无论它是空白新会话, 还是非空但因 slice 窗口
  // (例如 hydrate 到超过 LIMIT 条的历史时)落在最近 N 个之外, 都不能被裁掉,
  // 否则会静默丢失用户正在查看的会话并把 active 重置到最新线程。
  // (空白-active 行为向后兼容: 空线程本就不在 non-empty 结果中, 同样被追加。)
  if (activeThread && !trimmedNonEmptyThreads.some((thread) => thread.id === activeThread.id)) {
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

/**
 * 逐线程 / 逐消息救援 hydrate 快照。
 *
 * 动机: aiConversationPersistSchema 用 z.array(aiChatMessageSchema) 做全有或全无
 * 校验 —— 任一线程内任一条消息不合法(典型如版本升级后消息结构漂移、流式中断
 * 写入异常态、token 字段越界等), 整库 parse 失败, 旧逻辑随即落到
 * ensureActiveThread(null, []) 用空白线程把全部历史顶替清空。本函数改为尽量救援:
 * - 单条消息不合法 → 仅丢弃该消息, 保留同线程其余消息;
 * - 线程元信息(id/title/时间戳)不合法 → 丢弃该线程, 保留其余线程;
 * - 至少救回一个线程即返回; 全部不可救援才返回 null(交回 legacy/兜底)。
 *
 * 仅在严格 parse 失败后作为兜底调用, parse 成功路径行为不变。
 */
export const salvageHydratedThreads = (
  rawThreads: unknown,
  rawActiveThreadId: unknown,
): IAiConversationPersistShape | null => {
  if (!Array.isArray(rawThreads)) {
    return null;
  }
  const threads = rawThreads.flatMap((rawThread): IAiConversationThread[] => {
    if (typeof rawThread !== 'object' || rawThread === null) {
      return [];
    }
    const candidate = rawThread as Record<string, unknown>;
    const rawMessages = Array.isArray(candidate.messages) ? candidate.messages : [];
    // 逐条救援: 保留可通过校验的消息, 丢弃异常单条, 避免一条坏数据牵连整线程。
    const messages = rawMessages.flatMap((rawMessage) => {
      const parsedMessage = aiChatMessageSchema.safeParse(rawMessage);
      return parsedMessage.success ? [parsedMessage.data] : [];
    });
    // 用线程 schema 校验元信息; messages 已替换为救援后的合法集合。
    const parsedThread = aiConversationThreadSchema.safeParse({
      ...candidate,
      messages,
    });
    return parsedThread.success ? [parsedThread.data as unknown as IAiConversationThread] : [];
  });
  if (threads.length === 0) {
    return null;
  }
  const activeThreadId =
    typeof rawActiveThreadId === 'string' && rawActiveThreadId.trim().length > 0
      ? rawActiveThreadId
      : null;
  return {
    activeThreadId,
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

    // ── 懒加载：历史线程图片按需解析
    //
    // hydrate 时只有 active 线程的图片被回填成 base64（见 debouncedPersistStorage 的
    // restorePersistValue），其余历史线程的 attachmentPreview.src 仍是 `idb://` 指针。
    // 这里在某线程被激活时按需把它的指针解析回 base64，从而避免启动时一次性加载所有会话的图片。
    /** 已在解析中的线程，避免同一线程并发重复解析。 */
    const resolvingThreadIds = new Set<string>();
    const threadHasAttachmentPreviewPointer = (messages: IAiChatMessage[]): boolean =>
      messages.some((message) =>
        message.references.some((reference) =>
          Boolean(reference.attachmentPreview?.src?.startsWith('idb://')),
        ),
      );
    const resolveThreadAttachmentPreviews = (threadId: string | null): void => {
      if (!threadId || resolvingThreadIds.has(threadId)) return;
      const thread = threads.value.find((item) => item.id === threadId);
      if (!thread || !threadHasAttachmentPreviewPointer(thread.messages)) return;
      const targetMessages = thread.messages;
      resolvingThreadIds.add(threadId);
      void restoreAttachmentPreviewPointers(targetMessages)
        .then(({ changed, value }) => {
          if (!changed) return;
          const current = threads.value.find((item) => item.id === threadId);
          // 仅当该线程消息引用在解析期间未被其它操作替换时才回填，避免覆盖更新内容。
          if (current && current.messages === targetMessages) {
            replaceThreadMessages(threadId, value);
          }
        })
        .catch(() => {
          // 解析失败：保留指针，下次激活再试（不影响文本与历史列表）。
        })
        .finally(() => {
          resolvingThreadIds.delete(threadId);
        });
    };

    /** 解析当前 active 线程的图片指针（hydrate 后兜底，及外部主动触发）。 */
    const ensureActiveThreadAttachmentPreviewsResolved = (): void => {
      resolveThreadAttachmentPreviews(activeThreadId.value);
    };

    // ── Actions: thread lifecycle
    const switchThread = (threadId: string): void => {
      if (!threads.value.some((thread) => thread.id === threadId)) return;
      activeThreadId.value = threadId;
      resolveThreadAttachmentPreviews(threadId);
    };

    const startNewThread = (): void => {
      const nextThread = createThread();
      replaceThreadsState({
        activeThreadId: nextThread.id,
        threads: [...threads.value, nextThread],
      });
    };

    /**
     * 注: 语义是《删除当前 active thread 并新建一个空 thread 顶替》,
     * 不是《清空当前 thread 的消息》。 (与原实现一致, 此处保留以免破坏调用方。)
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
      ensureActiveThreadAttachmentPreviewsResolved,
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
          ensureActiveThreadAttachmentPreviewsResolved?: () => void;
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
          store.ensureActiveThreadAttachmentPreviewsResolved?.();
          return;
        }

        // ── 当前版本快照部分损坏: 逐线程/逐消息救援, 绝不因单条坏数据清空整库。
        // 仅救援掉无法解析的单条消息/单个线程, 至少留下一个线程即沿用救援结果。
        const salvaged = salvageHydratedThreads(store.threads, store.activeThreadId);
        if (salvaged) {
          const normalized = ensureActiveThread(
            salvaged.activeThreadId,
            normalizeHydratedThreads(salvaged.threads, salvaged.activeThreadId),
          );
          store.activeThreadId = normalized.activeThreadId;
          store.threads = normalized.threads;
          store.ensureActiveThreadAttachmentPreviewsResolved?.();
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
