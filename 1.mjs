// fix-offscreen-runtime.mjs — fixes useAiAssistant.spec.ts #1857 (stream.runtimeEvents)
// and #2172 (off-screen thread writeback). Dry-run by default; pass --apply to write.
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

const edits = [
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    replacements: [
      // (1) import threadEntriesToMessages for off-screen writeback
      {
        find: `import { legacyThreadToThread, useAiThreadStore } from '@/store/aiThread';`,
        to: `import { legacyThreadToThread, threadEntriesToMessages, useAiThreadStore } from '@/store/aiThread';`,
      },
      // (2) commitDisplayMessagesToStore: never clobber a non-active (background) thread
      {
        find: `  const commitDisplayMessagesToStore = (
    threadId: string | null = unref(conversationStore.activeThreadId),
  ): void => {
    if (threadId) {
      conversationStore.replaceThreadMessages(threadId, displayMessages.value);
      return;
    }

    conversationStore.replaceMessages(displayMessages.value);
  };`,
        to: `  const commitDisplayMessagesToStore = (
    threadId: string | null = unref(conversationStore.activeThreadId),
  ): void => {
    // displayMessages 恒为「当前活动线程」的投影；回合线程已被切到后台时，绝不能用活动线程的显示缓冲
    // 覆盖该后台线程（否则清空后台会话）。后台线程的最终内容由 updateLiveThreadFromSidecarEvents
    // 经 reduce 直接写入其权威 entries。
    const activeThreadId = unref(conversationStore.activeThreadId);
    if (threadId && threadId !== activeThreadId) {
      return;
    }
    if (threadId) {
      conversationStore.replaceThreadMessages(threadId, displayMessages.value);
      return;
    }

    conversationStore.replaceMessages(displayMessages.value);
  };`,
      },
      // (3) updateLiveThreadFromSidecarEvents: resolve active OR background target thread to seed from
      {
        find: `    const activeThread = conversationStore.activeConversationThread;
    const activeThreadId = unref(conversationStore.activeThreadId);
    // 仅当该回合线程正是当前可见线程时才覆盖投影，避免串台到其它会话。
    if (!activeThread || (threadId !== null && threadId !== activeThreadId)) {
      return;
    }
    const seedThread = legacyThreadToThread({
      ...activeThread,
      messages: activeThread.messages.filter((message) => message.id !== assistantMessageId),
    });`,
        to: `    const activeThreadId = unref(conversationStore.activeThreadId);
    // 回合线程是否仍是当前可见线程：是则覆盖活动投影；否则该回合已被切到后台，仍需把本回合 reduce 态
    // 写回「发起会话」的权威 entries（避免回来后内容清空），但不改活动线程。
    const isActiveTarget = threadId === null || threadId === activeThreadId;
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
      },
      // (4) write enriched thread to active (overlay) OR background thread (replaceThreadMessages)
      {
        find: `    const enrichedThread = {
      ...liveThread,
      entries,
    };
    aiThreadStore.overlayStreamingActiveThread(enrichedThread);
  };`,
        to: `    const enrichedThread = {
      ...liveThread,
      entries,
    };
    if (isActiveTarget) {
      aiThreadStore.overlayStreamingActiveThread(enrichedThread);
    } else {
      // 后台（已切走）线程：经 replaceThreadMessages 写回其权威 entries，不触碰活动线程。
      conversationStore.replaceThreadMessages(
        targetLegacyThread.id,
        threadEntriesToMessages(enrichedThread.entries),
      );
    }
  };`,
      },
      // (5) finalize: merge live-only runtime events (e.g. agent.tool.started) into the final stream
      {
        find: `      runtimeEvents: compactRuntimeEvents(extractVisibleAgentRuntimeEvents(payload.events)),`,
        to: `      // payload.events 可能漏掉「仅经实时流到达」的 runtime agent 事件，收尾合并本回合累计的可见
      // runtime 时间线（已含实时 + payload 事件，按 id 去重）。
      runtimeEvents: compactRuntimeEvents(
        mergeRuntimeEvents(
          runtimeTimelineEvents.value,
          extractVisibleAgentRuntimeEvents(payload.events),
        ) ?? [],
      ),`,
      },
    ],
  },
];

let failed = false;
const plans = [];
for (const edit of edits) {
  const raw = readFileSync(edit.file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  for (const { find, to } of edit.replacements) {
    const count = text.split(find).length - 1;
    if (count !== 1) {
      console.error(`✗ ${edit.file}: expected exactly 1 match but found ${count} for:\n---\n${find}\n---`);
      failed = true;
      continue;
    }
    text = text.replace(find, to);
  }
  plans.push({ file: edit.file, crlf, out: crlf ? text.replace(/\n/g, '\r\n') : text });
}

if (failed) {
  console.error('\nAborted: no files written (atomic).');
  process.exit(1);
}
if (!APPLY) {
  console.log('Dry-run OK — all anchors matched exactly once. Re-run with --apply to write.');
  process.exit(0);
}
for (const p of plans) {
  writeFileSync(p.file, p.out, 'utf8');
  console.log(`✓ wrote ${p.file}`);
}
console.log('Done.');