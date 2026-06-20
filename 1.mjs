// 1.mjs — Step 8 Brick 2b: entries store gains authoritative read-write state + actions
// (delegating to thread-mutations pure core). PURE ADDITIONS, unwired, zero behavior change.
//   - augments  src/store/aiThread/index.ts
//   - creates   src/store/aiThread/index.authoritative.spec.ts
// Render authority (activeThread/activeEntries) and persistence (mirror) are untouched.
//
// Usage:
//   REPO_ROOT=D:\com.xiaojianc\my_desktop_app node 1.mjs           (apply)
//   REPO_ROOT=D:\com.xiaojianc\my_desktop_app node 1.mjs --check   (report only)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const CHECK = process.argv.includes('--check');

const INDEX_PATH = 'src/store/aiThread/index.ts';
const SPEC_PATH = 'src/store/aiThread/index.authoritative.spec.ts';

/* ---------------------------------------------------------------- helpers */
const abs = (rel) => join(REPO_ROOT, rel);

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n');
const toLf = (text) => text.replace(/\r\n/g, '\n');
const fromLf = (text, eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));

function replaceOnce(label, content, oldStr, newStr) {
	const occurrences = content.split(oldStr).length - 1;
	if (occurrences !== 1) {
		throw new Error(`[${label}] expected exactly 1 match, found ${occurrences}`);
	}
	// function replacement avoids `$`-pattern interpretation in newStr.
	return content.replace(oldStr, () => newStr);
}

function writeFileIdempotent(label, relPath, contents) {
	const target = abs(relPath);
	if (existsSync(target)) {
		const existing = toLf(readFileSync(target, 'utf8'));
		if (existing === toLf(contents)) {
			console.log(`[${label}] up-to-date (identical): ${relPath}`);
			return false;
		}
		throw new Error(`[${label}] file exists with different content: ${relPath}`);
	}
	if (CHECK) {
		console.log(`[${label}] would create: ${relPath}`);
		return true;
	}
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents, 'utf8');
	console.log(`[${label}] created: ${relPath}`);
	return true;
}

/* ------------------------------------------------------- index.ts: anchors */
const OLD_IMPORTS = String.raw`import { useAiConversationStore } from '@/store/aiConversation';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import { restoreAttachmentPreviewPointers } from '@/store/plugins/debouncedPersistStorage';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';`;

const NEW_IMPORTS = String.raw`import { useAiConversationStore } from '@/store/aiConversation';
import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import { legacyThreadToThread } from '@/store/aiThread/legacy-adapter';
import * as threadMutations from '@/store/aiThread/thread-mutations';
import { restoreAttachmentPreviewPointers } from '@/store/plugins/debouncedPersistStorage';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';`;

const FN_BLOCK = String.raw`  /** 切换活动持久化线程（触发指针惰性恢复 watch）。 */
  function setPersistedActiveThreadId(activeThreadId: string | null): void {
    persistedActiveThreadId.value = activeThreadId;
  }`;

const OLD_RETURN = String.raw`  return {
    // state
    liveThread,
    persistedThreads,
    persistedActiveThreadId,
    // getters
    projectedActiveThread,
    persistedActiveThread,
    activeThread,
    activeEntries,
    // actions
    setLiveThread,
    setPersistedThreads,
    setPersistedActiveThreadId,
  };`;

