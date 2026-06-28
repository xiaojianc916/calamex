#!/usr/bin/env node
/**
 * P6/P8 渲染收口 · commit 2（修正版：原子 + 单行锚点 + 失败自诊断）
 * 先 git restore 两个文件，再运行：node 2.mjs
 * 行为：所有锚点必须全部命中才写盘；任一未命中则不写任何文件，并打印本地实际相关行。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  {
    file: 'src/components/business/ai/chat/AiChatThread.vue',
    replacements: [
      {
        hint: 'IAiChatMessage',
        find: "import type { IAiChatMessage } from '@/types/ai';\nimport type { IAiThreadEntry } from '@/types/ai/thread';",
        replace: "import type { IAiThreadEntry } from '@/types/ai/thread';",
      },
      {
        hint: 'messages: IAiChatMessage',
        find: '    messages: IAiChatMessage[];\n    isTyping: boolean;',
        replace: '    isTyping: boolean;',
      },
      {
        hint: 'messagesById',
        find:
          'const messagesById = computed(() => {\n' +
          '  const map = new Map<string, IAiChatMessage>();\n' +
          '  for (const message of props.messages) {\n' +
          '    map.set(message.id, message);\n' +
          '  }\n' +
          '  return map;\n' +
          '});\n\n',
        replace: '',
      },
      {
        hint: 'const afterMessageByEntryId',
        find:
          'const afterMessageByEntryId = computed(() => {\n' +
          '  const lastEntryIdByMessageId = new Map<string, string>();\n' +
          '  for (const entry of entryTimeline.value) {\n' +
          '    lastEntryIdByMessageId.set(entry.messageId, entry.id);\n' +
          '  }\n' +
          '\n' +
          '  const resolved = new Map<string, IAiChatMessage>();\n' +
          '  lastEntryIdByMessageId.forEach((entryId, messageId) => {\n' +
          '    const message = messagesById.value.get(messageId);\n' +
          '    if (message) {\n' +
          '      resolved.set(entryId, message);\n' +
          '    }\n' +
          '  });\n' +
          '\n' +
          '  return resolved;\n' +
          '});',
        replace:
          'const afterMessageIdByEntryId = computed(() => {\n' +
          '  const lastEntryIdByMessageId = new Map<string, string>();\n' +
          '  for (const entry of entryTimeline.value) {\n' +
          '    lastEntryIdByMessageId.set(entry.messageId, entry.id);\n' +
          '  }\n' +
          '\n' +
          '  const resolved = new Map<string, string>();\n' +
          '  lastEntryIdByMessageId.forEach((entryId, messageId) => {\n' +
          '    resolved.set(entryId, messageId);\n' +
          '  });\n' +
          '\n' +
          '  return resolved;\n' +
          '});',
      },
      // —— 单行锚点：不依赖缩进/换行，规避本地 slot 区格式差异 ——
      {
        hint: 'afterMessageByEntryId.get(item.id)',
        find: 'v-if="afterMessageByEntryId.get(item.id)"',
        replace: 'v-if="afterMessageIdByEntryId.has(item.id)"',
      },
      {
        hint: ':message=',
        find: ':message="afterMessageByEntryId.get(item.id)"',
        replace: ':message-id="afterMessageIdByEntryId.get(item.id)"',
      },
    ],
  },
  {
    file: 'src/components/business/ai/shell/AiAssistantPanel.vue',
    replacements: [
      {
        hint: '<AiChatThread',
        find: '<AiChatThread :messages="assistant.messages.value" :is-typing=',
        replace: '<AiChatThread :is-typing=',
      },
      {
        hint: 'after-message',
        find: '#after-message="{ message }"',
        replace: '#after-message="{ messageId }"',
      },
      {
        hint: 'getConversationCheckpoint(',
        find: 'getConversationCheckpoint(message.id)',
        replace: 'getConversationCheckpoint(messageId)',
      },
      {
        hint: 'getConversationCheckpointLabel(',
        find: 'getConversationCheckpointLabel(message.id)',
        replace: 'getConversationCheckpointLabel(messageId)',
      },
      {
        hint: 'isConversationCheckpointRestoring(',
        find: 'isConversationCheckpointRestoring(message.id)',
        replace: 'isConversationCheckpointRestoring(messageId)',
      },
      {
        hint: 'handleRestoreConversationCheckpoint(',
        find: 'handleRestoreConversationCheckpoint(message.id)',
        replace: 'handleRestoreConversationCheckpoint(messageId)',
      },
    ],
  },
];

applyAtomic('commit 2', files);

function applyAtomic(label, fileList) {
  const loaded = [];
  let ok = true;
  for (const { file, replacements } of fileList) {
    let src = null;
    try {
      src = readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`✗ 读取失败: ${file} (${err.message})`);
      ok = false;
    }
    if (src !== null) {
      for (const r of replacements) {
        const want = r.count ?? 1;
        const hits = src.split(r.find).length - 1;
        if (hits !== want) {
          ok = false;
          console.error(`✗ ${file}: 锚点命中 ${hits} 次（期望 ${want}）`);
          console.error(`   find: ${JSON.stringify(r.find.length > 80 ? r.find.slice(0, 80) + '…' : r.find)}`);
          if (r.hint) {
            const rows = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(r.hint));
            console.error(`   —— 本地包含 "${r.hint}" 的行：`);
            if (!rows.length) console.error('     （未找到）');
            for (const [n, l] of rows.slice(0, 12)) console.error(`     ${n}: ${l}`);
          }
        }
      }
    }
    loaded.push({ file, src, replacements });
  }
  if (!ok) {
    console.error(`\n[${label}] 校验未通过：未写入任何文件（原子保护）。请把上面"本地包含…的行"发给我以校正锚点。`);
    process.exit(1);
  }
  for (const { file, src, replacements } of loaded) {
    let out = src;
    for (const r of replacements) out = out.split(r.find).join(r.replace);
    writeFileSync(file, out);
    console.log(`✓ 已改写: ${file}`);
  }
  console.log(`\n[${label}] 完成。请运行：pnpm typecheck && pnpm lint && pnpm test`);
}