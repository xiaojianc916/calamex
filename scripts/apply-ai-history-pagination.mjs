#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const read = (path) => readFileSync(resolve(root, path), 'utf8');
const write = (path, text) => writeFileSync(resolve(root, path), text, 'utf8');

const fail = (path, message) => {
  throw new Error(`[${path}] ${message}`);
};

const replaceOnce = (path, oldText, newText, label) => {
  const text = read(path);
  const count = text.split(oldText).length - 1;
  if (count !== 1) {
    fail(path, `${label}: expected 1 match, got ${count}`);
  }
  write(path, text.replace(oldText, newText));
};

const insertAfterOnce = (path, anchor, insertion, label) => {
  const text = read(path);
  if (text.includes(insertion.trim())) return;
  const count = text.split(anchor).length - 1;
  if (count !== 1) {
    fail(path, `${label}: expected 1 anchor match, got ${count}`);
  }
  write(path, text.replace(anchor, `${anchor}${insertion}`));
};

const ensureContains = (path, needle, label) => {
  const text = read(path);
  if (!text.includes(needle)) {
    fail(path, `missing ${label}`);
  }
};

// ─────────────────────────────────────────────────────────────
// 1. Store：历史不再只保留 20 条，改为最多保留 200 条。
//    UI 仍然默认只显示 20 条。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/store/aiConversation.ts';

  replaceOnce(
    path,
    `export const AI_CONVERSATION_HISTORY_LIMIT = 20;`,
    `export const AI_CONVERSATION_HISTORY_LIMIT = 200;`,
    'raise persisted ai conversation history limit',
  );

  ensureContains(path, `export const AI_CONVERSATION_HISTORY_LIMIT = 200;`, 'history storage limit 200');
}

// ─────────────────────────────────────────────────────────────
// 2. Composable：历史面板分页，每页 20 条，滚动到底附近追加一页。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/composables/ai/useAiConversationHistory.ts';

  replaceOnce(
    path,
    `const MAX_HISTORY_THREADS = 20;`,
    `const HISTORY_PAGE_SIZE = 20;
const HISTORY_LOAD_MORE_THRESHOLD_PX = 64;`,
    'replace max history display limit with page size',
  );

  insertAfterOnce(
    path,
    `  const historyPopoverRef = ref<HTMLElement | null>(null);
`,
    `  const visibleHistoryLimit = ref(HISTORY_PAGE_SIZE);
`,
    'add visible history limit state',
  );

  replaceOnce(
    path,
    `  const historyThreads = computed(() =>
    [...assistant.historyThreads.value]
      .sort((first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt))
      .slice(0, MAX_HISTORY_THREADS),
  );`,
    `  const sortedHistoryThreads = computed(() =>
    [...assistant.historyThreads.value].sort(
      (first, second) => Date.parse(second.updatedAt) - Date.parse(first.updatedAt),
    ),
  );
  const historyThreads = computed(() =>
    sortedHistoryThreads.value.slice(0, visibleHistoryLimit.value),
  );
  const hasMoreHistoryThreads = computed(
    () => visibleHistoryLimit.value < sortedHistoryThreads.value.length,
  );`,
    'make history threads paginated',
  );

  insertAfterOnce(
    path,
    `  const getHistoryMessageCountLabel = (messages: IAiChatMessage[]): string =>
    \`\${messages.length} 条消息\`;

`,
    `  const resetHistoryPagination = (): void => {
    visibleHistoryLimit.value = HISTORY_PAGE_SIZE;
  };

  const loadMoreHistoryThreads = (): void => {
    if (!hasMoreHistoryThreads.value) return;
    visibleHistoryLimit.value = Math.min(
      visibleHistoryLimit.value + HISTORY_PAGE_SIZE,
      sortedHistoryThreads.value.length,
    );
  };

  const handleHistoryScroll = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;

    const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (distanceFromBottom <= HISTORY_LOAD_MORE_THRESHOLD_PX) {
      loadMoreHistoryThreads();
    }
  };

`,
    'add paginated scroll loader',
  );

  replaceOnce(
    path,
    `  const toggleHistoryPopover = (): void => {
    isHistoryOpen.value = !isHistoryOpen.value;
  };`,
    `  const toggleHistoryPopover = (): void => {
    const nextOpen = !isHistoryOpen.value;
    if (nextOpen) {
      resetHistoryPagination();
    }
    isHistoryOpen.value = nextOpen;
  };`,
    'reset history pagination when opening',
  );

  replaceOnce(
    path,
    `  const closeHistory = (): void => {
    isHistoryOpen.value = false;
  };`,
    `  const closeHistory = (): void => {
    isHistoryOpen.value = false;
    resetHistoryPagination();
  };`,
    'reset history pagination when closing',
  );

  replaceOnce(
    path,
    `    historyThreads,
    activeHistoryThread,`,
    `    historyThreads,
    hasMoreHistoryThreads,
    activeHistoryThread,`,
    'return has more history state',
  );

  replaceOnce(
    path,
    `    toggleHistoryPopover,
    closeHistory,`,
    `    toggleHistoryPopover,
    closeHistory,
    handleHistoryScroll,`,
    'return history scroll handler',
  );

  ensureContains(path, `const HISTORY_PAGE_SIZE = 20;`, 'history page size');
  ensureContains(path, `const hasMoreHistoryThreads = computed(`, 'hasMoreHistoryThreads');
  ensureContains(path, `const handleHistoryScroll = (event: Event): void => {`, 'handleHistoryScroll');
}

