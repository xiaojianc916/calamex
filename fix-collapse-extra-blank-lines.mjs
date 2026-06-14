import fs from 'node:fs';
import path from 'node:path';

// 目标：清理本次改动引入的多余空行（连续 2 个以上空行压成 1 个）。
// 这些空行等价于 `cargo fmt` 会做的归一化，纯属噪声，无语义影响。
// 仅作用于确认过的两个文件，且只做"三连及以上换行 → 两连换行"这一种安全变换。

const root = process.cwd();
const targets = [
  'src-tauri/src/commands/ssh/hostkey.rs',
  'src-tauri/src/commands/ssh/transfer.rs',
];

const TRIPLE_PLUS_NEWLINES = /\n[ \t]*\n[ \t]*\n/g;

let changedCount = 0;

for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log(`- 跳过（不存在）${rel}`);
    continue;
  }

  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(TRIPLE_PLUS_NEWLINES, '\n\n');

  if (before === after) {
    console.log(`- 无变化 ${rel}`);
    continue;
  }

  fs.writeFileSync(file, after);
  changedCount += 1;
  console.log(`✓ 已清理多余空行 ${rel}`);
}

console.log(`\n完成：${changedCount} 个文件被更新。`);
console.log('建议执行：cd src-tauri && cargo fmt --check');
