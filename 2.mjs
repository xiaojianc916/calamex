import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function patchFile(relPath, edits) {
  const abs = resolve(ROOT, relPath);
  let text = readFileSync(abs, 'utf8');
  const usesCRLF = text.includes('\r\n');
  const toEol = (s) => (usesCRLF ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
  edits.forEach((edit, i) => {
    const find = toEol(edit.find);
    const count = text.split(find).length - 1;
    if (count !== 1) {
      throw new Error(`[${relPath}] 第 ${i + 1} 处编辑：期望 find 命中 1 次，实际命中 ${count} 次`);
    }
    text = text.replace(find, toEol(edit.replace));
    console.log(`[${relPath}] 第 ${i + 1} 处编辑：OK`);
  });
  writeFileSync(abs, text, 'utf8');
}

// ---- store：新增 overlayStreamingThread（按 id upsert、保持活动线程不变）----
patchFile('src/store/aiThread/index.ts', [
  {
    find: `  function overlayStreamingActiveThread(thread: IAiThread): void {
    const state = readAuthoritativeState();
    const exists = state.threads.some((item) => item.id === thread.id);
    const threads = exists
      ? state.threads.map((item) => (item.id === thread.id ? thread : item))
      : [thread, ...state.threads];
    commitAuthoritativeState(
      threadMutations.commitThreadsState({ threads, activeThreadId: thread.id }),
    );
  }`,
    replace: `  /**
   * 按 id upsert 一条流式线程：命中替换、未命中前插，经 commitThreadsState 归一。
   * activeThreadId 由调用方语义决定——活动回合指向本回合线程，后台回合保持当前活动线程。
   */
  function upsertStreamingThread(
    thread: IAiThread,
    resolveActiveThreadId: (state: threadMutations.IAiThreadState) => string | null,
  ): void {
    const state = readAuthoritativeState();
    const exists = state.threads.some((item) => item.id === thread.id);
    const threads = exists
      ? state.threads.map((item) => (item.id === thread.id ? thread : item))
      : [thread, ...state.threads];
    commitAuthoritativeState(
      threadMutations.commitThreadsState({ threads, activeThreadId: resolveActiveThreadId(state) }),
    );
  }

  /** 流式回合中以本回合权威 entries 覆盖单条活动线程并指向它（保留历史其余线程）。 */
  function overlayStreamingActiveThread(thread: IAiThread): void {
    upsertStreamingThread(thread, () => thread.id);
  }

  /** 后台（已切走）回合：按 id 覆盖其权威 entries，活动线程保持不变。 */
  function overlayStreamingThread(thread: IAiThread): void {
    upsertStreamingThread(thread, (state) => state.activeThreadId);
  }`,
  },
  {
    find: `    setLiveThread,
    setStreamingActiveThread,
    overlayStreamingActiveThread,`,
    replace: `    setLiveThread,
    setStreamingActiveThread,
    overlayStreamingActiveThread,
    overlayStreamingThread,`,
  },
]);

// ---- 编排器：seed 与写回改 entries-native，去掉两个 legacy 往返函数 ----
patchFile('src/composables/ai/useAiAssistant.ts', [
  {
    find: `import { legacyThreadToThread, threadEntriesToMessages, useAiThreadStore } from '@/store/aiThread';`,
    replace: `import { useAiThreadStore } from '@/store/aiThread';`,
  },
  {
    find: `import type { IAiThreadAssistantMessageEntry, IAiThreadEntry } from '@/types/ai/thread';`,
    replace: `import type { IAiThread, IAiThreadAssistantMessageEntry, IAiThreadEntry } from '@/types/ai/thread';`,
  },
  {
    find: `    const isActiveTarget = threadId === null || threadId === activeThreadId;
    const targetLegacyThread = isActiveTarget
      ? conversationStore.activeConversationThread
      : (conversationStore.conversationHistoryThreads.find((thread) => thread.id === threadId) ??
        null);
    if (!targetLegacyThread) {
      return;
    }
    const seedThread = legacyThreadToThread({
      ...targetLegacyThread,
      messages: targetLegacyThread.messages.filter((message) => message.id !== assistantMessageId),
    });`,
    replace: `    const isActiveTarget = threadId === null || threadId === activeThreadId;
    const targetThread = isActiveTarget
      ? aiThreadStore.authoritativeActiveThread
      : (aiThreadStore.authoritativeHistoryThreads.find((thread) => thread.id === threadId) ?? null);
    if (!targetThread) {
      return;
    }
    // entries 唯一真源：直接以权威 entries 为 seed，剔除本回合占位 assistant entry（buildLive 会重建），
    // 不再经 legacy 形状往返（threadToLegacyThread → legacyThreadToThread）。
    const seedThread: IAiThread = {
      ...targetThread,
      entries: targetThread.entries.filter((entry) => entry.id !== assistantMessageId),
    };`,
  },
  {
    find: `    } else {
      // 后台（已切走）线程：经 replaceThreadMessages 写回其权威 entries，不触碰活动线程。
      conversationStore.replaceThreadMessages(
        targetLegacyThread.id,
        threadEntriesToMessages(enrichedThread.entries),
      );
    }`,
    replace: `    } else {
      // 后台（已切走）线程：按 id 覆盖其权威 entries（不改活动线程），不再经 messages 往返。
      aiThreadStore.overlayStreamingThread(enrichedThread);
    }`,
  },
]);