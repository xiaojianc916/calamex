// fix-hotpath-perf.mjs
// 用途：对 calamex 两处经证据核实的热路径做最小、行为等价的性能修复。
//   1) src-tauri/src/terminal/shell_integration.rs —— filter() 增加“无 ESC 快路径”
//   2) src/utils/core/fuzzy-score.ts —— DP 外预计算只依赖位置的 boundaryBonus
// 特性：幂等（已改则跳过）、锚点校验（不匹配则跳过并报告，不破坏文件）、仅改实现不改行为。
// 运行：在仓库根目录执行  node fix-hotpath-perf.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ROOT = process.cwd();

/** @type {{file:string,label:string,guard:string,ops:Array<{find:string,replace:string,all?:boolean}>}[]} */
const EDITS = [
  {
    file: 'src-tauri/src/terminal/shell_integration.rs',
    label: 'shell_integration: filter() 无 ESC 快路径',
    guard: '!input.contains(ESC)',
    ops: [
      {
        find:
          '        let mut marks = Vec::new();\n' +
          '        for c in input.chars() {',
        replace:
          '        let mut marks = Vec::new();\n' +
          '\n' +
          '        // 快路径：Normal 态且无半截序列缓存时，本段不含 ESC 即不可能存在任何 OSC/转义\n' +
          '        // 序列，输出必然逐字节等同输入。整段拷贝，避免对最常见的纯文本输出（构建日志/\n' +
          '        // 程序 stdout，占绝大多数）逐字符 push，把每批 O(n) 次 push 降为一次 memcpy。\n' +
          '        if self.state == FilterState::Normal\n' +
          '            && self.pending.is_empty()\n' +
          '            && !input.contains(ESC)\n' +
          '        {\n' +
          '            out.push_str(input);\n' +
          '            return (out, marks);\n' +
          '        }\n' +
          '\n' +
          '        for c in input.chars() {',
      },
    ],
  },
  {
    file: 'src/utils/core/fuzzy-score.ts',
    label: 'fuzzy-score: DP 外预计算 boundaryBonus',
    guard: 'const boundaryBonus = new Float64Array(n)',
    ops: [
      {
        find:
          '  const n = text.length;\n' +
          '  const m = query.length;\n',
        replace:
          '  const n = text.length;\n' +
          '  const m = query.length;\n' +
          '  // 边界/驼峰位置奖励只依赖 text 下标，与 query 无关：在 O(n·m) DP 之前一次性预计算，\n' +
          '  // 避免在双层循环内对每个 (i, j) 重复调用 boundaryBonusAt（classifyChar）。\n' +
          '  const boundaryBonus = new Float64Array(n);\n' +
          '  for (let bi = 0; bi < n; bi++) {\n' +
          '    boundaryBonus[bi] = boundaryBonusAt(text, bi);\n' +
          '  }\n',
      },
      {
        find: 'Math.max(BONUS_CONSECUTIVE, boundaryBonusAt(text, i - 1))',
        replace: 'Math.max(BONUS_CONSECUTIVE, boundaryBonus[i - 1])',
      },
      {
        find: 'bonus = boundaryBonusAt(text, i - 1);',
        replace: 'bonus = boundaryBonus[i - 1];',
      },
    ],
  },
];

let hadError = false;

for (const edit of EDITS) {
  const path = resolve(ROOT, edit.file);
  let src;
  try {
    src = await readFile(path, 'utf8');
  } catch (err) {
    hadError = true;
    console.error(`✗ 读取失败: ${edit.file} (${err.message})`);
    continue;
  }

  if (src.includes(edit.guard)) {
    console.log(`• 跳过（已应用）: ${edit.label}`);
    continue;
  }

  // 先校验所有锚点都存在，避免“改一半”。
  const missing = edit.ops.filter((op) => !src.includes(op.find));
  if (missing.length > 0) {
    hadError = true;
    console.error(`✗ 锚点未匹配，跳过不改: ${edit.label}`);
    for (const op of missing) {
      console.error(`    缺少锚点: ${JSON.stringify(op.find.slice(0, 60))}…`);
    }
    continue;
  }

  let next = src;
  for (const op of edit.ops) {
    next = op.all ? next.split(op.find).join(op.replace) : next.replace(op.find, op.replace);
  }

  if (next === src) {
    console.log(`• 无变化: ${edit.label}`);
    continue;
  }

  await writeFile(path, next, 'utf8');
  console.log(`✓ 已应用: ${edit.label}`);
}

if (hadError) {
  console.error('\n部分条目因读取失败或锚点不匹配被跳过（文件未被破坏）。请核对后重跑。');
  process.exit(1);
}
console.log('\n全部完成。建议执行验证：');
console.log('  cargo test -p <crate> shell_integration   # 行为回归');
console.log('  pnpm vitest run src/utils/core/fuzzy-score.spec.ts');