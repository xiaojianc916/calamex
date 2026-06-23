import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function patchFile(relPath, edits) {
  const abs = resolve(ROOT, relPath);
  let text = readFileSync(abs, 'utf8');
  const eol = detectEol(text);
  for (let i = 0; i < edits.length; i += 1) {
    const find = edits[i].find.split('\n').join(eol);
    const replace = edits[i].replace.split('\n').join(eol);
    const count = text.split(find).length - 1;
    if (count !== 1) {
      throw new Error('[' + relPath + '] edit ' + (i + 1) + ': expected 1 match, got ' + count);
    }
    text = text.replace(find, replace);
  }
  writeFileSync(abs, text, 'utf8');
  console.log('OK ' + relPath);
}

// --- 1) store：新增 entries-native 写原语（即用，非死代码/兼容层）-----------
patchFile('src/store/aiThread/index.ts', [
  {
    find: `  function replaceMessages(messages: IAiChatMessage[]): void {`,
    replace: `  /**
   * Entries-native 写真源：以 updater 直接变换活动线程 entries 并提交（经 patchActiveThread 归一）。
   * 供编排器各写点取代 legacy message setter（replaceMessages / replaceThreadMessages）逐一改指。
   */
  function patchActiveThreadEntries(
    updater: (entries: readonly IAiThreadEntry[]) => IAiThreadEntry[],
  ): void {
    commitAuthoritativeState(
      threadMutations.patchActiveThread(readAuthoritativeState(), (thread) => ({
        ...thread,
        entries: updater(thread.entries),
      })),
    );
  }

  function replaceMessages(messages: IAiChatMessage[]): void {`,
  },
  {
    find: `    replaceMessages,
    replaceThreadMessages,
  };`,
    replace: `    patchActiveThreadEntries,
    replaceMessages,
    replaceThreadMessages,
  };`,
  },
]);

// --- 2) runtime-events：getLatestCheckpointEvent 改为 entries-native 入参 ------
patchFile('src/composables/ai/useAiAssistant.runtime-events.ts', [
  {
    find: `export const getLatestCheckpointEvent = (message: IAiChatMessage): IAgentCheckpointEvent | null => {
  const runtimeEvents = message.stream?.runtimeEvents ?? [];

  for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {`,
    replace: `export const getLatestCheckpointEvent = (
  runtimeEvents: readonly TAgentRuntimeEvent[],
): IAgentCheckpointEvent | null => {
  for (let index = runtimeEvents.length - 1; index >= 0; index -= 1) {`,
  },
]);

// --- 3) useAiAssistant：两个 changed-files 写点 + checkpoint 读 → entries-native
patchFile('src/composables/ai/useAiAssistant.ts', [
  // 3a) rollback：checkpoint 读改为 entries-native 入参
  {
    find: `      const checkpointEvent = getLatestCheckpointEvent(message);`,
    replace: `      const checkpointEvent = getLatestCheckpointEvent(message.stream?.runtimeEvents ?? []);`,
  },
  // 3b) rollback：mastra 回滚 runtimeEvents 富集 → patch assistant_message entry
  {
    find: `            messages.value = messages.value.map((item) =>
              item.id === messageId
                ? {
                    ...item,
                    stream: {
                      ...(item.stream ?? { status: 'completed' }),
                      runtimeEvents: mergeRuntimeEvents(
                        item.stream?.runtimeEvents,
                        restoreRuntimeEvents,
                      ),
                    },
                  }
                : item,
            );`,
    replace: `            aiThreadStore.patchActiveThreadEntries((entries) =>
              entries.map((entry) =>
                entry.type === 'assistant_message' && entry.id === messageId
                  ? {
                      ...entry,
                      stream: {
                        ...(entry.stream ?? { status: 'completed' }),
                        runtimeEvents: mergeRuntimeEvents(
                          entry.stream?.runtimeEvents,
                          restoreRuntimeEvents,
                        ),
                      },
                    }
                  : entry,
              ),
            );`,
  },
  // 3c) rollback：标记 revertedAt → patch changed_files entry
  {
    find: `      messages.value = messages.value.map((item) =>
        item.id === messageId && item.changedFilesSummary?.id === summaryId
          ? {
              ...item,
              changedFilesSummary: {
                ...item.changedFilesSummary,
                revertedAt,
              },
            }
          : item,
      );`,
    replace: `      aiThreadStore.patchActiveThreadEntries((entries) =>
        entries.map((entry) =>
          entry.type === 'changed_files' && entry.id === summaryId
            ? { ...entry, summary: { ...entry.summary, revertedAt } }
            : entry,
        ),
      );`,
  },
  // 3d) setPin：标记 pinned → patch changed_files entry
  {
    find: `      messages.value = messages.value.map((item) =>
        item.id === messageId && item.changedFilesSummary?.id === summaryId
          ? {
              ...item,
              changedFilesSummary: {
                ...item.changedFilesSummary,
                pinned,
              },
            }
          : item,
      );`,
    replace: `      aiThreadStore.patchActiveThreadEntries((entries) =>
        entries.map((entry) =>
          entry.type === 'changed_files' && entry.id === summaryId
            ? { ...entry, summary: { ...entry.summary, pinned } }
            : entry,
        ),
      );`,
  },
]);

console.log('done');