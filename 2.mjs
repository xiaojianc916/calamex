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

function spliceRegion(relPath, startAnchor, endAnchor, replacement) {
  const abs = resolve(ROOT, relPath);
  let text = readFileSync(abs, 'utf8');
  const eol = detectEol(text);
  const start = startAnchor.split('\n').join(eol);
  const end = endAnchor.split('\n').join(eol);
  const startIdx = text.indexOf(start);
  if (startIdx < 0) {
    throw new Error('[' + relPath + '] start anchor not found');
  }
  if (text.indexOf(start, startIdx + start.length) !== -1) {
    throw new Error('[' + relPath + '] start anchor not unique');
  }
  const endIdx = text.indexOf(end, startIdx + start.length);
  if (endIdx < 0) {
    throw new Error('[' + relPath + '] end anchor not found');
  }
  const body = replacement.split('\n').join(eol);
  text = text.slice(0, startIdx) + body + text.slice(endIdx);
  writeFileSync(abs, text, 'utf8');
  console.log('OK ' + relPath + ' (region)');
}

// --- 1) runtime-events：新增 entries-native 派生，删除 messages 版本 + memo ----
patchFile('src/composables/ai/useAiAssistant.runtime-events.ts', [
  {
    find:
      "import type { IAiChatMessage } from '@/types/ai';\n" +
      "import type { IAgentCheckpointEvent, TAgentRuntimeEvent } from '@/types/ai/sidecar';\n",
    replace:
      "import type { IAiChatMessage } from '@/types/ai';\n" +
      "import type { IAgentCheckpointEvent, TAgentRuntimeEvent } from '@/types/ai/sidecar';\n" +
      "import type { IAiThreadEntry } from '@/types/ai/thread';\n",
  },
]);

spliceRegion(
  'src/composables/ai/useAiAssistant.runtime-events.ts',
  'export const buildConversationCheckpoints = (',
  'export const getLatestCheckpointEvent = (message: IAiChatMessage): IAgentCheckpointEvent | null => {',
  [
    'export const buildConversationCheckpointsFromEntries = (',
    '  entries: readonly IAiThreadEntry[],',
    '): IAiConversationCheckpoint[] => {',
    '  // 对标 Zed AcpThread：检查点直接由权威 entries 派生（不再经 legacy messages 投影）。',
    '  // 跳过「最后一条 assistant_message」——正在流式的当前回合，其 runtimeEvents 每 token',
    '  // 变化且不应提供回滚点；其余 assistant 段各取最近一个 rollback.checkpoint.created。',
    '  let lastAssistantIndex = -1;',
    '  entries.forEach((entry, index) => {',
    "    if (entry.type === 'assistant_message') {",
    '      lastAssistantIndex = index;',
    '    }',
    '  });',
    '',
    '  const checkpoints: IAiConversationCheckpoint[] = [];',
    '',
    '  entries.forEach((entry, index) => {',
    "    if (entry.type !== 'assistant_message' || index === lastAssistantIndex) {",
    '      return;',
    '    }',
    '',
    '    const runtimeEvents = entry.stream?.runtimeEvents ?? [];',
    '',
    '    for (let eventIndex = runtimeEvents.length - 1; eventIndex >= 0; eventIndex -= 1) {',
    '      const event = runtimeEvents[eventIndex];',
    '',
    '      if (!event || !isCheckpointCreatedRuntimeEvent(event)) {',
    '        continue;',
    '      }',
    '',
    '      checkpoints.push({',
    '        id: event.id,',
    '        messageId: entry.id,',
    '        runId: event.runId,',
    '        snapshotId: event.snapshotId?.trim() || event.runId,',
    '        sessionId: event.sessionId,',
    '        createdAt: event.timestamp,',
    '      });',
    '      break;',
    '    }',
    '  });',
    '',
    '  return checkpoints;',
    '};',
    '',
    '',
  ].join('\n'),
);

// --- 2) useAiAssistant：切换 import + computed 读真源到 entries ----------------
patchFile('src/composables/ai/useAiAssistant.ts', [
  {
    find: '  buildConversationCheckpoints,\n  buildInitialAgentActivityText,\n',
    replace: '  buildConversationCheckpointsFromEntries,\n  buildInitialAgentActivityText,\n',
  },
  {
    find:
      '  const conversationCheckpoints = computed<IAiConversationCheckpoint[]>(() =>\n' +
      '    buildConversationCheckpoints(messages.value),\n' +
      '  );\n',
    replace:
      '  const conversationCheckpoints = computed<IAiConversationCheckpoint[]>(() =>\n' +
      '    buildConversationCheckpointsFromEntries(aiThreadStore.authoritativeActiveEntries),\n' +
      '  );\n',
  },
]);

console.log('done');