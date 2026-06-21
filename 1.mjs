// step3a-unify-writer.mjs —— 去掉写缓冲门控，单写者收敛（修“回复完成后消失”）
// 用法：node step3a-unify-writer.mjs  (预览)  /  node step3a-unify-writer.mjs --apply  (落盘)
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/composables/ai/useAiAssistant.ts';
const APPLY = process.argv.includes('--apply');

const edits = [
  {
    name: 'messages setter 写即提交（去缓冲门控）',
    find:
`  const messages = computed<IAiChatMessage[]>({
    get: () => displayMessages.value,
    set: (nextMessages: IAiChatMessage[]) => {
      displayMessages.value = nextMessages;

      if (!isConversationWriteBuffered()) {
        commitDisplayMessagesToStore();
      }
    },
  });`,
    replace:
`  const messages = computed<IAiChatMessage[]>({
    get: () => displayMessages.value,
    set: (nextMessages: IAiChatMessage[]) => {
      displayMessages.value = nextMessages;
      // ④.1 §D 单写者收敛：写即提交到权威 entries（不再缓冲）。否则整轮缓冲为空，
      // 收尾 commit 会用过期空缓冲覆盖 overlay 的最终答案（“回复完成后内容消失”根因）。
      commitDisplayMessagesToStore();
    },
  });`,
  },
  {
    name: 'activeMessages watch 实时回灌（去缓冲门控）',
    find:
`  watch(
    () => unref(conversationStore.activeMessages),
    (nextMessages) => {
      if (isConversationWriteBuffered()) {
        return;
      }

      displayMessages.value = nextMessages;
    },
    { flush: 'sync' },
  );`,
    replace:
`  watch(
    () => unref(conversationStore.activeMessages),
    (nextMessages) => {
      // 权威 entries 为唯一真源：流式中 overlay 写权威 → 这里实时回灌缓冲，messages 即时可见。
      displayMessages.value = nextMessages;
    },
    { flush: 'sync' },
  );`,
  },
  {
    name: 'syncDisplayMessagesFromActiveThread 去缓冲门控',
    find:
`  const syncDisplayMessagesFromActiveThread = (): void => {
    if (!isConversationWriteBuffered()) {
      // ④.1 §D：权威 entries 已是 SoT，收尾仅回读消息缓冲；不再 setStreamingActiveThread(null)
      // （那会把权威线程复位为单空线程、抹掉历史）。最终态由 commitDisplayMessagesToStore 落定。
      displayMessages.value = unref(conversationStore.activeMessages);
    }
  };`,
    replace:
`  const syncDisplayMessagesFromActiveThread = (): void => {
    // 权威 entries 已是 SoT，收尾回读消息缓冲与权威对齐。
    displayMessages.value = unref(conversationStore.activeMessages);
  };`,
  },
  {
    name: '移除已废弃的 isConversationWriteBuffered 定义',
    find:
`  const isConversationWriteBuffered = (): boolean =>
    isSending.value ||
    activeStreamId.value !== null ||
    activeAgentMessageId.value !== null ||
    activeAssistantMessage.value !== null ||
    activeSidecarAgentSession.value !== null ||
    restoringCheckpointId.value !== null;`,
    replace:
`  // （已移除 isConversationWriteBuffered：写缓冲门控随单写者收敛而废弃）`,
  },
];

let src = readFileSync(FILE, 'utf8');
const report = [];
for (const e of edits) {
  const n = src.split(e.find).length - 1;
  if (n !== 1) {
    console.error(`✗ 锚点未唯一命中（${n} 次）：${e.name}`);
    console.error('  —— 中止，未写入任何改动。请把当前文件该处贴回来，我重对锚点。');
    process.exit(1);
  }
  src = src.replace(e.find, e.replace);
  report.push(`✓ ${e.name}`);
}

// 安全校验：确认没有遗漏的 isConversationWriteBuffered 引用（否则 TS 会报未定义/未用）
const leftover = src.split('isConversationWriteBuffered').length - 1;
if (leftover !== 0) {
  console.error(`✗ 仍残留 isConversationWriteBuffered 引用 ${leftover} 处 —— 中止。请贴回残留处。`);
  process.exit(1);
}

console.log(`================ Step 3a ${APPLY ? '【APPLY】' : '【DRY-RUN】'} ================`);
report.forEach((r) => console.log(r));
if (APPLY) {
  writeFileSync(FILE, src, 'utf8');
  console.log(`\n✍ 已写入 ${FILE}（无备份；还原用 git restore）`);
} else {
  console.log(`\n（预览：未写入。确认后跑 node step3a-unify-writer.mjs --apply）`);
}