const AUTH_BLOCK = String.raw`  /* ====================================================================
   * Step 8 砖2b：entries 权威读写真源（thread-mutations 纯函数核之上的薄壳）
   *
   * 在既有「只读投影」之外，新增一组以 entries 为真源的权威线程状态 + 读写
   * actions，全部委托 thread-mutations 纯函数核。本步「只落地、未接线」：
   *   - 不改 activeThread / activeEntries 渲染权威（仍 liveThread ?? 投影 ?? 持久化）；
   *   - 不接管持久化（仍由 aiConversation + entriesMirror 负责）；
   *   - 无任何上层调用以下新 state / actions。
   * 故本步零行为变化；写路径 / 渲染权威 / 持久化归属切换统一在砖3 完成。
   *
   * 滚动节流（pendingScrollStates + timer）按 legacy aiConversation 的 store 层
   * 语义等价搬运到本层，使砖3 接线为纯连线、无行为漂移。
   * ================================================================== */

  // 初始权威状态：与 legacy 一致，启动即持有一个空线程（ensureActiveThread 兜底）。
  const initialAuthoritativeState = threadMutations.ensureActiveThread(null, []);
  const authoritativeThreads = ref<IAiThread[]>(initialAuthoritativeState.threads);
  const authoritativeActiveThreadId = ref<string | null>(initialAuthoritativeState.activeThreadId);

  const authoritativeActiveThread = computed<IAiThread | null>(
    () =>
      authoritativeThreads.value.find(
        (thread) => thread.id === authoritativeActiveThreadId.value,
      ) ?? null,
  );
  const authoritativeActiveEntries = computed<IAiThreadEntry[]>(
    () => authoritativeActiveThread.value?.entries ?? [],
  );
  const authoritativeHistoryThreads = computed<IAiThread[]>(() =>
    authoritativeThreads.value.filter((thread) => thread.entries.length > 0),
  );
  const authoritativeHasEntries = computed<boolean>(
    () => authoritativeActiveEntries.value.length > 0,
  );

  const readAuthoritativeState = (): threadMutations.IAiThreadState => ({
    threads: authoritativeThreads.value,
    activeThreadId: authoritativeActiveThreadId.value,
  });

  const commitAuthoritativeState = (next: threadMutations.IAiThreadState): void => {
    authoritativeThreads.value = next.threads;
    authoritativeActiveThreadId.value = next.activeThreadId;
  };

  /* ----- 滚动状态节流（等价搬运自 legacy aiConversation 的 store 层实现）----- */
  const pendingScrollStates = new Map<string, threadMutations.IAiThreadScrollState>();
  let scrollStateSaveTimer: ReturnType<typeof setTimeout> | null = null;

  const clearScrollStateSaveTimer = (): void => {
    if (scrollStateSaveTimer !== null) {
      clearTimeout(scrollStateSaveTimer);
      scrollStateSaveTimer = null;
    }
  };

  /**
   * flush 缓冲的滚动状态：纯核 setThreadScrollState 已内置归一化 + 等值短路，
   * 逐条折叠即得与 legacy 批量提交等价的最终状态。
   */
  function flushPendingScrollStateUpdates(): void {
    clearScrollStateSaveTimer();
    if (pendingScrollStates.size === 0) {
      return;
    }
    const updates = Array.from(pendingScrollStates.entries());
    pendingScrollStates.clear();
    const nextState = updates.reduce<threadMutations.IAiThreadState>(
      (state, [threadId, scrollState]) =>
        threadMutations.setThreadScrollState(state, threadId, scrollState),
      readAuthoritativeState(),
    );
    commitAuthoritativeState(nextState);
  }

  const scheduleScrollStateSave = (): void => {
    if (scrollStateSaveTimer !== null) {
      return;
    }
    scrollStateSaveTimer = setTimeout(() => {
      scrollStateSaveTimer = null;
      flushPendingScrollStateUpdates();
    }, threadMutations.SCROLL_STATE_SAVE_THROTTLE_MS);
  };

  /* ----- reduce 驱动写入（流式写真源）----- */
  function applyReduceEvent(event: TAiThreadReduceEvent): void {
    commitAuthoritativeState(threadMutations.applyReduceEvent(readAuthoritativeState(), event));
  }

  function applyReduceEvents(events: readonly TAiThreadReduceEvent[]): void {
    commitAuthoritativeState(threadMutations.applyReduceEvents(readAuthoritativeState(), events));
  }

  /* ----- 线程生命周期（切换/新建/清空/删除前 flush 滚动，与 legacy 一致）----- */
  function switchThread(threadId: string): void {
    if (!authoritativeThreads.value.some((thread) => thread.id === threadId)) {
      return;
    }
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.switchThread(readAuthoritativeState(), threadId));
  }

  function startNewThread(): void {
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.startNewThread(readAuthoritativeState()));
  }

  function clearActiveThread(): void {
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.clearActiveThread(readAuthoritativeState()));
  }

  function deleteThread(threadId: string): boolean {
    if (!authoritativeThreads.value.some((thread) => thread.id === threadId)) {
      return false;
    }
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.deleteThread(readAuthoritativeState(), threadId));
    return true;
  }

  function updateThreadScrollState(
    threadId: string,
    scrollState: threadMutations.IAiThreadScrollState,
  ): void {
    const thread = authoritativeThreads.value.find((item) => item.id === threadId);
    if (!thread) {
      return;
    }
    const normalizedScrollState = threadMutations.normalizeScrollStateForPersist(scrollState);
    const currentScrollState = pendingScrollStates.get(threadId) ?? thread.scrollState;
    if (threadMutations.isSamePersistedScrollState(currentScrollState, normalizedScrollState)) {
      return;
    }
    pendingScrollStates.set(threadId, normalizedScrollState);
    scheduleScrollStateSave();
  }

  /* ----- 标题生成 ----- */
  function getThreadTitleStatus(threadId: string): threadMutations.TAiThreadTitleStatus {
    return threadMutations.getThreadTitleStatus(readAuthoritativeState(), threadId);
  }

  function getFirstRoundForTitle(threadId: string): threadMutations.IAiThreadFirstRound | null {
    return threadMutations.getFirstRoundForTitle(readAuthoritativeState(), threadId);
  }

  function markThreadTitleGenerating(threadId: string): void {
    commitAuthoritativeState(
      threadMutations.markThreadTitleGenerating(readAuthoritativeState(), threadId),
    );
  }

  function completeThreadTitleGeneration(threadId: string, title: string): void {
    commitAuthoritativeState(
      threadMutations.completeThreadTitleGeneration(readAuthoritativeState(), threadId, title),
    );
  }

  function failThreadTitleGeneration(threadId: string): void {
    commitAuthoritativeState(
      threadMutations.failThreadTitleGeneration(readAuthoritativeState(), threadId),
    );
  }

  /**
   * 灌入权威线程快照（砖3 持久化归属切换时由读侧调用）。
   * 经 commitThreadsState 归一（trim + ensureActiveThread 兜底），空库自动建空线程。
   */
  function setAuthoritativeThreads(threads: IAiThread[], activeThreadId: string | null): void {
    flushPendingScrollStateUpdates();
    commitAuthoritativeState(threadMutations.commitThreadsState({ threads, activeThreadId }));
  }`;

