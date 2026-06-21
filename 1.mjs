// fix-from-sidecar-spec-name.mjs
// 对齐 from-sidecar-events.spec：tool_started 现透传原始 name（Option B「补全 name」），
// 两处期望补 name 字段。纯测试对齐，零生产改动。
// 用法：
//   node fix-from-sidecar-spec-name.mjs           # 预演
//   node fix-from-sidecar-spec-name.mjs --apply   # 写盘
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

const edits = [
  {
    file: 'src/components/business/ai/thread/projection/from-sidecar-events.spec.ts',
    replacements: [
      {
        // 用例：工具开始（read_file，toolName 变量）
        find: `        title: describeToolAction(started, toolName).action,
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(toolName)],`,
        to: `        title: describeToolAction(started, toolName).action,
        name: toolName,
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind(toolName)],`,
      },
      {
        // 用例：缺 toolUseId 回退（grep 字面量）
        find: `        title: describeToolAction(started, 'grep').action,
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind('grep')],`,
        to: `        title: describeToolAction(started, 'grep').action,
        name: 'grep',
        toolKind: RUNTIME_KIND_TO_TOOL_KIND[classifyRuntimeToolKind('grep')],`,
      },
    ],
  },
];

const results = [];
const outputs = [];
let hadError = false;

for (const { file, replacements } of edits) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    hadError = true;
    results.push(`✗ ${file}: 读取失败 (${e.message})`);
    continue;
  }
  const crlf = raw.includes('\r\n');
  let text = crlf ? raw.replace(/\r\n/g, '\n') : raw;
  let fileOk = true;
  for (let i = 0; i < replacements.length; i += 1) {
    const { find, to } = replacements[i];
    const count = text.split(find).length - 1;
    if (count !== 1) {
      hadError = true;
      fileOk = false;
      results.push(`✗ ${file} [替换#${i + 1}]: 期望命中 1 次，实际 ${count} 次`);
      continue;
    }
    text = text.replace(find, () => to);
  }
  if (!fileOk) continue;
  outputs.push({ file, out: crlf ? text.replace(/\n/g, '\r\n') : text, n: replacements.length });
  results.push(`• ${file}: 校验通过 (${replacements.length} 处)`);
}

console.log(results.join('\n'));

if (hadError) {
  console.error('\n存在未命中，已全部中止（未写盘）。');
  process.exit(1);
}
if (!APPLY) {
  console.log('\n预演通过（dry-run）。加 --apply 实际写盘。');
  process.exit(0);
}
for (const { file, out, n } of outputs) {
  writeFileSync(file, out, 'utf8');
  console.log(`✓ 已写入 ${file} (${n} 处)`);
}
console.log('\n完成。请运行 pnpm vitest run 与 pnpm -s vue-tsc --noEmit 验证。');