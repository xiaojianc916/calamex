#!/usr/bin/env node
/**
 * P6/P8 渲染收口 · commit 3（幂等版：可反复运行）
 * 编排器写路径全面 entries-native。无需 git restore。
 * find 命中则改；已是目标态则跳过；真正不一致才报错（原子，不写盘）。
 * 在 repo 根目录：node 3.mjs   完成后：pnpm typecheck && pnpm lint && pnpm test（+ pnpm guard）
 */
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  {
    file: 'src/composables/ai/useAiAssistant.ts',
    replacements: [
      {
        find: "import { useAiThreadStore } from '@/store/aiThread';",
        replace: "import { legacyMessageToEntries, useAiThreadStore } from '@/store/aiThread';",
        doneToken: 'legacyMessageToEntries, useAiThreadStore',
        hint: "from '@/store/aiThread'",
      },
      {
        find:
          '  const messages = computed<IAiChatMessage[]>({\n' +
          '    // 读真源 = 权威 entries（activeMessages）；影子缓冲已退役。\n' +
          '    get: () => unref(conversationStore.activeMessages),\n' +
          '    set: (nextMessages: IAiChatMessage[]) => {\n' +
          '      // 写真源单写者 = 权威 store，无条件提交（reduce / overlay 幂等）。\n' +
          '      const activeThreadId = unref(conversationStore.activeThreadId);\n' +
          '      if (activeThreadId) {\n' +
          '        conversationStore.replaceThreadMessages(activeThreadId, nextMessages);\n' +
          '      } else {\n' +
          '        conversationStore.replaceMessages(nextMessages);\n' +
          '      }\n' +
          '    },\n' +
          '  });',
        replace:
          '  // 读真源 = 权威 entries（activeMessages）。写路径已全面 entries-native\n' +
          '  // （patchActiveThreadEntries），故本计算属性退化为只读投影，仅供续聊 requestMessages / token 估算。\n' +
          '  const messages = computed<IAiChatMessage[]>(() => unref(conversationStore.activeMessages));',
        doneToken: 'computed<IAiChatMessage[]>(() => unref(conversationStore.activeMessages))',
        hint: 'const messages = computed',
      },
      {
        count: 3,
        find: '    messages.value = [...visibleMessages, placeholderMessage];',
        replace:
          '    aiThreadStore.patchActiveThreadEntries((entries) => [\n' +
          '      ...entries,\n' +
          '      ...legacyMessageToEntries(placeholderMessage),\n' +
          '    ]);',
        doneToken: '...legacyMessageToEntries(placeholderMessage),',
        hint: '[...visibleMessages, placeholderMessage]',
      },
      {
        find:
          '  const executeSidecarAgentRequest = async (\n' +
          '    visibleMessages: IAiChatMessage[],\n' +
          '    messageContent: string,',
        replace: '  const executeSidecarAgentRequest = async (\n    messageContent: string,',
        doneToken: 'executeSidecarAgentRequest = async (\n    messageContent: string,',
        hint: 'const executeSidecarAgentRequest',
      },
      {
        find:
          '  const executeExternalAgentRequest = async (\n' +
          '    backend: TAgentBackendKind,\n' +
          '    visibleMessages: IAiChatMessage[],\n' +
          '    messageContent: string,',
        replace:
          '  const executeExternalAgentRequest = async (\n' +
          '    backend: TAgentBackendKind,\n' +
          '    messageContent: string,',
        doneToken:
          'executeExternalAgentRequest = async (\n    backend: TAgentBackendKind,\n    messageContent: string,',
        hint: 'const executeExternalAgentRequest',
      },
      {
        find:
          '  const executeAiRequest = async (\n' +
          '    requestMessages: IAiChatMessage[],\n' +
          '    visibleMessages: IAiChatMessage[],\n' +
          '    references: IAiContextReference[],',
        replace:
          '  const executeAiRequest = async (\n' +
          '    requestMessages: IAiChatMessage[],\n' +
          '    references: IAiContextReference[],',
        doneToken:
          'executeAiRequest = async (\n    requestMessages: IAiChatMessage[],\n    references: IAiContextReference[],',
        hint: 'const executeAiRequest',
      },
      {
        find:
          '    const visibleMessages = [...messages.value, userMessage];\n' +
          '\n' +
          '    messages.value = visibleMessages;\n' +
          "    draft.value = '';",
        replace:
          '    aiThreadStore.patchActiveThreadEntries((entries) => [\n' +
          '      ...entries,\n' +
          '      ...legacyMessageToEntries(userMessage),\n' +
          '    ]);\n' +
          "    draft.value = '';",
        doneToken: '...legacyMessageToEntries(userMessage),',
        hint: 'const visibleMessages = [...messages.value, userMessage]',
      },
      {
        find:
          '      errorMessage.value = message;\n' +
          '      messages.value = [\n' +
          '        ...visibleMessages,\n' +
          '        {\n' +
          "          id: createMessageId('assistant'),\n" +
          "          role: 'assistant',\n" +
          '          content: `AI 上下文收集失败：${message}`,\n' +
          '          createdAt: new Date().toISOString(),\n' +
          '          references: [],\n' +
          '        },\n' +
          '      ];\n' +
          '      clearActiveBufferedThread(titleThreadId);',
        replace:
          '      errorMessage.value = message;\n' +
          '      aiThreadStore.patchActiveThreadEntries((entries) => [\n' +
          '        ...entries,\n' +
          '        ...legacyMessageToEntries({\n' +
          "          id: createMessageId('assistant'),\n" +
          "          role: 'assistant',\n" +
          '          content: `AI 上下文收集失败：${message}`,\n' +
          '          createdAt: new Date().toISOString(),\n' +
          '          references: [],\n' +
          '        }),\n' +
          '      ]);\n' +
          '      clearActiveBufferedThread(titleThreadId);',
        goneToken: 'messages.value = [\n        ...visibleMessages,',
        hint: 'AI 上下文收集失败',
      },
      {
        find:
          '    const nextMessages = visibleMessages.map((message) =>\n' +
          '      message.id === userMessage.id\n' +
          '        ? {\n' +
          '            ...message,\n' +
          '            references,\n' +
          '          }\n' +
          '        : message,\n' +
          '    );\n' +
          '\n' +
          '    messages.value = nextMessages;\n' +
          '    clearAttachedFiles({ revokePreviews: false });',
        replace:
          '    aiThreadStore.patchActiveThreadEntries((entries) =>\n' +
          '      entries.map((entry) =>\n' +
          "        entry.type === 'user_message' && entry.id === userMessage.id\n" +
          '          ? { ...entry, references }\n' +
          '          : entry,\n' +
          '      ),\n' +
          '    );\n' +
          '    clearAttachedFiles({ revokePreviews: false });\n' +
          '\n' +
          '    const nextMessages = unref(conversationStore.activeMessages);',
        doneToken: 'const nextMessages = unref(conversationStore.activeMessages);',
        hint: 'const nextMessages = visibleMessages.map',
      },
      {
        find:
          '        messages.value = nextMessages;\n' +
          '        clearAttachedFiles({ revokePreviews: false });\n' +
          '        planSucceeded = true;',
        replace:
          '        clearAttachedFiles({ revokePreviews: false });\n' +
          '        planSucceeded = true;',
        goneToken:
          '        messages.value = nextMessages;\n        clearAttachedFiles({ revokePreviews: false });\n        planSucceeded',
        hint: 'planSucceeded = true',
      },
      {
        find:
          '        messages.value = [\n' +
          '          ...nextMessages,\n' +
          '          {\n' +
          "            id: createMessageId('assistant'),\n" +
          "            role: 'assistant',\n" +
          '            content: `计划生成失败：${message}`,\n' +
          '            createdAt: new Date().toISOString(),\n' +
          '            references: [],\n' +
          '          },\n' +
          '        ];',
        replace:
          '        aiThreadStore.patchActiveThreadEntries((entries) => [\n' +
          '          ...entries,\n' +
          '          ...legacyMessageToEntries({\n' +
          "            id: createMessageId('assistant'),\n" +
          "            role: 'assistant',\n" +
          '            content: `计划生成失败：${message}`,\n' +
          '            createdAt: new Date().toISOString(),\n' +
          '            references: [],\n' +
          '          }),\n' +
          '        ]);',
        goneToken: 'messages.value = [\n          ...nextMessages,',
        hint: '计划生成失败',
      },
      {
        find:
          '      await executeSidecarAgentRequest(\n' +
          '        nextMessages,\n' +
          '        messageContent,\n' +
          '        references,\n' +
          '        userMessage.id,\n' +
          '        titleThreadId,\n' +
          '      );',
        replace:
          '      await executeSidecarAgentRequest(\n' +
          '        messageContent,\n' +
          '        references,\n' +
          '        userMessage.id,\n' +
          '        titleThreadId,\n' +
          '      );',
        goneToken: 'executeSidecarAgentRequest(\n        nextMessages,',
        hint: 'await executeSidecarAgentRequest',
      },
      {
        find:
          '      await executeExternalAgentRequest(\n' +
          '        externalBackend,\n' +
          '        nextMessages,\n' +
          '        messageContent,\n' +
          '        titleThreadId,\n' +
          '      );',
        replace:
          '      await executeExternalAgentRequest(\n' +
          '        externalBackend,\n' +
          '        messageContent,\n' +
          '        titleThreadId,\n' +
          '      );',
        goneToken: 'executeExternalAgentRequest(\n        externalBackend,\n        nextMessages,',
        hint: 'await executeExternalAgentRequest',
      },
      {
        find: '        await executeAiRequest(nextMessages, nextMessages, references, titleThreadId);',
        replace: '        await executeAiRequest(nextMessages, references, titleThreadId);',
        goneToken: 'executeAiRequest(nextMessages, nextMessages,',
        hint: 'await executeAiRequest',
      },
    ],
  },
];

applyIdempotent('commit 3', files);

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
  console.log(`\n[${label}] 完成。请运行：pnpm typecheck && pnpm lint && pnpm test（+ pnpm guard）`);
}