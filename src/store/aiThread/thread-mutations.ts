/* ============================================================================
 * aiThread 权威写逻辑（纯函数核，ADR-0013 / ADR-0014 Step 8）
 *
 * 把 legacy aiConversation store 的线程管理语义（创建 / 标题派生与同步 / 裁剪 /
 * 生命周期 / 标题生成 / 滚动）等价搬运到 entries 模型，作为 entries 成为权威读写
 * 真源（Step 8 砖 3）的基础。本模块纯函数、无 Vue / pinia / IO 依赖，可在 Node
 * 单测独立运行；本步仅落地、未接线（store 仍由 legacy 权威），故零行为变化。
 *
 * 与 legacy 的唯一差异在「标题来源」：从扁平 messages 改为 entries —
 *   - 取首条 user_message 的文本块拼接为标题来源；
 *   - 退一步取首条含文本的 entry（含 assistant_message 正文 chunk）。
 * 其余阈值 / 裁剪 / active 末尾兜底与 legacy 严格一致。
 * ========================================================================== */
import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import { reduceThread } from '@/store/aiThread/reduce';
import type { IAiThread, IAiThreadContentBlock, IAiThreadEntry } from '@/types/ai/thread';
import { createUniqueId } from '@/utils/core/id';

export const AI_THREAD_HISTORY_LIMIT = 200;
const TEMPORARY_TITLE_MAX_CHARS = 24;
const GENERATED_TITLE_MAX_CHARS = 10;
export const SCROLL_STATE_SAVE_THROTTLE_MS = 120;

export type IAiThreadScrollState = NonNullable<IAiThread['scrollState']>;
export type TAiThreadTitleStatus = IAiThread['titleStatus'];

/** 权威线程状态：entries 模型下的 store 内部形状。 */
export interface IAiThreadState {
  threads: IAiThread[];
  activeThreadId: string | null;
}

export interface IAiThreadFirstRound {
  userMessage: string;
  assistantMessage: string;
}

const createThreadId = (): string => createUniqueId('ai-thread');

/* ----- text extraction --------------------------------------------------- */
const blocksText = (blocks: IAiThreadContentBlock[]): string =>
  blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');

const entryPlainText = (entry: IAiThreadEntry): string => {
  if (entry.type === 'user_message') {
    return blocksText(entry.content);
  }
  if (entry.type === 'assistant_message') {
    return entry.chunks
      .flatMap((chunk) =>
        chunk.type === 'message' && chunk.block.type === 'text' ? [chunk.block.text] : [],
      )
      .join('');
  }
  return '';
};

const lastEntryCreatedAt = (entries: IAiThreadEntry[]): string | null =>
  entries.at(-1)?.createdAt ?? null;

/* ----- title helpers (ported verbatim from legacy aiConversation) -------- */
const normalizeTitleSource = (value: string): string =>
  value.normalize('NFC').replace(/\s+/gu, ' ').trim();

const clipUnicodeText = (value: string, maxChars: number): string => {
  const characters = Array.from(value);
  if (characters.length <= maxChars) {
    return value;
  }
  return characters.slice(0, maxChars).join('') + '…';
};

export const deriveTemporaryThreadTitle = (entries: IAiThreadEntry[]): string => {
  let source = '';
  for (const entry of entries) {
    if (entry.type === 'user_message') {
      const text = blocksText(entry.content).trim();
      if (text) {
        source = text;
        break;
      }
    }
  }
  if (!source) {
    for (const entry of entries) {
      const text = entryPlainText(entry).trim();
      if (text) {
        source = text;
        break;
      }
    }
  }
  if (!source) {
    return '新对话';
  }
  return clipUnicodeText(normalizeTitleSource(source), TEMPORARY_TITLE_MAX_CHARS);
};

