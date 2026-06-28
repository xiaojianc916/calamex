#!/usr/bin/env node
/**
 * P6/P8 渲染收口 · commit 1：会话历史浮层改 entries-native，退掉 message 桥读侧（历史分支）。
 * 在 repo 根目录运行：node p6-1-history-entries-native.mjs
 * 完成后务必本地跑闸门：pnpm typecheck && pnpm lint && pnpm test
 */
import { readFileSync, writeFileSync } from 'node:fs';

const edits = [
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    replacements: [
      {
        find: '  const historyThreads = computed(() => unref(conversationStore.conversationHistoryThreads));',
        replace: '  const historyThreads = computed(() => aiThreadStore.authoritativeHistoryThreads);',
      },
    ],
  },
  {
    file: 'src/composables/ai/useAiConversationHistory.ts',
    replacements: [
      {
        find: "import type { IAiChatMessage } from '@/types/ai';",
        replace: "import type { IAiThread } from '@/types/ai/thread';",
      },
      {
        find:
          '  const getHistoryMessageCountLabel = (messages: IAiChatMessage[]): string =>\n' +
          '    `${messages.length} 条消息`;',
        replace:
          '  // entries-native 计数：统计映射为可见消息的条目（user_message / assistant_message），\n' +
          '  // 取代依赖 message 桥（thread.messages）的 length；其余条目（tool_call / changed_files 等）\n' +
          '  // 是消息的子条目，不计入「N 条消息」。\n' +
          '  const countThreadMessages = (thread: IAiThread): number =>\n' +
          '    thread.entries.reduce(\n' +
          '      (count, entry) =>\n' +
          "        entry.type === 'user_message' || entry.type === 'assistant_message' ? count + 1 : count,\n" +
          '      0,\n' +
          '    );\n' +
          '\n' +
          '  const getHistoryMessageCountLabel = (thread: IAiThread): string =>\n' +
          '    `${countThreadMessages(thread)} 条消息`;',
      },
      {
        find: "    const messageCountLabel = thread ? getHistoryMessageCountLabel(thread.messages) : '这条记录';",
        replace: "    const messageCountLabel = thread ? getHistoryMessageCountLabel(thread) : '这条记录';",
      },
    ],
  },
  {
    file: 'src/components/business/ai/shell/AiAssistantPanel.vue',
    replacements: [
      {
        find: 'getHistoryMessageCountLabel(thread.messages)',
        replace: 'getHistoryMessageCountLabel(thread)',
      },
    ],
  },
];

let ok = true;
for (const { file, replacements } of edits) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`✗ 读取失败: ${file} (${err.message})`);
    ok = false;
    continue;
  }
  for (const { find, replace } of replacements) {
    const count = src.split(find).length - 1;
    if (count !== 1) {
      console.error(`✗ ${file}: 锚点命中 ${count} 次（期望 1）:\n    ${find.slice(0, 80)}...`);
      ok = false;
      continue;
    }
    src = src.replace(find, replace);
  }
  writeFileSync(file, src);
  console.log(`✓ 已改写: ${file}`);
}

if (!ok) {
  console.error('\n有锚点未按预期命中，未保证全部改写。请检查文件是否与基线一致后重试。');
  process.exit(1);
}
console.log('\n完成。请运行：pnpm typecheck && pnpm lint && pnpm test');
console.log('提示：useAiAssistant.spec.ts / AiAssistantPanel.spec.ts 可能断言旧的 historyThreads(.messages) 形状，需同步更新断言为 entries 形状。');