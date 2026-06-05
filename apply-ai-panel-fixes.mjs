#!/usr/bin/env node
// apply-ai-panel-fixes.mjs — AiAssistantPanel.vue 代码审查修复 (P1/P2/P5/P8)
// 用法:
//   node apply-ai-panel-fixes.mjs "D:\\com.xiaojianc\\my_desktop_app" --dry
//   node apply-ai-panel-fixes.mjs "D:\\com.xiaojianc\\my_desktop_app"
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const root = process.argv[2];
const dry = process.argv.includes('--dry');
if (!root) {
  console.error('用法: node apply-ai-panel-fixes.mjs <仓库根目录> [--dry]');
  process.exit(1);
}

const FILE = 'src/components/business/ai/shell/AiAssistantPanel.vue';
const L = (arr) => arr.join('\n');

const edits = [
  // P1 — 移除 readPlanStoreValue 包裹(Pinia store 字段已自动解包,无需手搜 .value)
  { id: 'P1-unwrap-calls', file: FILE, unwrapCall: 'readPlanStoreValue' },
  {
    id: 'P1-remove-helper',
    file: FILE,
    find: [
      'const readPlanStoreValue = <T>(value: T | { value: T }): T => {',
      "  if (typeof value === 'object' && value !== null && 'value' in value) {",
      '    return value.value;',
      '  }',
      '',
      '  return value;',
      '};',
    ],
    replace: [''],
  },
  // P2 — 用直接赋值替代 Reflect.set(store 字段是 Pinia 普通 state)
  {
    id: 'P2-direct-assign',
    file: FILE,
    find: ["  Reflect.set(planStore.value, 'errorMessage', message);"],
    replace: ['  planStore.value.errorMessage = message;'],
  },
  // P5 — 常量正名:限制的是会话条数,不是消息数
  {
    id: 'P5-const-rename',
    file: FILE,
    find: ['const MAX_HISTORY_MESSAGES = 20;'],
    replace: ['const MAX_HISTORY_THREADS = 20;'],
  },
  {
    id: 'P5-usage-rename',
    file: FILE,
    find: ['  assistant.historyThreads.value.slice(-MAX_HISTORY_MESSAGES).reverse(),'],
    replace: ['  assistant.historyThreads.value.slice(-MAX_HISTORY_THREADS).reverse(),'],
  },
  // P8 — 模板里调用的方法改成 computed
  {
    id: 'P8-to-computed',
    file: FILE,
    find: [
      'const getDeleteDialogTitle = (): string => {',
      '  const thread = pendingDeleteThread.value;',
      '',
      '  if (!thread) {',
      "    return '删除对话记录？';",
      '  }',
      '',
      '  return `删除“${thread.title}”？`;',
      '};',
      '',
      'const getDeleteDialogDescription = (): string => {',
      '  const thread = pendingDeleteThread.value;',
      "  const messageCountLabel = thread ? getHistoryMessageCountLabel(thread.messages) : '这条记录';",
      '',
      '  return `只会删除这条对话记录（${messageCountLabel}）,不会删除文件或其他对话。`;',
      '};',
    ],
    replace: [
      'const deleteDialogTitle = computed<string>(() => {',
      '  const thread = pendingDeleteThread.value;',
      '',
      '  if (!thread) {',
      "    return '删除对话记录？';",
      '  }',
      '',
      '  return `删除“${thread.title}”？`;',
      '});',
      '',
      'const deleteDialogDescription = computed<string>(() => {',
      '  const thread = pendingDeleteThread.value;',
      "  const messageCountLabel = thread ? getHistoryMessageCountLabel(thread.messages) : '这条记录';",
      '',
      '  return `只会删除这条对话记录（${messageCountLabel}）,不会删除文件或其他对话。`;',
      '});',
    ],
  },
  {
    id: 'P8-template',
    file: FILE,
    find: [
      '              <h3 v-text="getDeleteDialogTitle()"></h3>',
      '              <p v-text="getDeleteDialogDescription()"></p>',
    ],
    replace: [
      '              <h3 v-text="deleteDialogTitle"></h3>',
      '              <p v-text="deleteDialogDescription"></p>',
    ],
  },
];

let hit = 0;
let fail = 0;
const byFile = new Map();
for (const e of edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

for (const [rel, list] of byFile) {
  const abs = isAbsolute(rel) ? rel : join(root, rel);
  if (!existsSync(abs)) {
    console.error(`✗ 文件不存在: ${rel}`);
    fail += list.length;
    continue;
  }
  const original = readFileSync(abs, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  let working = eol === '\r\n' ? original.split('\r\n').join('\n') : original;
  let changed = false;
  for (const e of list) {
    if (e.unwrapCall) {
      const open = `${e.unwrapCall}(`;
      let count = 0;
      let idx = working.indexOf(open);
      while (idx !== -1) {
        const close = working.indexOf(')', idx + open.length);
        if (close === -1) break;
        const inner = working.slice(idx + open.length, close);
        working = working.slice(0, idx) + inner + working.slice(close + 1);
        count += 1;
        idx = working.indexOf(open);
      }
      if (count === 0) {
        console.error(`✗ [${e.id}] ${rel}: 未找到 ${open}`);
        fail += 1;
      } else {
        changed = true;
        hit += 1;
        console.log(`✓ [${e.id}] ${rel} (${count} 处)`);
      }
      continue;
    }
    const find = L(e.find);
    const replace = L(e.replace);
    const n = working.split(find).length - 1;
    if (n === 0) {
      console.error(`✗ [${e.id}] ${rel}: 未找到匹配`);
      fail += 1;
      continue;
    }
    if (n > 1 && !e.all) {
      console.error(`✗ [${e.id}] ${rel}: 匹配到 ${n} 处(预期唯一),跳过`);
      fail += 1;
      continue;
    }
    working = working.split(find).join(replace);
    changed = true;
    hit += 1;
    console.log(`✓ [${e.id}] ${rel}`);
  }
  if (changed && !dry) {
    const out = eol === '\r\n' ? working.split('\n').join('\r\n') : working;
    if (!existsSync(abs + '.bak')) writeFileSync(abs + '.bak', original, 'utf8');
    writeFileSync(abs, out, 'utf8');
  }
}

console.log(`\n${dry ? '[DRY] ' : ''}命中 ${hit} / 失败 ${fail}(共 ${edits.length} 块)`);
process.exit(fail ? 1 : 0);