// ─────────────────────────────────────────────────────────────
// 3. AiAssistantPanel：历史面板绑定滚动加载，不新增可见滚动条。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/components/business/ai/shell/AiAssistantPanel.vue';

  replaceOnce(
    path,
    `  historyThreads,
  activeHistoryThread,`,
    `  historyThreads,
  hasMoreHistoryThreads,
  activeHistoryThread,`,
    'destructure hasMoreHistoryThreads',
  );

  replaceOnce(
    path,
    `  closeHistory,
  startNewConversation,`,
    `  closeHistory,
  handleHistoryScroll,
  startNewConversation,`,
    'destructure handleHistoryScroll',
  );

  replaceOnce(
    path,
    `          <div v-if="historyThreads.length" class="ai-history-scroll-area">`,
    `          <div v-if="historyThreads.length" class="ai-history-scroll-area" @scroll="handleHistoryScroll">`,
    'bind history scroll loader',
  );

  replaceOnce(
    path,
    `              </article>
            </div>
          </div>`,
    `              </article>
            </div>
            <div v-if="hasMoreHistoryThreads" class="ai-history-load-sentinel" aria-hidden="true"></div>
          </div>`,
    'add invisible history load sentinel',
  );

  insertAfterOnce(
    path,
    `.ai-history-list {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
}
`,
    `
.ai-history-load-sentinel {
  width: 100%;
  height: 1px;
  flex: 0 0 auto;
}
`,
    'add invisible history sentinel style',
  );

  ensureContains(path, `@scroll="handleHistoryScroll"`, 'history scroll binding');
  ensureContains(path, `class="ai-history-load-sentinel"`, 'history load sentinel');
}

// ─────────────────────────────────────────────────────────────
// 4. Store 测试：历史保留上限从 20 改为 200 后，测试跟随常量。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/store/aiConversation.store.spec.ts';

  replaceOnce(
    path,
    `  it('只保留最近 20 个会话', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    for (let index = 2; index <= 22; index += 1) {
      store.startNewThread();
      store.replaceMessages([createMessage(index)]);
    }
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-3');
    expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe('message-22');
  });`,
    `  it('只保留最近的会话存储上限', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    for (let index = 2; index <= AI_CONVERSATION_HISTORY_LIMIT + 2; index += 1) {
      store.startNewThread();
      store.replaceMessages([createMessage(index)]);
    }
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-3');
    expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe(
      \`message-\${AI_CONVERSATION_HISTORY_LIMIT + 2}\`,
    );
  });`,
    'update storage limit test',
  );

  replaceOnce(
    path,
    `  it('裁剪过期会话时会连同会话内全部图片预览一起移除', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createImageMessage(1)]);
    for (let index = 2; index <= 22; index += 1) {
      store.startNewThread();
      store.replaceMessages([createImageMessage(index)]);
    }
    const retainedPreviewSources = store.historyThreads.flatMap((thread) =>
      thread.messages.flatMap((message) =>
        message.references
          .map((reference) => reference.attachmentPreview?.src ?? null)
          .filter((src): src is string => src !== null),
      ),
    );
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(retainedPreviewSources).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT * 2);
    expect(retainedPreviewSources).not.toContain('data:image/png;base64,thread-1-image-1');
    expect(retainedPreviewSources).not.toContain('data:image/png;base64,thread-2-image-2');
    expect(retainedPreviewSources).toContain('data:image/png;base64,thread-3-image-1');
    expect(retainedPreviewSources).toContain('data:image/png;base64,thread-22-image-2');
  });`,
    `  it('裁剪过期会话时会连同会话内全部图片预览一起移除', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createImageMessage(1)]);
    for (let index = 2; index <= AI_CONVERSATION_HISTORY_LIMIT + 2; index += 1) {
      store.startNewThread();
      store.replaceMessages([createImageMessage(index)]);
    }
    const retainedPreviewSources = store.historyThreads.flatMap((thread) =>
      thread.messages.flatMap((message) =>
        message.references
          .map((reference) => reference.attachmentPreview?.src ?? null)
          .filter((src): src is string => src !== null),
      ),
    );
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(retainedPreviewSources).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT * 2);
    expect(retainedPreviewSources).not.toContain('data:image/png;base64,thread-1-image-1');
    expect(retainedPreviewSources).not.toContain('data:image/png;base64,thread-2-image-2');
    expect(retainedPreviewSources).toContain('data:image/png;base64,thread-3-image-1');
    expect(retainedPreviewSources).toContain(
      \`data:image/png;base64,thread-\${AI_CONVERSATION_HISTORY_LIMIT + 2}-image-2\`,
    );
  });`,
    'update image trimming test',
  );

  replaceOnce(
    path,
    `  it('当前空白新会话不占用 20 个历史会话名额', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    for (let index = 2; index <= 21; index += 1) {
      store.startNewThread();
      store.replaceMessages([createMessage(index)]);
    }
    store.startNewThread();
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(store.activeMessages).toHaveLength(0);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-2');
    expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe('message-21');
  });`,
    `  it('当前空白新会话不占用历史会话名额', () => {
    const store = useAiConversationStore();
    store.replaceMessages([createMessage(1)]);
    for (let index = 2; index <= AI_CONVERSATION_HISTORY_LIMIT; index += 1) {
      store.startNewThread();
      store.replaceMessages([createMessage(index)]);
    }
    store.startNewThread();
    expect(store.historyThreads).toHaveLength(AI_CONVERSATION_HISTORY_LIMIT);
    expect(store.activeMessages).toHaveLength(0);
    expect(store.historyThreads[0]?.messages[0]?.id).toBe('message-1');
    expect(store.historyThreads.at(-1)?.messages[0]?.id).toBe(
      \`message-\${AI_CONVERSATION_HISTORY_LIMIT}\`,
    );
  });`,
    'update empty active thread storage limit test',
  );
}

