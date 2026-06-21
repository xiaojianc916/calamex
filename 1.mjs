// step4-unify-reasoning-ui.mjs
// SOP 第4步「统一 UI」：删除孤儿组件 AiReasoningCodeBlock.vue 及其桶导出。
// 行为等价：该组件已无任何 import（推理渲染走 AiThreadReasoning→AiMarkdown）。
// 用法：
//   node step4-unify-reasoning-ui.mjs           # dry-run（默认，不写盘）
//   node step4-unify-reasoning-ui.mjs --apply   # 实际改写 + 删除
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

/** 字符串替换：每条 find 必须在文件中恰好命中 1 次，否则整批中止。 */
const edits = [
  {
    file: 'src/components/business/ai/chat/index.ts',
    replacements: [
      {
        find:
          "export { default as AiPromptInput } from './AiPromptInput.vue';\n" +
          "export { default as AiReasoningCodeBlock } from './AiReasoningCodeBlock.vue';\n",
        to: "export { default as AiPromptInput } from './AiPromptInput.vue';\n",
      },
    ],
  },
];

/** 待删除文件（确认无引用后移除）。 */
const deletes = ['src/components/business/ai/chat/AiReasoningCodeBlock.vue'];

let failed = false;
const planned = [];

// ── 1) 校验所有字符串替换（不写盘）──
for (const { file, replacements } of edits) {
  if (!existsSync(file)) {
    console.error(`✗ 缺少文件: ${file}`);
    failed = true;
    continue;
  }
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');

  for (const { find, to } of replacements) {
    const count = text.split(find).length - 1;
    if (count !== 1) {
      console.error(`✗ ${file}: 期望命中 1 次，实际 ${count} 次\n--- find ---\n${find}\n------------`);
      failed = true;
      continue;
    }
    text = text.replace(find, to);
  }
  planned.push({ file, out: crlf ? text.replace(/\n/g, '\r\n') : text, changed: text !== raw.replace(/\r\n/g, '\n') });
}

// ── 2) 校验删除目标 ──
for (const file of deletes) {
  if (!existsSync(file)) {
    console.error(`✗ 待删除文件不存在: ${file}`);
    failed = true;
  }
}

if (failed) {
  console.error('\n⛔ 校验失败，未写入任何改动（原子中止）。');
  process.exit(1);
}

// ── 3) 应用 ──
if (!APPLY) {
  console.log('🔍 dry-run 通过：');
  for (const { file, changed } of planned) console.log(`  • 改写 ${file}${changed ? '' : '（无变化）'}`);
  for (const file of deletes) console.log(`  • 删除 ${file}`);
  console.log('\n加 --apply 实际执行。');
  process.exit(0);
}

for (const { file, out } of planned) writeFileSync(file, out);
for (const file of deletes) unlinkSync(file);
console.log('✅ 已应用：桶导出已移除，孤儿组件已删除。');