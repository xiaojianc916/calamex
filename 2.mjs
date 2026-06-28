// fix-workspace-fs-stat.mjs
// 用途：消除目录列举对每个普通文件的多余 stat 系统调用，只对符号链接 follow metadata。
// 健壮性：正则容忍缩进/空白漂移；幂等（已应用则跳过）；锚点缺失则跳过并报告，不破坏文件。
// 运行：在仓库根目录执行  node fix-workspace-fs-stat.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILE = 'src-tauri/src/commands/workspace_fs.rs';
const GUARD = 'file_type.is_symlink()';
const path = resolve(process.cwd(), FILE);

let src;
try {
  src = await readFile(path, 'utf8');
} catch (err) {
  console.error(`✗ 读取失败: ${FILE} (${err.message})`);
  process.exit(1);
}

if (src.includes(GUARD)) {
  console.log('• 跳过（已应用）: is_workspace_directory_entry 仅对符号链接 stat');
  process.exit(0);
}

// 只锚定那一行布尔表达式（容忍缩进），把它替换为按 file_type 分流的函数体。
const bodyRe =
  /^([ \t]*)file_type\.is_dir\(\) \|\| fs::metadata\(path\)\.is_ok_and\(\|metadata\| metadata\.is_dir\(\)\)\n/m;
const match = src.match(bodyRe);
if (!match) {
  console.error('✗ 锚点未匹配：未找到 is_workspace_directory_entry 的布尔表达式行。');
  console.error('  请把本地该函数贴出来，我据实重排锚点（避免猜测）。');
  process.exit(1);
}

const indent = match[1]; // 函数体缩进（应为 4 空格）
const replacement =
  `${indent}// 普通文件 / 目录直接信任 read_dir 返回的类型，零额外 syscall；\n` +
  `${indent}// 仅符号链接才需 follow 一次 metadata，判断其目标是否为目录。\n` +
  `${indent}if file_type.is_dir() {\n` +
  `${indent}    return true;\n` +
  `${indent}}\n` +
  `${indent}if file_type.is_symlink() {\n` +
  `${indent}    return fs::metadata(path).is_ok_and(|metadata| metadata.is_dir());\n` +
  `${indent}}\n` +
  `${indent}false\n`;

const next = src.replace(bodyRe, replacement);
if (next === src) {
  console.error('✗ 未发生替换（异常），未写入。');
  process.exit(1);
}

await writeFile(path, next, 'utf8');
console.log('✓ 已应用: is_workspace_directory_entry 仅对符号链接 stat');
console.log('\n建议验证：');
console.log('  cargo test -p <crate> workspace_fs   # 现有 symlink/dir 分类用例应全绿');