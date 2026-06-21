// step3a-unify-writer.mjs —— 统一 §D：messages 读写真源收敛到权威 entries，去掉 isConversationWriteBuffered 闸门
// 用法：node 1.mjs          （dry-run 预览）
//      node 1.mjs --apply   （写回；git 是唯一安全网，不产生 .bak）
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/composables/ai/useAiAssistant.ts';
const APPLY = process.argv.includes('--apply');

const edits = [
  {
    tag: '①删除 isConversationWriteBuffered 定义',
    oldStr: `  const isConversationWriteBuffered = (): boolean =>
    isSending.value ||
    activeStreamId.value !== null ||
    activeAgentMessageId.value !== null ||
    activeAssistantMessage.value !== null ||
    activeSidecarAgentSession.value !== null ||
    restoringCheckpointId.value !== null;

  const commitDisplayMessagesToStore = (`,
    newStr: `  const commitDisplayMessagesToStore = (`,
  },
  {
    tag: '②syncDisplayMessagesFromActiveThread 去闸门',
    oldStr: `  const syncDisplayMessagesFromActiveThread = (): void => {
    if (!isConversationWriteBuffered()) {
      // ④.1 §D：权威 entries 已是 SoT，收尾仅回读消息缓冲；不再 setStreamingActiveThread(null)
      // （那会把权威线程复位为单空线程、抹掉历史）。最终态由 commitDisplayMessagesToStore 落定。
      displayMessages.value = unref(conversationStore.activeMessages);
    }
  };`,
    newStr: `  const syncDisplayMessagesFromActiveThread = (): void => {
    // ④.1 §D（统一）：messages 读真源 = 权威 entries，收尾无条件回读，杜绝把流式期"冻结"的
    // 空缓冲当成最终态（即回复完成后内容消失的根因）。最终落库仍由 commitDisplayMessagesToStore 负责。
    displayMessages.value = unref(conversationStore.activeMessages);
  };`,
  },
  {
    tag: '③messages setter 去闸门（无条件提交权威）',
    oldStr: `    set: (nextMessages: IAiChatMessage[]) => {
      displayMessages.value = nextMessages;

      if (!isConversationWriteBuffered()) {
        commitDisplayMessagesToStore();
      }
    },`,
    newStr: `    set: (nextMessages: IAiChatMessage[]) => {
      displayMessages.value = nextMessages;
      // ④.1 §D（统一）：写真源单写者 = 权威 store，无条件提交（reduce/overlay 幂等）。
      commitDisplayMessagesToStore();
    },`,
  },
  {
    tag: '④watch(activeMessages) 去闸门（实时回灌）',
    oldStr: `    (nextMessages) => {
      if (isConversationWriteBuffered()) {
        return;
      }

      displayMessages.value = nextMessages;
    },
    { flush: 'sync' },`,
    newStr: `    (nextMessages) => {
      // ④.1 §D（统一）：权威 entries 即唯一读真源，活动线程一变就实时回灌 displayMessages，
      // 不再因 buffered 闸门在流式期"冻结"显示缓冲（回复完成后内容消失的根因）。
      displayMessages.value = nextMessages;
    },
    { flush: 'sync' },`,
  },
];

let src = readFileSync(FILE, 'utf8');
const before = src;

for (const e of edits) {
  const n = src.split(e.oldStr).length - 1;
  if (n !== 1) {
    console.error(`✗ 锚点【${e.tag}】期望命中 1 处，实际 ${n} 处 —— 中止，未写入。`);
    process.exit(1);
  }
}
for (const e of edits) src = src.replace(e.oldStr, e.newStr);

const left = src.split('isConversationWriteBuffered').length - 1;
if (left !== 0) {
  console.error(`✗ 仍残留 isConversationWriteBuffered 引用 ${left} 处 —— 中止，未写入。`);
  process.exit(1);
}

if (!APPLY) {
  console.log('✓ dry-run：4 处锚点均唯一命中，去闸门后 0 残留。加 --apply 写回。');
  process.exit(0);
}
if (src === before) { console.log('· 无变化。'); process.exit(0); }

writeFileSync(FILE, src, 'utf8');
console.log('✓ 已写回 ' + FILE + '（4 处编辑，0 残留，无备份文件）。');