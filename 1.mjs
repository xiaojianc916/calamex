#!/usr/bin/env node
// optimize-calamex-r3.mjs
// 第三批：useDocumentNavigationHistory.ts 死代码清理 + 类型标注修正（F10/F11）。
// 安全设计同前：纯锚点替换；幂等；--dry-run 预演；--revert 回滚；锚点缺失/歧义即非零退出。
// 用法：node optimize-calamex-r3.mjs [--dry-run] [--revert]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const REVERT = process.argv.includes('--revert');
const b = (...lines) => lines.join('\n');

const TARGETS = [
  {
    file: 'src/composables/useDocumentNavigationHistory.ts',
    edits: [
      {
        label: 'F11 补充 type Ref 导入',
        from: "import { ref } from 'vue';",
        to: "import { ref, type Ref } from 'vue';",
      },
      {
        label: 'F11 修正 pickNavigableFromStack 的 stack 类型标注',
        from: '    stack: ReturnType<typeof backStack>,',
        to: '    stack: Ref<string[]>,',
      },
      {
        label: 'F10 删除未使用的 getBackStack / getForwardStack 死代码',
        from: b(
          '  const canGoForward = (): boolean => forwardStack.value.length > 0;',
          '',
          '  const getBackStack = () => backStack;',
          '  const getForwardStack = () => forwardStack;',
          '',
          '  /** 检查导航栈中是否有可用的目标（跳过已关闭的文档）。 */',
        ),
        to: b(
          '  const canGoForward = (): boolean => forwardStack.value.length > 0;',
          '',
          '  /** 检查导航栈中是否有可用的目标（跳过已关闭的文档）。 */',
        ),
      },
    ],
  },
];

const tally = { applied: [], skipped: [], missing: [], ambiguous: [] };

function applyEdit(content, from, to, label) {
  const toInFrom = from.includes(to);
  const alreadyApplied = toInFrom ? !content.includes(from) : content.includes(to);
  if (alreadyApplied) {
    tally.skipped.push(label);
    return content;
  }
  const first = content.indexOf(from);
  if (first === -1) {
    tally.missing.push(label);
    return content;
  }
  if (content.indexOf(from, first + from.length) !== -1) {
    tally.ambiguous.push(label);
    return content;
  }
  tally.applied.push(label);
  return content.slice(0, first) + to + content.slice(first + from.length);
}

for (const target of TARGETS) {
  const abs = resolve(process.cwd(), target.file);
  if (!existsSync(abs)) {
    tally.missing.push(`${target.file}（文件不存在，请在仓库根目录运行）`);
    continue;
  }
  const original = readFileSync(abs, 'utf8');
  let content = original;
  for (const edit of target.edits) {
    const from = REVERT ? edit.to : edit.from;
    const to = REVERT ? edit.from : edit.to;
    content = applyEdit(content, from, to, `${target.file} :: ${edit.label}`);
  }
  if (content !== original && !DRY_RUN) {
    writeFileSync(abs, content, 'utf8');
  }
}

const mode = `${REVERT ? '回滚' : '应用'}${DRY_RUN ? '（预演 dry-run，未写盘）' : ''}`;
console.log(`\n=== calamex 第三批优化 ${mode} ===`);
const line = (emoji, title, arr) => {
  if (arr.length === 0) return;
  console.log(`\n${emoji} ${title}（${arr.length}）`);
  for (const x of arr) console.log(`   - ${x}`);
};
line('✅', REVERT ? '已回滚' : '已应用', tally.applied);
line('⏭️', '已是目标状态，跳过', tally.skipped);
line('⚠️', '锚点缺失（可能版本已变）', tally.missing);
line('⛔', '锚点不唯一，已拒绝替换', tally.ambiguous);
console.log(
  `\n小计：应用 ${tally.applied.length}｜跳过 ${tally.skipped.length}｜缺失 ${tally.missing.length}｜歧义 ${tally.ambiguous.length}\n`,
);
process.exit(tally.missing.length + tally.ambiguous.length > 0 ? 1 : 0);