#!/usr/bin/env node
/**
 * P6/P8 渲染收口 · commit 2（幂等版：可反复运行）
 * 无需 git restore。每条编辑：find 命中则改；已是目标态则跳过；真正不一致才报错（原子，不写盘）。
 * 在 repo 根目录：node 2.mjs   完成后：pnpm typecheck && pnpm lint && pnpm test
 */
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  {
    file: 'src/components/business/ai/chat/AiChatThread.vue',
    replacements: [
      {
        find: "import type { IAiChatMessage } from '@/types/ai';\nimport type { IAiThreadEntry } from '@/types/ai/thread';",
        replace: "import type { IAiThreadEntry } from '@/types/ai/thread';",
        goneToken: 'IAiChatMessage',
        hint: 'IAiChatMessage',
      },
      {
        find: '    messages: IAiChatMessage[];\n    isTyping: boolean;',
        replace: '    isTyping: boolean;',
        goneToken: 'messages: IAiChatMessage',
        hint: 'messages: IAiChatMessage',
      },
      {
        find:
          'const messagesById = computed(() => {\n' +
          '  const map = new Map<string, IAiChatMessage>();\n' +
          '  for (const message of props.messages) {\n' +
          '    map.set(message.id, message);\n' +
          '  }\n' +
          '  return map;\n' +
          '});\n\n',
        replace: '',
        goneToken: 'messagesById',
        hint: 'messagesById',
      },
      {
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
        doneToken: 'const afterMessageIdByEntryId = computed',
        hint: 'afterMessageId',
      },
      {
        find: 'v-if="afterMessageByEntryId.get(item.id)"',
        replace: 'v-if="afterMessageIdByEntryId.has(item.id)"',
        doneToken: 'v-if="afterMessageIdByEntryId.has(item.id)"',
        hint: 'v-if="afterMessage',
      },
      {
        find: ':message="afterMessageByEntryId.get(item.id)"',
        replace: ':message-id="afterMessageIdByEntryId.get(item.id)"',
        doneToken: ':message-id="afterMessageIdByEntryId.get(item.id)"',
        hint: ':message',
      },
    ],
  },
  {
    file: 'src/components/business/ai/shell/AiAssistantPanel.vue',
    replacements: [
      {
        find: '<AiChatThread :messages="assistant.messages.value" :is-typing=',
        replace: '<AiChatThread :is-typing=',
        doneToken: '<AiChatThread :is-typing=',
        hint: '<AiChatThread',
      },
      {
        find: '#after-message="{ message }"',
        replace: '#after-message="{ messageId }"',
        doneToken: '#after-message="{ messageId }"',
        hint: 'after-message',
      },
      {
        find: 'getConversationCheckpoint(message.id)',
        replace: 'getConversationCheckpoint(messageId)',
        doneToken: 'getConversationCheckpoint(messageId)',
        hint: 'getConversationCheckpoint(',
      },
      {
        find: 'getConversationCheckpointLabel(message.id)',
        replace: 'getConversationCheckpointLabel(messageId)',
        doneToken: 'getConversationCheckpointLabel(messageId)',
        hint: 'getConversationCheckpointLabel(',
      },
      {
        find: 'isConversationCheckpointRestoring(message.id)',
        replace: 'isConversationCheckpointRestoring(messageId)',
        doneToken: 'isConversationCheckpointRestoring(messageId)',
        hint: 'isConversationCheckpointRestoring(',
      },
      {
        find: 'handleRestoreConversationCheckpoint(message.id)',
        replace: 'handleRestoreConversationCheckpoint(messageId)',
        doneToken: 'handleRestoreConversationCheckpoint(messageId)',
        hint: 'handleRestoreConversationCheckpoint(',
      },
    ],
  },
];

applyIdempotent('commit 2', files);

function isDone(src, r) {
  if (r.doneToken) return src.includes(r.doneToken);
  if (r.goneToken) return !src.includes(r.goneToken);
  return false;
}

function applyIdempotent(label, fileList) {
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
    const actions = [];
    if (src !== null) {
      for (const r of replacements) {
        const want = r.count ?? 1;
        const hits = src.split(r.find).length - 1;
        if (hits === want) {
          actions.push('apply');
        } else if (hits === 0 && isDone(src, r)) {
          actions.push('skip');
        } else {
          actions.push('error');
          ok = false;
          console.error(`✗ ${file}: 锚点命中 ${hits} 次（期望 ${want}）且非已完成态`);
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
    loaded.push({ file, src, replacements, actions });
  }
  if (!ok) {
    console.error(`\n[${label}] 校验未通过：未写入任何文件（原子保护）。请把上面"本地包含…的行"发给我。`);
    process.exit(1);
  }
  for (const { file, src, replacements, actions } of loaded) {
    let out = src;
    let applied = 0;
    let skipped = 0;
    replacements.forEach((r, i) => {
      if (actions[i] === 'apply') {
        out = out.split(r.find).join(r.replace);
        applied += 1;
      } else {
        skipped += 1;
      }
    });
    writeFileSync(file, out);
    console.log(`✓ ${file}：改 ${applied} 处，跳过 ${skipped} 处（已完成）`);
  }
  console.log(`\n[${label}] 完成。请运行：pnpm typecheck && pnpm lint && pnpm test`);
}