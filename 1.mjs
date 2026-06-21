#!/usr/bin/env node
// apply-kimi-modes-trigger.mjs
// 补齐 Kimi 内置模式选择器的加载触发：挂载即 kimi / 会话切换 / 每轮回复结束后重新 loadModes。
// 用法：node apply-kimi-modes-trigger.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY = process.argv.includes('--dry');
const ROOT = process.cwd();
const TARGET = 'src/components/business/ai/shell/AiAssistantPanel.vue';

const blockLines = [
  '// Kimi 默认即为当前会话后端，但 loadModes 此前仅在「手动切到 kimi」时触发；',
  '// 这里补齐：挂载即 kimi、会话切换、以及每轮回复结束（此时 ACP 会话已建立）后',
  '// 重新拉取内置模式，确保 availableModes 非空、模式选择器能正常替换硬编码菜单。',
  'const refreshKimiSessionModes = (): void => {',
  "  if (sessionAgentBackend.value !== 'kimi') {",
  '    return;',
  '  }',
  '',
  '  const threadId = assistant.activeConversationId.value;',
  '',
  '  if (!threadId) {',
  '    return;',
  '  }',
  '',
  '  void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);',
  '  void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);',
  '};',
  '',
  'watch(',
  '  () =>',
  '    [',
  '      sessionAgentBackend.value,',
  '      assistant.activeConversationId.value,',
  '      assistant.isSending.value,',
  '    ] as const,',
  '  ([backend, threadId, isSending], previous) => {',
  "    if (backend !== 'kimi' || !threadId || isSending) {",
  '      return;',
  '    }',
  '',
  '    const backendChanged = !previous || previous[0] !== backend;',
  '    const threadChanged = !previous || previous[1] !== threadId;',
  '    const sendingJustFinished = Boolean(previous) && previous[2] === true;',
  '',
  '    if (backendChanged || threadChanged || sendingJustFinished) {',
  '      refreshKimiSessionModes();',
  '    }',
  '  },',
  '  { immediate: true },',
  ');',
];

const edits = [
  {
    label: 'import watch from vue',
    marker: 'defineAsyncComponent, onMounted, ref, watch }',
    old: "import { computed, defineAsyncComponent, onMounted, ref } from 'vue';",
    new: "import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';",
  },
  {
    label: 'insert refreshKimiSessionModes + watch',
    marker: 'const refreshKimiSessionModes',
    anchor: '// ACP 会话配置项切换（config_options 全量迁移发送侧）：选择器回投透传给',
  },
];

const path = resolve(ROOT, TARGET);
let content = readFileSync(path, 'utf8');
const eol = content.includes('\r\n') ? '\r\n' : '\n';
let edited = 0;
let skipped = 0;

for (const edit of edits) {
  if (content.includes(edit.marker)) {
    console.log(`SKIP  ${edit.label} (marker present)`);
    skipped += 1;
    continue;
  }

  let oldStr;
  let newStr;
  if (edit.anchor) {
    oldStr = edit.anchor;
    newStr = blockLines.join(eol) + eol + eol + edit.anchor;
  } else {
    oldStr = edit.old;
    newStr = edit.new;
  }

  const count = content.split(oldStr).length - 1;
  if (count !== 1) {
    console.error(`FAIL  ${edit.label} (${count} matches, expected 1)`);
    process.exit(1);
  }

  content = content.split(oldStr).join(newStr);
  console.log(`EDIT  ${edit.label}`);
  edited += 1;
}

if (DRY) {
  console.log(`DRY   edited=${edited} skipped=${skipped} (no write)`);
} else if (edited > 0) {
  writeFileSync(path, content, 'utf8');
  console.log(`WROTE ${TARGET} edited=${edited} skipped=${skipped}`);
} else {
  console.log(`NOOP  edited=${edited} skipped=${skipped}`);
}