const NEW_RETURN = String.raw`  return {
    // state
    liveThread,
    persistedThreads,
    persistedActiveThreadId,
    // Step 8 砖2b：entries 权威状态（未接线）
    authoritativeThreads,
    authoritativeActiveThreadId,
    // getters
    projectedActiveThread,
    persistedActiveThread,
    activeThread,
    activeEntries,
    // Step 8 砖2b：entries 权威读派生（未接线）
    authoritativeActiveThread,
    authoritativeActiveEntries,
    authoritativeHistoryThreads,
    authoritativeHasEntries,
    // actions
    setLiveThread,
    setPersistedThreads,
    setPersistedActiveThreadId,
    // Step 8 砖2b：entries 权威写 actions（未接线）
    applyReduceEvent,
    applyReduceEvents,
    switchThread,
    startNewThread,
    clearActiveThread,
    deleteThread,
    updateThreadScrollState,
    getThreadTitleStatus,
    getFirstRoundForTitle,
    markThreadTitleGenerating,
    completeThreadTitleGeneration,
    failThreadTitleGeneration,
    setAuthoritativeThreads,
    flushPendingScrollStateUpdates,
  };`;

const OLD_B = `${FN_BLOCK}\n\n${OLD_RETURN}`;
const NEW_B = `${FN_BLOCK}\n\n${AUTH_BLOCK}\n\n${NEW_RETURN}`;

