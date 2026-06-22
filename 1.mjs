// scripts/c1-1-remove-dead-aistream.mjs
// C1.1：删除 useAiAssistant.ts 中已死的旧 aiStream / activeAssistantMessage 簇。
// 行为等价：activeAssistantMessage / activeAssistantBaseMessages 从未被赋非空值，
// syncActiveAssistantMessage 永远早退、其 watch 空转、stopCurrentRequest 的对应分支永不进入。
// 用法：node scripts/c1-1-remove-dead-aistream.mjs        (dry-run，仅报告命中)
//      node scripts/c1-1-remove-dead-aistream.mjs --apply (写回，保留原文件 EOL)
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const L = (...lines) => lines.join('\n'); // 用 \n 拼行，规避换行转义坑

const FILE = 'src/composables/ai/useAiAssistant.ts';

const replacements = [
  // 1) 删 useAiStream 导入
  {
    find: L(
      "import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';",
      "import { useAiStream } from '@/composables/ai/useAiStream';",
    ),
    to: L("import { useAiAgentPlan } from '@/composables/ai/useAiAgentPlan';"),
  },
  // 2) 删 stream 模块里已不再使用的 mapStreamStatus 命名导入
  {
    find: L('  isAiEditOperationEntry,', '  mapStreamStatus,', '  mapToolConfirmationDecisionToSidecarDecision,'),
    to: L('  isAiEditOperationEntry,', '  mapToolConfirmationDecisionToSidecarDecision,'),
  },
  // 3) 删两个从未被赋非空值的 ref 声明
  {
    find: L(
      '  const activeStreamResolve = ref<(() => void) | null>(null);',
      '  const activeAssistantMessage = ref<IAiChatMessage | null>(null);',
      '  const activeAssistantBaseMessages = shallowRef<IAiChatMessage[]>([]);',
      '  const activeSidecarAgentSession = ref<IAiPersistedSidecarAgentSession | null>(null);',
    ),
    to: L(
      '  const activeStreamResolve = ref<(() => void) | null>(null);',
      '  const activeSidecarAgentSession = ref<IAiPersistedSidecarAgentSession | null>(null);',
    ),
  },
  // 4) 删 aiStream 实例声明
  {
    find: L('  const aiStream = useAiStream();', '  const agentPlan = useAiAgentPlan();'),
    to: L('  const agentPlan = useAiAgentPlan();'),
  },
  // 5) 删 syncActiveAssistantMessage 函数 + 其 watch（整段空转）
  {
    find: L(
      '  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();',
      '',
      '  const syncActiveAssistantMessage = (): void => {',
      '    const current = activeAssistantMessage.value;',
      '',
      '    if (!current) {',
      '      return;',
      '    }',
      '',
      '    current.content = aiStream.content.value;',
      '    current.stream = {',
      '      ...current.stream,',
      '      status: mapStreamStatus(aiStream.status.value),',
      '    };',
      '',
      '    messages.value = [...activeAssistantBaseMessages.value, { ...current }];',
      '  };',
      '',
      '  watch(',
      '    () => [aiStream.content.value, aiStream.status.value] as const,',
      '    () => {',
      '      syncActiveAssistantMessage();',
      '    },',
      "    { flush: 'sync' },",
      '  );',
      '',
      '  const resolveActiveAgentPatchTarget = (): IActiveAgentPatchTarget | null => {',
    ),
    to: L(
      '  const { refreshSidecarChangedDocuments } = useSidecarChangedDocumentRefresh();',
      '',
      '  const resolveActiveAgentPatchTarget = (): IActiveAgentPatchTarget | null => {',
    ),
  },
  // 6) 删 stopCurrentRequest 里永不进入的 aiStream / activeAssistantMessage 分支
  {
    find: L(
      '    activeStreamResolve.value?.();',
      '    activeStreamResolve.value = null;',
      '',
      '    aiStream.stop();',
      '',
      '    if (activeAssistantMessage.value) {',
      '      activeAssistantMessage.value.stream = {',
      '        ...activeAssistantMessage.value.stream,',
      "        status: 'cancelled',",
      '      };',
      '      activeAssistantMessage.value.content = aiStream.content.value;',
      '',
      '      messages.value = [...activeAssistantBaseMessages.value, { ...activeAssistantMessage.value }];',
      '    }',
      '',
      '    if (activeAgentMessageId.value) {',
    ),
    to: L(
      '    activeStreamResolve.value?.();',
      '    activeStreamResolve.value = null;',
      '',
      '    if (activeAgentMessageId.value) {',
    ),
  },
  // 7) 删 resetConversationUiState 里对应的两行置空
  {
    find: L(
      '    clearAttachedFiles();',
      "    errorMessage.value = '';",
      '    activeAssistantMessage.value = null;',
      '    activeAssistantBaseMessages.value = [];',
      '    activeAgentMessageId.value = null;',
    ),
    to: L(
      '    clearAttachedFiles();',
      "    errorMessage.value = '';",
      '    activeAgentMessageId.value = null;',
    ),
  },
];

const raw = readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;

// 第一遍：逐项校验「恰好命中 1 次」
for (const [i, r] of replacements.entries()) {
  const n = text.split(r.find).length - 1;
  if (n !== 1) {
    console.error(`✗ 替换 #${i + 1} 期望命中 1 次，实际 ${n} 次。已中止，未写入。`);
    process.exit(1);
  }
}
// 第二遍：原子替换
for (const r of replacements) {
  text = text.replace(r.find, () => r.to);
}

if (!APPLY) {
  console.log('✓ dry-run：7 处替换均恰好命中 1 次。加 --apply 写回。');
  process.exit(0);
}

const out = crlf ? text.replace(/\n/g, '\r\n') : text;
writeFileSync(FILE, out, 'utf8');
console.log(`✓ 已写回 ${FILE}（保留原 EOL：${crlf ? 'CRLF' : 'LF'}）。`);