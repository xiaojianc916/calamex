#!/usr/bin/env node
// probe-tree-sitter-build.mjs — 阶段① 第0步：验证 tree-sitter-cli@0.26 构建链路，编一个样例 wasm。
// 只写 ./.ts-build-probe/，可删。用法：node probe-tree-sitter-build.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const isWin = process.platform === 'win32';
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', shell: isWin, cwd: process.cwd() })
      .toString().trim();
  } catch (e) {
    return `ERR: ${(e.stderr?.toString() || e.message || '').toString().trim().split('\n')[0]}`;
  }
};

console.log('== 阶段① 构建链路探测（web-tree-sitter@0.26 需要 ABI 匹配的 wasm）==');
console.log('tree-sitter CLI :', run('pnpm', ['exec', 'tree-sitter', '--version']));
console.log('docker          :', run('docker', ['--version']));
console.log('emcc            :', (run('emcc', ['--version']) || '').split('\n')[0]);

const grammarDir = join('node_modules', 'tree-sitter-bash');
if (!existsSync(join(process.cwd(), grammarDir, 'grammar.js'))) {
  console.log(`\n⚠ 未找到 ${grammarDir}/grammar.js（语法源）。请先 pnpm i 后重试。`);
  process.exit(0);
}

console.log('\n构建 bash → wasm（首次会拉 emscripten/emsdk docker 镜像，可能较慢）…');
console.log(run('pnpm', ['exec', 'tree-sitter', 'build', '--wasm', grammarDir]) || '(无 stdout)');

// tree-sitter build --wasm 默认在 cwd 产出 tree-sitter-bash.wasm
const wasm = join(process.cwd(), 'tree-sitter-bash.wasm');
if (existsSync(wasm)) {
  console.log(`\n✅ 构建成功：tree-sitter-bash.wasm（${statSync(wasm).size} 字节）`);
  console.log('   链路可用。把这整段输出发我 → 我接下来交付：');
  console.log('   provision 里「按锁定清单 tree-sitter build 全部语法 wasm」+ 逐语言 highlights/folds/indents 查询 + 重写 language-registry 生成器。');
} else {
  console.log('\n🔴 未产出 wasm。把上面 tree-sitter/docker/emcc 三行 + 构建报错发我，');
  console.log('   我据此调整（装 emscripten 的具体步骤，或退回「逐语言官方预编译 wasm」的 Option B 兜底）。');
}