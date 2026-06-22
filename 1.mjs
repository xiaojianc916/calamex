// scripts/c1-2-collapse-display-messages.mjs
// C1.2：messages 读写真源收敛到权威 activeMessages，删除 displayMessages 影子缓冲 +
// 同步 watch + syncDisplayMessagesFromActiveThread。行为等价（sync watch 本就把二者恒等镜像）。
// 用法：node scripts/c1-2-collapse-display-messages.mjs        (dry-run)
//      node scripts/c1-2-collapse-display-messages.mjs --apply
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const FILE = 'src/composables/ai/useAiAssistant.ts';
const L = (...lines) => lines.join('\n');

const raw = readFileSync(FILE, 'utf8');
const crlf = raw.includes('\r\n');
let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;

function findUnique(anchor, label) {
  const i = text.indexOf(anchor);
  if (i < 0) { console.error(`✗ [${label}] 未找到锚点`); process.exit(1); }
  if (text.indexOf(anchor, i + 1) >= 0) { console.error(`✗ [${label}] 锚点不唯一`); process.exit(1); }
  return i;
}
function replaceOnce(label, find, to) {
  const n = text.split(find).length - 1;
  if (n !== 1) { console.error(`✗ [${label}] 期望命中 1，实际 ${n}`); process.exit(1); }
  text = text.replace(find, () => to);
  console.log(`✓ [${label}]`);
}
function replaceRegion(label, startAnchor, endAnchorExclusive, newText) {
  const s = findUnique(startAnchor, `${label} start`);
  const e = findUnique(endAnchorExclusive, `${label} end`);
  if (e <= s) { console.error(`✗ [${label}] end 在 start 之前`); process.exit(1); }
  text = text.slice(0, s) + newText + text.slice(e);
  console.log(`✓ [${label}] 区域替换`);
}
function removeAll(label, find, expected) {
  const n = text.split(find).length - 1;
  if (n !== expected) { console.error(`✗ [${label}] 期望移除 ${expected}，实际 ${n}`); process.exit(1); }
  text = text.split(find).join('');
  console.log(`✓ [${label}] 移除 ${n} 处`);
}
function replaceOptional(label, find, to) {
  const n = text.split(find).length - 1;
  if (n > 1) { console.error(`✗ [${label}] 期望 0/1，实际 ${n}`); process.exit(1); }
  if (n === 1) { text = text.replace(find, () => to); console.log(`✓ [${label}]`); }
  else { console.log(`• [${label}] 未命中（注释疑似变体，跳过，不影响结构）`); }
}

// 1) 删除 displayMessages 影子 ref 声明（含整行换行）
replaceOnce(
  'R1 删 displayMessages 声明',
  '  const displayMessages = shallowRef<IAiChatMessage[]>(unref(conversationStore.activeMessages));\n',
  '',
);

// 2) commitDisplayMessagesToStore 改为读真源 messages.value
replaceOnce(
  'R2a commit.replaceThreadMessages',
  '      conversationStore.replaceThreadMessages(threadId, displayMessages.value);',
  '      conversationStore.replaceThreadMessages(threadId, messages.value);',
);
replaceOnce(
  'R2b commit.replaceMessages',
  '    conversationStore.replaceMessages(displayMessages.value);',
  '    conversationStore.replaceMessages(messages.value);',
);

// 3) 整段删除 syncDisplayMessagesFromActiveThread 函数（含其内带引号的注释，靠唯一锚点切除，不复刻注释字节）
replaceRegion(
  'A 删 sync 函数',
  '  const syncDisplayMessagesFromActiveThread = (): void => {',
  '  const messages = computed<IAiChatMessage[]>({',
  '',
);

// 4) 整段替换 messages computed + 同步 watch -> 直读 activeMessages、直写 store，删 watch
replaceRegion(
  'B 重写 messages computed 并删 watch',
  '  const messages = computed<IAiChatMessage[]>({',
  '  const historyThreads = computed(() => unref(conversationStore.conversationHistoryThreads));',
  L(
    '  const messages = computed<IAiChatMessage[]>({',
    '    // 读真源 = 权威 entries（activeMessages）；影子缓冲已退役。',
    '    get: () => unref(conversationStore.activeMessages),',
    '    set: (nextMessages: IAiChatMessage[]) => {',
    '      // 写真源单写者 = 权威 store，无条件提交（reduce / overlay 幂等）。',
    '      const activeThreadId = unref(conversationStore.activeThreadId);',
    '      if (activeThreadId) {',
    '        conversationStore.replaceThreadMessages(activeThreadId, nextMessages);',
    '      } else {',
    '        conversationStore.replaceMessages(nextMessages);',
    '      }',
    '    },',
    '  });',
    '',
    '',
  ),
);

// 5) deleteConversation：删掉 else 分支里的 sync 调用（连同空 else）
replaceOnce(
  'C deleteConversation else',
  L(
    '    if (wasActiveThread) {',
    '      resetConversationUiState();',
    '      agentPlan.resetPlan();',
    '    } else {',
    '      syncDisplayMessagesFromActiveThread();',
    '    }',
  ),
  L(
    '    if (wasActiveThread) {',
    '      resetConversationUiState();',
    '      agentPlan.resetPlan();',
    '    }',
  ),
);

// 6) 移除其余所有 syncDisplayMessagesFromActiveThread() 调用（三种缩进，按缩进精确计数）
removeAll('D8 8空格调用', '\n        syncDisplayMessagesFromActiveThread();', 1); // sendMessage plan finally
removeAll('D6 6空格调用', '\n      syncDisplayMessagesFromActiveThread();', 6); // 5 个 sidecar finally + sendMessage 错误分支
removeAll('D4 4空格调用', '\n    syncDisplayMessagesFromActiveThread();', 1);   // stopCurrentRequest

// 7) 顺手修正 commit 函数里那条引用 displayMessages 的注释（best-effort，不命中也不影响结构）
replaceOptional(
  'E 注释修正',
  '    // displayMessages 恒为「当前活动线程」的投影；回合线程已被切到后台时，绝不能用活动线程的显示缓冲',
  '    // 读真源 = 权威 entries（messages getter）；回合线程已被切到后台时，绝不能用活动线程内容覆盖后台线程',
);

// 8) 终检：影子缓冲 / 同步函数必须彻底消失
for (const pat of ['displayMessages.value', 'const displayMessages', 'syncDisplayMessagesFromActiveThread']) {
  const c = text.split(pat).length - 1;
  if (c !== 0) { console.error(`✗ 终检失败：仍残留 ${pat} ×${c}`); process.exit(1); }
}
console.log('✓ 终检通过：displayMessages.value / const displayMessages / syncDisplayMessagesFromActiveThread 均为 0');

if (!APPLY) {
  console.log('\n✓ dry-run 全部通过。加 --apply 写回。');
  process.exit(0);
}

const out = crlf ? text.replace(/\n/g, '\r\n') : text;
writeFileSync(FILE, out, 'utf8');
console.log(`\n✓ 已写回 ${FILE}（保留原 EOL：${crlf ? 'CRLF' : 'LF'}）。`);