// ─────────────────────────────────────────────────────────────
// 5. Composable 测试：新增分页加载验证。
// ─────────────────────────────────────────────────────────────

{
  const path = 'src/composables/ai/useAiConversationHistory.spec.ts';

  replaceOnce(
    path,
    `  return {
    assistant,
    activeConversationId,`,
    `  return {
    assistant,
    historyThreads,
    activeConversationId,`,
    'expose historyThreads ref from assistant stub',
  );

  insertAfterOnce(
    path,
    `  it('按更新时间倒序排列历史', () => {
    const { assistant } = createAssistantStub();
    const history = withSetup(() => useAiConversationHistory(assistant));

    expect(history.historyThreads.value.map((thread) => thread.id)).toEqual(['b', 'c', 'a']);
  });

`,
    `  it('默认只渲染 20 条历史，滚动到底部附近每次追加 20 条', () => {
    const { assistant, historyThreads: sourceThreads } = createAssistantStub();
    sourceThreads.value = Array.from({ length: 45 }, (_, index) => {
      const id = \`thread-\${index + 1}\`;
      return createThread(
        id,
        new Date(Date.UTC(2026, 5, 1, 10, index, 0)).toISOString(),
        1,
      );
    });

    const history = withSetup(() => useAiConversationHistory(assistant));
    expect(history.historyThreads.value).toHaveLength(20);
    expect(history.hasMoreHistoryThreads.value).toBe(true);

    const scrollTarget = document.createElement('div');
    Object.defineProperties(scrollTarget, {
      scrollHeight: { value: 1000, configurable: true },
      clientHeight: { value: 400, configurable: true },
      scrollTop: { value: 600, configurable: true },
    });

    history.handleHistoryScroll({ currentTarget: scrollTarget } as unknown as Event);
    expect(history.historyThreads.value).toHaveLength(40);

    history.handleHistoryScroll({ currentTarget: scrollTarget } as unknown as Event);
    expect(history.historyThreads.value).toHaveLength(45);
    expect(history.hasMoreHistoryThreads.value).toBe(false);
  });

`,
    'add ai history pagination test',
  );
}

console.log('Applied AI history pagination.');
console.log('');
console.log('Touched:');
console.log(' - src/store/aiConversation.ts');
console.log(' - src/composables/ai/useAiConversationHistory.ts');
console.log(' - src/components/business/ai/shell/AiAssistantPanel.vue');
console.log(' - src/store/aiConversation.store.spec.ts');
console.log(' - src/composables/ai/useAiConversationHistory.spec.ts');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('');
console.log('Rollback:');
console.log('  git checkout -- src/store/aiConversation.ts src/composables/ai/useAiConversationHistory.ts src/components/business/ai/shell/AiAssistantPanel.vue src/store/aiConversation.store.spec.ts src/composables/ai/useAiConversationHistory.spec.ts');