#!/usr/bin/env node
// fix-active-agent-message-id.mjs
// 修复 AiAssistantPanel 渲染崩溃：模板用 assistant.activeAgentMessageId.value，
// 但 useAiAssistant 未导出该内部 ref（return 里漏了），导致 reading 'value' of undefined。
// 仅在公共导出对象补出 activeAgentMessageId（内部已存在该 ref，无需新增声明）。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = 'src/composables/ai/useAiAssistant.ts';

const FIND = ['    restoringCheckpointId,', '    sendButtonLabel,'].join('\n');
const REPLACE = [
  '    restoringCheckpointId,',
  '    activeAgentMessageId,',
  '    sendButtonLabel,',
].join('\n');

const abs = resolve(process.cwd(), FILE);
let content = readFileSync(abs, 'utf8');

if (content.includes(REPLACE)) {
  console.log(`[跳过] ${FILE} :: activeAgentMessageId 已在导出中`);
  process.exit(0);
}

const first = content.indexOf(FIND);
if (first === -1) {
  throw new Error(`[${FILE}] 未找到导出锚点（restoringCheckpointId / sendButtonLabel）`);
}
if (content.indexOf(FIND, first + FIND.length) !== -1) {
  throw new Error(`[${FILE}] 导出锚点不唯一，已中止`);
}

content = content.slice(0, first) + REPLACE + content.slice(first + FIND.length);
writeFileSync(abs, content, 'utf8');
console.log(`[改] ${FILE} :: 导出补齐 activeAgentMessageId`);
console.log('完成。');