// 头尾各类引号 / 括号字符；命中即剥除（与 legacy 一致）。
const TITLE_TRIM_LEADING = /^["'“”‘’《》【】「」『』\s]+/gu;
const TITLE_TRIM_TRAILING = /["'“”‘’《》【】「」『』\s]+$/gu;

export const normalizeGeneratedTitle = (title: string): string => {
  const normalized = normalizeTitleSource(title)
    .replace(TITLE_TRIM_LEADING, '')
    .replace(TITLE_TRIM_TRAILING, '');
  return clipUnicodeText(normalized, GENERATED_TITLE_MAX_CHARS).replace(/…$/u, '');
};

/* ----- thread factory + meta sync ---------------------------------------- */
export const createThread = (
  entries: IAiThreadEntry[] = [],
  now: string = new Date().toISOString(),
): IAiThread => ({
  id: createThreadId(),
  title: deriveTemporaryThreadTitle(entries),
  titleStatus: 'temporary',
  createdAt: now,
  updatedAt: lastEntryCreatedAt(entries) ?? now,
  entries,
});

/**
 * 同步线程元信息：generated 标题再归一保持；否则由 entries 派生临时标题。
 * updatedAt 取末条 entry 的 createdAt（无 entry 则沿用原值）。
 */
export const syncThreadMeta = (thread: IAiThread): IAiThread => {
  const generatedTitle =
    thread.titleStatus === 'generated' ? normalizeGeneratedTitle(thread.title) : '';
  return {
    ...thread,
    title: generatedTitle || deriveTemporaryThreadTitle(thread.entries),
    titleStatus: generatedTitle ? 'generated' : thread.titleStatus,
    updatedAt: lastEntryCreatedAt(thread.entries) ?? thread.updatedAt,
  };
};

/* ----- trim + active resolution (ported from legacy) --------------------- */
export const trimThreads = (threads: IAiThread[], activeThreadId: string | null): IAiThread[] => {
  const activeThread = activeThreadId
    ? (threads.find((thread) => thread.id === activeThreadId) ?? null)
    : null;
  const trimmedNonEmptyThreads = threads
    .filter((thread) => thread.entries.length > 0)
    .slice(-AI_THREAD_HISTORY_LIMIT);
  // 始终保住当前 active：无论空白新会话还是因 slice 窗口落在最近 N 之外，
  // 都不能裁掉，否则静默丢失用户正在查看的会话（与 legacy 一致）。
  if (activeThread && !trimmedNonEmptyThreads.some((thread) => thread.id === activeThread.id)) {
    return [...trimmedNonEmptyThreads, activeThread];
  }
  return trimmedNonEmptyThreads;
};

/** active 必须指向现存线程；否则落到末尾线程（空库则新建空线程）。 */
export const ensureActiveThread = (
  activeThreadId: string | null,
  threads: IAiThread[],
): IAiThreadState => {
  if (threads.length === 0) {
    const emptyThread = createThread();
    return { activeThreadId: emptyThread.id, threads: [emptyThread] };
  }
  const resolvedActiveThreadId =
    activeThreadId && threads.some((thread) => thread.id === activeThreadId)
      ? activeThreadId
      : (threads.at(-1)?.id ?? null);
  return { activeThreadId: resolvedActiveThreadId, threads };
};

/**
 * 提交线程状态：仅当线程数超过历史上限时才 trim（与 legacy 性能不变量一致），
 * 再经 ensureActiveThread 归一 active。未改动线程保持原引用（结构共享）。
 */
export const commitThreadsState = (next: IAiThreadState): IAiThreadState => {
  const trimmedThreads =
    next.threads.length > AI_THREAD_HISTORY_LIMIT
      ? trimThreads(next.threads, next.activeThreadId)
      : next.threads;
  return ensureActiveThread(next.activeThreadId, trimmedThreads);
};

/* ----- patch helpers ----------------------------------------------------- */
export const patchActiveThread = (
  state: IAiThreadState,
  updater: (thread: IAiThread) => IAiThread,
): IAiThreadState => {
  let working = state;
  if (!working.threads.some((thread) => thread.id === working.activeThreadId)) {
    const emptyThread = createThread();
    working = commitThreadsState({
      activeThreadId: emptyThread.id,
      threads: [...working.threads, emptyThread],
    });
  }
  const currentId = working.activeThreadId;
  if (!currentId) {
    return working;
  }
  return commitThreadsState({
    activeThreadId: currentId,
    threads: working.threads.map((thread) =>
      thread.id === currentId ? syncThreadMeta(updater(thread)) : thread,
    ),
  });
};

export const patchThread = (
  state: IAiThreadState,
  threadId: string,
  updater: (thread: IAiThread) => IAiThread,
): IAiThreadState => {
  if (!state.threads.some((thread) => thread.id === threadId)) {
    return state;
  }
  return commitThreadsState({
    activeThreadId: state.activeThreadId,
    threads: state.threads.map((thread) =>
      thread.id === threadId ? syncThreadMeta(updater(thread)) : thread,
    ),
  });
};

/* ----- reduce-driven commit (流式写真源) --------------------------------- */
export const applyReduceEvent = (
  state: IAiThreadState,
  event: TAiThreadReduceEvent,
): IAiThreadState => patchActiveThread(state, (thread) => reduceThread(thread, event));

export const applyReduceEvents = (
  state: IAiThreadState,
  events: readonly TAiThreadReduceEvent[],
): IAiThreadState =>
  events.reduce<IAiThreadState>((acc, event) => applyReduceEvent(acc, event), state);

/* ----- thread lifecycle -------------------------------------------------- */
export const startNewThread = (state: IAiThreadState): IAiThreadState => {
  const nextThread = createThread();
  return commitThreadsState({
    activeThreadId: nextThread.id,
    threads: [...state.threads, nextThread],
  });
};

export const switchThread = (state: IAiThreadState, threadId: string): IAiThreadState =>
  state.threads.some((thread) => thread.id === threadId)
    ? { ...state, activeThreadId: threadId }
    : state;

/**
 * 删除当前 active thread 并以空 thread 顶替（语义同 legacy clearActiveThread：
 * 不是清空消息，而是丢弃当前线程换新）。
 */
export const clearActiveThread = (state: IAiThreadState): IAiThreadState => {
  const remainingThreads = state.activeThreadId
    ? state.threads.filter((thread) => thread.id !== state.activeThreadId)
    : state.threads.slice();
  const nextThread = createThread();
  return commitThreadsState({
    activeThreadId: nextThread.id,
    threads: [...remainingThreads, nextThread],
  });
};

export const deleteThread = (state: IAiThreadState, threadId: string): IAiThreadState => {
  if (!state.threads.some((thread) => thread.id === threadId)) {
    return state;
  }
  const remainingThreads = state.threads.filter((thread) => thread.id !== threadId);
  const nextActiveThreadId =
    state.activeThreadId === threadId
      ? (remainingThreads.at(-1)?.id ?? null)
      : state.activeThreadId;
  return commitThreadsState({ activeThreadId: nextActiveThreadId, threads: remainingThreads });
};

/* ----- title generation -------------------------------------------------- */
export function getFirstRoundFromEntries(entries: IAiThreadEntry[]): IAiThreadFirstRound | null {
  const firstUserIndex = entries.findIndex(
    (entry) => entry.type === 'user_message' && blocksText(entry.content).trim().length > 0,
  );
  if (firstUserIndex < 0) {
    return null;
  }
  const firstUser = entries[firstUserIndex];
  if (firstUser.type !== 'user_message') {
    return null;
  }
  let assistantMessage = '';
  for (let index = firstUserIndex + 1; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.type === 'assistant_message') {
      const text = entryPlainText(entry).trim();
      if (text) {
        assistantMessage = text;
        break;
      }
    }
  }
  if (!assistantMessage) {
    return null;
  }
  return {
    userMessage: normalizeTitleSource(blocksText(firstUser.content)),
    assistantMessage: normalizeTitleSource(assistantMessage),
  };
}

export const getThreadTitleStatus = (
  state: IAiThreadState,
  threadId: string,
): TAiThreadTitleStatus =>
  state.threads.find((thread) => thread.id === threadId)?.titleStatus ?? 'temporary';

export const getFirstRoundForTitle = (
  state: IAiThreadState,
  threadId: string,
): IAiThreadFirstRound | null => {
  const thread = state.threads.find((item) => item.id === threadId);
  return thread ? getFirstRoundFromEntries(thread.entries) : null;
};

export const markThreadTitleGenerating = (
  state: IAiThreadState,
  threadId: string,
): IAiThreadState =>
  patchThread(state, threadId, (thread) => ({
    ...thread,
    titleStatus: thread.titleStatus === 'generated' ? 'generated' : 'generating',
  }));

export const completeThreadTitleGeneration = (
  state: IAiThreadState,
  threadId: string,
  title: string,
): IAiThreadState => {
  const normalizedTitle = normalizeGeneratedTitle(title);
  return patchThread(state, threadId, (thread) =>
    normalizedTitle
      ? { ...thread, title: normalizedTitle, titleStatus: 'generated' }
      : { ...thread, titleStatus: 'failed' },
  );
};

export const failThreadTitleGeneration = (
  state: IAiThreadState,
  threadId: string,
): IAiThreadState =>
  patchThread(state, threadId, (thread) => ({
    ...thread,
    titleStatus: thread.titleStatus === 'generated' ? 'generated' : 'failed',
  }));

/* ----- scroll state ------------------------------------------------------ */
export const normalizeScrollStateForPersist = (
  scrollState: IAiThreadScrollState,
): IAiThreadScrollState => ({
  ...scrollState,
  scrollTop: Math.round(scrollState.scrollTop),
  scrollHeight: Math.round(scrollState.scrollHeight),
  clientHeight: Math.round(scrollState.clientHeight),
  distanceFromBottom: Math.round(scrollState.distanceFromBottom),
});

export const isSamePersistedScrollState = (
  left: IAiThreadScrollState | undefined,
  right: IAiThreadScrollState,
): boolean => {
  if (!left) {
    return false;
  }
  return (
    left.scrollTop === right.scrollTop &&
    left.scrollHeight === right.scrollHeight &&
    left.clientHeight === right.clientHeight &&
    left.distanceFromBottom === right.distanceFromBottom
  );
};

/** 写入归一化后的滚动状态；等价则短路返回原 state（去抖 / 节流留待 store 层）。 */
export const setThreadScrollState = (
  state: IAiThreadState,
  threadId: string,
  scrollState: IAiThreadScrollState,
): IAiThreadState => {
  const thread = state.threads.find((item) => item.id === threadId);
  if (!thread) {
    return state;
  }
  const normalizedScrollState = normalizeScrollStateForPersist(scrollState);
  if (isSamePersistedScrollState(thread.scrollState, normalizedScrollState)) {
    return state;
  }
  return patchThread(state, threadId, (item) => ({ ...item, scrollState: normalizedScrollState }));
};
