// codemod-2b-1-context-entries-native.mjs
// Run from repo root:  node codemod-2b-1-context-entries-native.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();

function patchFile(relPath, edits) {
  const abs = resolve(ROOT, relPath);
  let text = readFileSync(abs, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (s) => (eol === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s.replace(/\r\n/g, '\n'));
  edits.forEach((edit, i) => {
    const find = toEol(edit.find);
    const replace = toEol(edit.replace);
    const count = text.split(find).length - 1;
    if (count !== 1) {
      throw new Error('[' + relPath + '] 第 ' + (i + 1) + ' 处编辑：期望 find 命中 1 次，实际命中 ' + count + ' 次');
    }
    text = text.replace(find, replace);
  });
  writeFileSync(abs, text, 'utf8');
  console.log('OK ' + relPath + ' (' + edits.length + ' 处)');
}

// ---------------------------------------------------------------------------
// 1) src/store/aiAgent.ts — session 基线改 entries（删 baseMessages，无残留字段）
// ---------------------------------------------------------------------------
patchFile('src/store/aiAgent.ts', [
  {
    find: `  IAiChatMessage,
  IAiContextReference,`,
    replace: `  IAiContextReference,`,
  },
  {
    find: `import { aiChatMessageSchema, aiLanguageModelUsageSchema } from '@/types/ai/schema';`,
    replace: `import { aiLanguageModelUsageSchema } from '@/types/ai/schema';`,
  },
  {
    find: `import { aiToolActivityInlineSchema } from '@/types/ai/stream.schema';`,
    replace: `import { aiToolActivityInlineSchema } from '@/types/ai/stream.schema';
import { aiThreadEntrySchema, type IAiThreadEntry } from '@/types/ai/thread';`,
  },
  {
    find: `  threadId: string | null;
  turnId: string | null;
  baseMessages: IAiChatMessage[];
  messageContent: string;
  references: IAiContextReference[];
}`,
    replace: `  threadId: string | null;
  turnId: string | null;
  baseEntries: IAiThreadEntry[];
  messageContent: string;
  references: IAiContextReference[];
}`,
  },
  {
    find: `  turnId: z.string().min(1).nullable(),
  baseMessages: z.array(aiChatMessageSchema).max(20),
  messageContent: z.string(),`,
    replace: `  turnId: z.string().min(1).nullable(),
  // entries 单一真源：续聊/审批 resume 的基线上下文用权威 entries 快照。
  // default([]) 兼容尚未写入该字段的旧持久化数据（避免整段 agent state 解析失败）。
  baseEntries: z.array(aiThreadEntrySchema).max(200).default([]),
  messageContent: z.string(),`,
  },
]);

// ---------------------------------------------------------------------------
// 2) src/composables/ai/useAiAssistant.ts — 上下文投影 entries 化 + 基线快照
// ---------------------------------------------------------------------------
patchFile('src/composables/ai/useAiAssistant.ts', [
  {
    find: `  const toSidecarMessages = (visibleMessages: IAiChatMessage[]): IAgentSidecarMessage[] => {
    return visibleMessages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: message.content.trim(),
      }))
      .filter((message) => message.content.length > 0)
      .slice(-SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT);
  };`,
    replace: `  // 上下文真源 = 权威 entries（对标 Zed AcpThread::to_markdown 由 entries 派生上下文）：
  // user_message → 文本块以空行衔接；assistant_message → message chunk 文本顺序拼接；
  // 仅取 user/assistant 文本、去空、保序、截最近 N 条。与旧 messages 投影按构造等价。
  const toSidecarMessages = (entries: readonly IAiThreadEntry[]): IAgentSidecarMessage[] => {
    const sidecarMessages: IAgentSidecarMessage[] = [];
    for (const entry of entries) {
      if (entry.type === 'user_message') {
        const content = entry.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\\n\\n')
          .trim();
        if (content.length > 0) {
          sidecarMessages.push({ role: 'user', content });
        }
        continue;
      }
      if (entry.type === 'assistant_message') {
        const content = entry.chunks
          .flatMap((chunk) =>
            chunk.type === 'message' && chunk.block.type === 'text' ? [chunk.block.text] : [],
          )
          .join('')
          .trim();
        if (content.length > 0) {
          sidecarMessages.push({ role: 'assistant', content });
        }
      }
    }
    return sidecarMessages.slice(-SIDECAR_EXPLICIT_CONTEXT_MESSAGE_LIMIT);
  };`,
  },
  {
    find: `    const assistantMessageId = createMessageId('assistant');
    const targetThreadId = threadId;
    activeBufferedThreadId.value = targetThreadId;
    const initialActivityText = buildInitialAgentActivityText();`,
    replace: `    const assistantMessageId = createMessageId('assistant');
    const targetThreadId = threadId;
    activeBufferedThreadId.value = targetThreadId;
    // 回合基线 = 「发起回合前」的权威 entries 快照（此刻活动线程已含本回合 user_message、
    // 尚无 assistant 占位）。同时用于本回合 sidecar 上下文与（审批/反向提问）resume 基线。
    const turnBaseEntries = [...aiThreadStore.authoritativeActiveEntries];
    const initialActivityText = buildInitialAgentActivityText();`,
  },
  {
    find: `        messages: toSidecarMessages(visibleMessages),`,
    replace: `        messages: toSidecarMessages(turnBaseEntries),`,
  },
  {
    find: `          persistSidecarToolConfirmation(pendingConfirmation, {
            sessionId: payload.sessionId,
            assistantMessageId,
            threadId: targetThreadId,
            turnId,
            baseMessages: visibleMessages,`,
    replace: `          persistSidecarToolConfirmation(pendingConfirmation, {
            sessionId: payload.sessionId,
            assistantMessageId,
            threadId: targetThreadId,
            turnId,
            baseEntries: turnBaseEntries,`,
  },
  {
    find: `          persistSidecarUserQuestion(pendingUserQuestion, {
            sessionId: payload.sessionId,
            assistantMessageId,
            threadId: targetThreadId,
            turnId,
            baseMessages: visibleMessages,`,
    replace: `          persistSidecarUserQuestion(pendingUserQuestion, {
            sessionId: payload.sessionId,
            assistantMessageId,
            threadId: targetThreadId,
            turnId,
            baseEntries: turnBaseEntries,`,
  },
  {
    find: `        decision: mapToolConfirmationDecisionToSidecarDecision(decision),
        goal: session.messageContent,
        messages: toSidecarMessages(session.baseMessages),`,
    replace: `        decision: mapToolConfirmationDecisionToSidecarDecision(decision),
        goal: session.messageContent,
        messages: toSidecarMessages(session.baseEntries),`,
  },
  {
    find: `        }),
        goal: session.messageContent,
        messages: toSidecarMessages(session.baseMessages),`,
    replace: `        }),
        goal: session.messageContent,
        messages: toSidecarMessages(session.baseEntries),`,
  },
]);

// ---------------------------------------------------------------------------
// 3) src/composables/ai/useAiAssistant.spec.ts — 两处持久化 session fixture 改 baseEntries
// ---------------------------------------------------------------------------
patchFile('src/composables/ai/useAiAssistant.spec.ts', [
  {
    find: `      turnId: 'user-switch-approval',
      baseMessages: [],`,
    replace: `      turnId: 'user-switch-approval',
      baseEntries: [],`,
  },
  {
    find: `      turnId: 'user-persisted-approval',
      baseMessages: [],`,
    replace: `      turnId: 'user-persisted-approval',
      baseEntries: [],`,
  },
]);

console.log('done');