/* -------------------------------------------------------- spec file (new) */
const SPEC_CONTENTS = String.raw`import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';

import { useAiThreadStore } from '@/store/aiThread';
import type { TAiThreadReduceEvent } from '@/store/aiThread/events';
import type { IAiThread, IAiThreadEntry } from '@/types/ai/thread';

const AT = '2026-01-01T00:00:00.000Z';

const userEntry = (id: string, text: string, createdAt: string = AT): IAiThreadEntry => ({
  type: 'user_message',
  id,
  createdAt,
  content: text ? [{ type: 'text', text }] : [],
  references: [],
});

const userEvent = (id: string, text: string, createdAt: string = AT): TAiThreadReduceEvent => ({
  kind: 'user_message',
  id,
  createdAt,
  blocks: [{ type: 'text', text }],
  references: [],
});

const scroll = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 1000,
  clientHeight: 500,
  distanceFromBottom: 0,
  updatedAt: AT,
});

describe('useAiThreadStore Step8砖2b 权威读写（未接线，零行为）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('初始权威状态持有一个空线程，且不影响既有渲染派生', () => {
    const store = useAiThreadStore();
    expect(store.authoritativeThreads).toHaveLength(1);
    expect(store.authoritativeActiveThreadId).toBe(store.authoritativeThreads[0].id);
    expect(store.authoritativeActiveEntries).toEqual([]);
    expect(store.authoritativeHasEntries).toBe(false);
    // 渲染权威仍走 legacy 投影，未被新状态影响。
    expect(store.activeEntries).toEqual([]);
  });

  it('applyReduceEvent 写入权威 active 线程，渲染派生 activeEntries 不受影响', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'first question'));
    expect(store.authoritativeActiveEntries).toHaveLength(1);
    expect(store.authoritativeActiveEntries[0].type).toBe('user_message');
    const active = store.authoritativeThreads.find(
      (thread) => thread.id === store.authoritativeActiveThreadId,
    );
    expect(active?.title).toBe('first question');
    // 关键零行为断言：未接线，渲染权威 activeEntries 仍为空。
    expect(store.activeEntries).toEqual([]);
  });

  it('startNewThread / switchThread 管理权威线程', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    const firstId = store.authoritativeActiveThreadId as string;
    store.startNewThread();
    expect(store.authoritativeThreads).toHaveLength(2);
    expect(store.authoritativeActiveThreadId).not.toBe(firstId);
    store.switchThread(firstId);
    expect(store.authoritativeActiveThreadId).toBe(firstId);
    store.switchThread('missing');
    expect(store.authoritativeActiveThreadId).toBe(firstId);
  });

  it('deleteThread 命中返回 true 并移除，未命中返回 false', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    store.startNewThread();
    const ids = store.authoritativeThreads.map((thread) => thread.id);
    expect(store.deleteThread(ids[0])).toBe(true);
    expect(store.authoritativeThreads.some((thread) => thread.id === ids[0])).toBe(false);
    expect(store.deleteThread('missing')).toBe(false);
  });

  it('clearActiveThread 丢弃当前 active 换空线程', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    const before = store.authoritativeActiveThreadId;
    store.clearActiveThread();
    expect(store.authoritativeActiveThreadId).not.toBe(before);
    expect(store.authoritativeActiveEntries).toEqual([]);
    expect(store.authoritativeThreads.some((thread) => thread.id === before)).toBe(false);
  });

  it('滚动状态节流：updateThreadScrollState 缓冲，flush 后写入归一整数', () => {
    const store = useAiThreadStore();
    const threadId = store.authoritativeActiveThreadId as string;
    store.updateThreadScrollState(threadId, scroll(12.7));
    const beforeFlush = store.authoritativeThreads.find((thread) => thread.id === threadId);
    expect(beforeFlush?.scrollState).toBeUndefined();
    store.flushPendingScrollStateUpdates();
    const afterFlush = store.authoritativeThreads.find((thread) => thread.id === threadId);
    expect(afterFlush?.scrollState?.scrollTop).toBe(13);
  });

  it('标题生成：generating -> generated，且 generated 不被 failed 回退', () => {
    const store = useAiThreadStore();
    store.applyReduceEvent(userEvent('m1', 'q'));
    const threadId = store.authoritativeActiveThreadId as string;
    store.markThreadTitleGenerating(threadId);
    expect(store.getThreadTitleStatus(threadId)).toBe('generating');
    store.completeThreadTitleGeneration(threadId, '  新标题  ');
    expect(store.getThreadTitleStatus(threadId)).toBe('generated');
    store.failThreadTitleGeneration(threadId);
    expect(store.getThreadTitleStatus(threadId)).toBe('generated');
  });

  it('setAuthoritativeThreads + getFirstRoundForTitle 取首轮问答', () => {
    const store = useAiThreadStore();
    const thread: IAiThread = {
      id: 'seed',
      title: 'seed',
      titleStatus: 'temporary',
      createdAt: AT,
      updatedAt: AT,
      entries: [
        userEntry('u', 'question'),
        {
          type: 'assistant_message',
          id: 'a',
          createdAt: AT,
          chunks: [{ type: 'message', block: { type: 'text', text: 'answer' } }],
        },
      ],
    };
    store.setAuthoritativeThreads([thread], 'seed');
    expect(store.getFirstRoundForTitle('seed')).toEqual({
      userMessage: 'question',
      assistantMessage: 'answer',
    });
  });
});
`;

/* --------------------------------------------------------------- run it */
function patchIndex() {
	const target = abs(INDEX_PATH);
	if (!existsSync(target)) {
		throw new Error(`missing file: ${INDEX_PATH}`);
	}
	const raw = readFileSync(target, 'utf8');
	const eol = detectEol(raw);
	let content = toLf(raw);

	if (content.includes('authoritativeThreads')) {
		console.log(`[index] already applied (found authoritativeThreads): ${INDEX_PATH}`);
		return false;
	}

	content = replaceOnce('index/imports', content, OLD_IMPORTS, NEW_IMPORTS);
	content = replaceOnce('index/body', content, OLD_B, NEW_B);

	// post-assertions
	for (const needle of [
		`import * as threadMutations from '@/store/aiThread/thread-mutations';`,
		'function applyReduceEvent(',
		'function setAuthoritativeThreads(',
		'flushPendingScrollStateUpdates,',
	]) {
		if (!content.includes(needle)) {
			throw new Error(`[index] post-assert failed, missing: ${needle}`);
		}
	}

	if (CHECK) {
		console.log(`[index] would patch: ${INDEX_PATH}`);
		return true;
	}
	writeFileSync(target, fromLf(content, eol), 'utf8');
	console.log(`[index] patched: ${INDEX_PATH}`);
	return true;
}

patchIndex();
writeFileIdempotent('spec', SPEC_PATH, SPEC_CONTENTS);

console.log(CHECK ? 'check complete (no writes).' : 'Brick 2b applied.');