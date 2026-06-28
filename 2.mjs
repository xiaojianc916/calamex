// fix-filter-fastpath.mjs
// 用途：给 shell_integration.rs 的 filter() 增加“无 ESC 快路径”。
// 健壮性：只锚定单行 `for c in input.chars() {`（容忍缩进），插入自包含代码块；
//        幂等（已应用则跳过）；锚点缺失则跳过并报告，不破坏文件。
// 运行：在仓库根目录执行  node fix-filter-fastpath.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const FILE = 'src-tauri/src/terminal/shell_integration.rs';
const GUARD = '!input.contains(ESC)';
const path = resolve(process.cwd(), FILE);

let src;
try {
  src = await readFile(path, 'utf8');
} catch (err) {
  console.error(`✗ 读取失败: ${FILE} (${err.message})`);
  process.exit(1);
}

if (src.includes(GUARD)) {
  console.log('• 跳过（已应用）: filter() 无 ESC 快路径');
  process.exit(0);
}

// 容忍缩进，定位 filter() 主循环这一行。
const loopRe = /^([ \t]*)for c in input\.chars\(\) \{/m;
const match = src.match(loopRe);
if (!match) {
  console.error('✗ 锚点未匹配：未找到 `for c in input.chars() {`。');
  console.error('  请把本地 filter() 函数体贴出来，我据实重排锚点（避免猜测）。');
  process.exit(1);
}

const indent = match[1]; // 该行实际缩进
const block =
  `${indent}// 快路径：Normal 态且无半截序列缓存时，本段不含 ESC 即不可能存在任何 OSC/转义\n` +
  `${indent}// 序列，输出必然逐字节等同输入。整段拷贝，避免对最常见的纯文本输出（构建日志/\n` +
  `${indent}// 程序 stdout，占绝大多数）逐字符 push，把每批 O(n) 次 push 降为一次 memcpy。\n` +
  `${indent}if self.state == FilterState::Normal\n` +
  `${indent}    && self.pending.is_empty()\n` +
  `${indent}    && !input.contains(ESC)\n` +
  `${indent}{\n` +
  `${indent}    out.push_str(input);\n` +
  `${indent}    return (out, marks);\n` +
  `${indent}}\n` +
  `\n`;

const next = src.replace(loopRe, block + match[0]);
if (next === src) {
  console.error('✗ 未发生替换（异常），未写入。');
  process.exit(1);
}

await writeFile(path, next, 'utf8');
console.log('✓ 已应用: filter() 无 ESC 快路径');
console.log('\n建议验证：');
console.log('  cargo test -p <crate> shell_integration   # 行为回归（剥离/保留语义不变）');