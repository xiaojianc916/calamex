#!/usr/bin/env node
// 幂等 codemod：把 AcpApprovalOverlay 挂载进 AiAssistantPanel.vue
// （ADR-20260617 D6 ACP 工具调用审批，slice 6b-3c-c）。
//
// 用法：
//   node scripts/apply-acp-approval-overlay.mjs
//
// 背景：AiAssistantPanel.vue 辑 ~49KB，直接全文重写易损坏，故用锁点字符串
// 定位后最小插入。重复执行安全：三处（import / 模板 / 样式）任一已存在则
// 跳过该处；锁点缺失则报错退出（避免静默失败）。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../src/components/business/ai/shell/AiAssistantPanel.vue');

// —— 锁点与插入片段 ——
const IMPORT_ANCHOR =
  "import AiThreadRunStatusBar from '@/components/business/ai/thread/AiThreadRunStatusBar.vue';";
const IMPORT_LINE =
  "import AcpApprovalOverlay from '@/components/business/ai/thread/AcpApprovalOverlay.vue';";

// AiThreadRunStatusBar 元素的唯一尾部；在其后插入浮层。
const TEMPLATE_ANCHOR = '@resolve="handleResolveToolConfirmation" />';
const TEMPLATE_INSERT = '\n        <AcpApprovalOverlay class="ai-composer-acp-approval" />';

const STYLE_ANCHOR =
  '.ai-composer-shell :global(.ai-composer) {\n  background: var(--ai-composer-surface);\n  padding: 0 10px 10px;\n}';
const STYLE_INSERT = '\n\n.ai-composer-acp-approval {\n  padding: 0 10px 8px;\n}';

let source = readFileSync(target, 'utf8');
const changes = [];

// 1) import
if (source.includes(IMPORT_LINE)) {
  console.log('skip: import 已存在');
} else {
  if (!source.includes(IMPORT_ANCHOR)) {
    throw new Error(`未找到 import 锁点：${IMPORT_ANCHOR}`);
  }
  source = source.replace(IMPORT_ANCHOR, `${IMPORT_LINE}\n${IMPORT_ANCHOR}`);
  changes.push('import');
}

// 2) 模板挂载
if (source.includes('<AcpApprovalOverlay')) {
  console.log('skip: 模板挂载已存在');
} else {
  if (!source.includes(TEMPLATE_ANCHOR)) {
    throw new Error(`未找到模板锁点：${TEMPLATE_ANCHOR}`);
  }
  source = source.replace(TEMPLATE_ANCHOR, `${TEMPLATE_ANCHOR}${TEMPLATE_INSERT}`);
  changes.push('template');
}

// 3) 样式
if (source.includes('.ai-composer-acp-approval {')) {
  console.log('skip: 样式已存在');
} else {
  if (!source.includes(STYLE_ANCHOR)) {
    throw new Error('未找到样式锁点：.ai-composer-shell :global(.ai-composer)');
  }
  source = source.replace(STYLE_ANCHOR, `${STYLE_ANCHOR}${STYLE_INSERT}`);
  changes.push('style');
}

if (changes.length === 0) {
  console.log('无改动：AcpApprovalOverlay 已全部挂载。');
} else {
  writeFileSync(target, source, 'utf8');
  console.log(`已注入：${changes.join(', ')} → ${target}`);
}
