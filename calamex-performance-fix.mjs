#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const read = (file) => readFileSync(join(root, file), 'utf8');
const write = (file, content) => writeFileSync(join(root, file), content, 'utf8');

const replaceOnce = (file, source, target, label) => {
  const content = read(file);
  const count = content.split(source).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: ${label} expected 1 match, got ${count}`);
  }
  write(file, content.replace(source, target));
  console.log(`updated ${file}: ${label}`);
};

const insertOnce = (file, anchor, insertion, label) => {
  const content = read(file);
  if (content.includes(insertion.trim())) {
    console.log(`skipped ${file}: ${label} already applied`);
    return;
  }
  const count = content.split(anchor).length - 1;
  if (count !== 1) {
    throw new Error(`${file}: ${label} expected 1 anchor, got ${count}`);
  }
  write(file, content.replace(anchor, `${anchor}${insertion}`));
  console.log(`updated ${file}: ${label}`);
};

// 1) AI 会话持久化：没有新 base64 图片时，跳过 JSON.parse + 全量深遍历。
//    这不改变持久化格式；只有 payload 中真的含 data:image/ 时才走原有抽取逻辑。
const persistFile = 'src/store/plugins/debouncedPersistStorage.ts';
insertOnce(
  persistFile,
  "const ATTACHMENT_PREVIEW_KEY_PREFIX = 'ai-conversation-attachment-preview:';\n",
  "const DATA_IMAGE_URL_MARKER = 'data:image/';\n",
  'add data image marker fast path constant',
);

replaceOnce(
  persistFile,
  `const preparePersistValue = async (value: string): Promise<string> => {
  try {
    const parsed: unknown = JSON.parse(value);
    await extractAttachmentPreviewPayloads(parsed);

    return JSON.stringify(parsed);
  } catch (error) {
    logWarn('ai-conversation-attachment-preview-extract-failed', stringifyError(error));
    return value;
  }
};
`,
  `const preparePersistValue = async (value: string): Promise<string> => {
  // Fast path: most conversation writes are text/scroll/status updates. If no fresh
  // inline image payload exists, avoid parsing and recursively walking the whole
  // conversation snapshot on every debounced persist. Existing idb:// pointers do
  // not need re-extraction.
  if (!value.includes(DATA_IMAGE_URL_MARKER)) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    await extractAttachmentPreviewPayloads(parsed);

    return JSON.stringify(parsed);
  } catch (error) {
    logWarn('ai-conversation-attachment-preview-extract-failed', stringifyError(error));
    return value;
  }
};
`,
  'skip attachment extraction when no inline image exists',
);

replaceOnce(
  persistFile,
  `const restorePersistValue = async (value: string | null): Promise<string | null> => {
  if (value === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
`,
  `const restorePersistValue = async (value: string | null): Promise<string | null> => {
  if (value === null) {
    return null;
  }

  // Fast path: if the snapshot has no attachment-preview pointer, there is nothing
  // to restore here. The store's Zod hydrate still validates the unchanged JSON.
  if (!value.includes(ATTACHMENT_PREVIEW_POINTER_PREFIX)) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
`,
  'skip attachment restore parse when no pointer exists',
);

// 2) AI 会话滚动状态：滚动事件只影响“恢复位置”，不应让每个滚动帧都触发
//    threads 全量 map + Pinia persist 序列化。按 120ms 合并、取最新值，并做像素级去重。
const aiConversationFile = 'src/store/aiConversation.ts';
insertOnce(
  aiConversationFile,
  'const GENERATED_TITLE_MAX_CHARS = 10;\n',
  'const SCROLL_STATE_SAVE_THROTTLE_MS = 120;\n',
  'add scroll-state throttle constant',
);

insertOnce(
  aiConversationFile,
  `    const replaceThreadsState = (nextState: IAiConversationPersistShape): void => {
      const trimmedThreads = trimThreads(nextState.threads, nextState.activeThreadId);
      const resolvedState = ensureActiveThread(nextState.activeThreadId, trimmedThreads);
      threads.value = resolvedState.threads;
      activeThreadId.value = resolvedState.activeThreadId;
    };
`,
  `
    const normalizeScrollStateForPersist = (
      scrollState: IAiConversationScrollState,
    ): IAiConversationScrollState => ({
      ...scrollState,
      scrollTop: Math.round(scrollState.scrollTop),
      scrollHeight: Math.round(scrollState.scrollHeight),
      clientHeight: Math.round(scrollState.clientHeight),
      distanceFromBottom: Math.round(scrollState.distanceFromBottom),
    });

    const isSamePersistedScrollState = (
      left: IAiConversationScrollState | undefined,
      right: IAiConversationScrollState,
    ): boolean =>
      Boolean(left) &&
      left.scrollTop === right.scrollTop &&
      left.scrollHeight === right.scrollHeight &&
      left.clientHeight === right.clientHeight &&
      left.distanceFromBottom === right.distanceFromBottom;

    const pendingScrollStates = new Map<string, IAiConversationScrollState>();
    let scrollStateSaveTimer: ReturnType<typeof setTimeout> | null = null;

    const clearScrollStateSaveTimer = (): void => {
      if (scrollStateSaveTimer !== null) {
        clearTimeout(scrollStateSaveTimer);
        scrollStateSaveTimer = null;
      }
    };

    const flushPendingScrollStateUpdates = (): void => {
      clearScrollStateSaveTimer();
      if (pendingScrollStates.size === 0) {
        return;
      }

      const updates = new Map(pendingScrollStates);
      pendingScrollStates.clear();
      let changed = false;
      const nextThreads = threads.value.map((thread) => {
        const nextScrollState = updates.get(thread.id);
        if (!nextScrollState || isSamePersistedScrollState(thread.scrollState, nextScrollState)) {
          return thread;
        }
        changed = true;
        return syncThreadMeta({
          ...thread,
          scrollState: nextScrollState,
        });
      });

      if (!changed) {
        return;
      }

      replaceThreadsState({
        activeThreadId: activeThreadId.value,
        threads: nextThreads,
      });
    };

    const scheduleScrollStateSave = (): void => {
      if (scrollStateSaveTimer !== null) {
        return;
      }
      scrollStateSaveTimer = setTimeout(() => {
        scrollStateSaveTimer = null;
        flushPendingScrollStateUpdates();
      }, SCROLL_STATE_SAVE_THROTTLE_MS);
    };
`,
  'add throttled scroll-state flush helpers',
);

replaceOnce(
  aiConversationFile,
  `    const switchThread = (threadId: string): void => {
      if (!threads.value.some((thread) => thread.id === threadId)) return;
      activeThreadId.value = threadId;
      resolveThreadAttachmentPreviews(threadId);
    };
`,
  `    const switchThread = (threadId: string): void => {
      if (!threads.value.some((thread) => thread.id === threadId)) return;
      flushPendingScrollStateUpdates();
      activeThreadId.value = threadId;
      resolveThreadAttachmentPreviews(threadId);
    };
`,
  'flush pending scroll state before switching threads',
);

replaceOnce(
  aiConversationFile,
  `    const startNewThread = (): void => {
      const nextThread = createThread();
      replaceThreadsState({
        activeThreadId: nextThread.id,
        threads: [...threads.value, nextThread],
      });
    };
`,
  `    const startNewThread = (): void => {
      flushPendingScrollStateUpdates();
      const nextThread = createThread();
      replaceThreadsState({
        activeThreadId: nextThread.id,
        threads: [...threads.value, nextThread],
      });
    };
`,
  'flush pending scroll state before starting new thread',
);

replaceOnce(
  aiConversationFile,
  `    const clearActiveThread = (): void => {
      const currentThread = activeThread.value;
`,
  `    const clearActiveThread = (): void => {
      flushPendingScrollStateUpdates();
      const currentThread = activeThread.value;
`,
  'flush pending scroll state before clearing active thread',
);

replaceOnce(
  aiConversationFile,
  `    const updateThreadScrollState = (
      threadId: string,
      scrollState: IAiConversationScrollState,
    ): void => {
      patchThread(threadId, (thread) => ({
        ...thread,
        scrollState,
      }));
    };
`,
  `    const updateThreadScrollState = (
      threadId: string,
      scrollState: IAiConversationScrollState,
    ): void => {
      const thread = threads.value.find((item) => item.id === threadId);
      if (!thread) return;

      const normalizedScrollState = normalizeScrollStateForPersist(scrollState);
      const currentScrollState = pendingScrollStates.get(threadId) ?? thread.scrollState;
      if (isSamePersistedScrollState(currentScrollState, normalizedScrollState)) {
        return;
      }

      pendingScrollStates.set(threadId, normalizedScrollState);
      scheduleScrollStateSave();
    };
`,
  'throttle and dedupe thread scroll-state writes',
);

replaceOnce(
  aiConversationFile,
  `    const deleteThread = (threadId: string): boolean => {
      if (!threads.value.some((thread) => thread.id === threadId)) {
        return false;
      }
`,
  `    const deleteThread = (threadId: string): boolean => {
      flushPendingScrollStateUpdates();
      if (!threads.value.some((thread) => thread.id === threadId)) {
        return false;
      }
`,
  'flush pending scroll state before deleting thread',
);

console.log('\nPerformance patch script completed. No backup files were created.');