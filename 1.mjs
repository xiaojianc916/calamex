#!/usr/bin/env node
// 8.1a — entries 渲染路径恢复 after-message(检查点)挂载。
// 纯新增:不改 renderFromEntries 开关、不删 legacy 消息分支。仅改 AiChatThread.vue + 补 entries 测试。
// 行尾兼容:按各文件实际 EOL(LF/CRLF)转换锚点并写回,保留原行尾。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const CHECK = process.argv.includes('--check');

function replaceOnce(source, oldStr, newStr) {
  const first = source.indexOf(oldStr);
  if (first === -1) {
    throw new Error('锚点未找到:\n' + oldStr.slice(0, 160));
  }
  if (source.indexOf(oldStr, first + oldStr.length) !== -1) {
    throw new Error('锚点不唯一:\n' + oldStr.slice(0, 160));
  }
  return source.slice(0, first) + newStr + source.slice(first + oldStr.length);
}

// edits: Array<[oldStr, newStr]>，均以 LF 书写；按文件实际 EOL 自动转换。
function edit(relPath, edits) {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error('文件不存在: ' + relPath);
  }
  const before = readFileSync(abs, 'utf8');
  const eol = before.includes('\r\n') ? '\r\n' : '\n';
  const toEol = (s) => s.replace(/\r\n/g, '\n').replace(/\n/g, eol);

  let next = before;
  for (const [oldStr, newStr] of edits) {
    next = replaceOnce(next, toEol(oldStr), toEol(newStr));
  }

  if (next === before) {
    console.log('• 无变化: ' + relPath);
    return;
  }
  if (CHECK) {
    console.log('• 将修改: ' + relPath + ' (EOL=' + (eol === '\r\n' ? 'CRLF' : 'LF') + ')');
    return;
  }
  writeFileSync(abs, next, 'utf8');
  console.log('✓ 已修改: ' + relPath + ' (EOL=' + (eol === '\r\n' ? 'CRLF' : 'LF') + ')');
}

// ── 1) AiChatThread.vue ────────────────────────────────────────────────
const THREAD = 'src/components/business/ai/chat/AiChatThread.vue';

const scriptAnchor = 'const entryExpansion = useThreadEntryExpansion(entryTimeline);';
const scriptInsert =
  scriptAnchor +
  '\n\n' +
  'const messagesById = computed(() => {\n' +
  '  const map = new Map<string, IAiChatMessage>();\n' +
  '  for (const message of props.messages) {\n' +
  '    map.set(message.id, message);\n' +
  '  }\n' +
  '  return map;\n' +
  '});\n' +
  '\n' +
  '// entries 路径下,checkpoint 等 after-message 内容按“来源消息边界”挂载:取每个 messageId\n' +
  '// 在平铺时间线中最后一条 entry 作为边界;仅当该消息存在于 messages 时才产出(否则不渲染,\n' +
  '// 与收敛前 entries 模式行为一致,不臆造数据)。\n' +
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
  '});';

const entryViewOld =
  '            <AiThreadEntryView\n' +
  '              v-else-if="item.type === \'entry\'"\n' +
  '              :entry="item.entry"\n' +
  '              :open="entryExpansion.isExpanded(item.entry)"\n' +
  '              :workspace-root-path="workspaceRootPath"\n' +
  '              :plan-details="planDetails"\n' +
  '              :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"\n' +
  '              :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"\n' +
  '              @update:open="entryExpansion.setExpanded(item.entry, $event)"\n' +
  '              @changed-files-rollback="handleChangedFilesRollback"\n' +
  '              @changed-files-pin="handleChangedFilesPin"\n' +
  '              @plan-approve="emit(\'planApprove\')"\n' +
  '              @plan-reject="emit(\'planReject\')"\n' +
  '              @plan-regenerate="emit(\'planRegenerate\')"\n' +
  '              @plan-update-step-title="handlePlanUpdateStepTitle"\n' +
  '              @plan-remove-step="handlePlanRemoveStep"\n' +
  '            />';

const entryViewNew =
  '            <template v-else-if="item.type === \'entry\'">\n' +
  '              <AiThreadEntryView\n' +
  '                :entry="item.entry"\n' +
  '                :open="entryExpansion.isExpanded(item.entry)"\n' +
  '                :workspace-root-path="workspaceRootPath"\n' +
  '                :plan-details="planDetails"\n' +
  '                :reverting-changed-files-summary-id="revertingChangedFilesSummaryId"\n' +
  '                :pinning-changed-files-summary-id="pinningChangedFilesSummaryId"\n' +
  '                @update:open="entryExpansion.setExpanded(item.entry, $event)"\n' +
  '                @changed-files-rollback="handleChangedFilesRollback"\n' +
  '                @changed-files-pin="handleChangedFilesPin"\n' +
  '                @plan-approve="emit(\'planApprove\')"\n' +
  '                @plan-reject="emit(\'planReject\')"\n' +
  '                @plan-regenerate="emit(\'planRegenerate\')"\n' +
  '                @plan-update-step-title="handlePlanUpdateStepTitle"\n' +
  '                @plan-remove-step="handlePlanRemoveStep"\n' +
  '              />\n' +
  '\n' +
  '              <slot\n' +
  '                v-if="afterMessageByEntryId.get(item.entry.id)"\n' +
  '                name="after-message"\n' +
  '                :message="afterMessageByEntryId.get(item.entry.id)"\n' +
  '              />\n' +
  '            </template>';

edit(THREAD, [
  [scriptAnchor, scriptInsert],
  [entryViewOld, entryViewNew],
]);

// ── 2) AiChatThread.entries.spec.ts ────────────────────────────────────
const SPEC = 'src/components/business/ai/chat/AiChatThread.entries.spec.ts';

const specAnchor =
  "    expect(wrapper.text()).toContain('还没有对话');\n" +
  '  });\n' +
  '});';

const specInsert =
  "    expect(wrapper.text()).toContain('还没有对话');\n" +
  '  });\n' +
  '\n' +
  "  it('entries 模式下按消息边界渲染 after-message 插槽(检查点)', () => {\n" +
  '    const wrapper = mount(AiChatThread, {\n' +
  '      props: {\n' +
  '        messages: [\n' +
  "          { id: 'a1', role: 'assistant', content: '回复', createdAt: '', references: [] },\n" +
  '        ],\n' +
  '        isTyping: false,\n' +
  '        renderFromEntries: true,\n' +
  '        threadEntries: [],\n' +
  "        platformId: 'deepseek',\n" +
  "        providerLabel: 'DeepSeek',\n" +
  '      },\n' +
  '      slots: {\n' +
  "        'after-message': (slotProps: { message: { id: string } }) =>\n" +
  "          h('div', { class: 'after-msg', 'data-message-id': slotProps.message.id }, 'checkpoint'),\n" +
  '      },\n' +
  '      global: { stubs },\n' +
  '    });\n' +
  '\n' +
  "    const afterNodes = wrapper.findAll('.after-msg');\n" +
  '    expect(afterNodes).toHaveLength(1);\n' +
  "    expect(afterNodes[0]?.attributes('data-message-id')).toBe('a1');\n" +
  '  });\n' +
  '});';

edit(SPEC, [[specAnchor, specInsert]]);

console.log(CHECK ? '\n[check] 8.1a 干跑完成。' : '\n[done] 8.1a 已写入。');