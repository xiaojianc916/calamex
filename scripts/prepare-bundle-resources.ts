#!/usr/bin/env node

// scripts/prepare-bundle-resources.ts
//
// 打包前置（beforeBundleCommand）：【纯复制、零联网、零安装】。
// 把 provision 产好的 .provision/ 镜像到 src-tauri/resources-bundle/。
// 缺产物直接报错并提示先跑 pnpm provision。
//
// 产物布局（必须与 Rust bundled_resource_roots() 对齐）：
//   resources-bundle/node/node.exe
//   resources-bundle/builtin-agent/{package.json,src,dist,node_modules}
//   resources-bundle/lsp/node_modules/bash-language-server/out/cli.js
//   resources-bundle/shellcheck.exe
//   resources-bundle/shfmt.exe  （可选）

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const provisionRoot = join(repoRoot, '.provision');
const stageRoot = join(repoRoot, 'src-tauri', 'resources-bundle');

const isWindows = process.platform === 'win32';
const nodeExeName = isWindows ? 'node.exe' : 'node';
const shellcheckExeName = isWindows ? 'shellcheck.exe' : 'shellcheck';
const shfmtExeName = isWindows ? 'shfmt.exe' : 'shfmt';

function log(message: string): void {
  console.log('[prepare-bundle-resources] ' + message);
}
function fail(message: string): never {
  console.error('[prepare-bundle-resources] FAILED: ' + message);
  process.exit(1);
}
function requireArtifact(path: string): void {
  if (!existsSync(path)) fail('缺少 provision 产物：' + path + '\n请先运行：pnpm provision');
}
function resetStage(): void {
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  writeFileSync(join(stageRoot, '.gitignore'), '*\n!.gitignore\n');
}
function copyTree(name: string): void {
  cpSync(join(provisionRoot, name), join(stageRoot, name), { recursive: true });
}
function main(): void {
  if (!existsSync(provisionRoot)) fail('未找到 .provision/。请先运行：pnpm provision');
  log('staging 根目录：' + stageRoot);
  resetStage();

  requireArtifact(join(provisionRoot, 'node', nodeExeName));
  copyTree('node');
  log('已复制 Node 运行时');

  requireArtifact(join(provisionRoot, 'builtin-agent', 'package.json'));
  requireArtifact(join(provisionRoot, 'builtin-agent', 'node_modules'));
  requireArtifact(join(provisionRoot, 'builtin-agent', 'dist', 'acp', 'stdio-entry.js'));
  copyTree('builtin-agent');
  log('已复制 builtin-agent（含 dist 与生产依赖）');

  requireArtifact(
    join(provisionRoot, 'lsp', 'node_modules', 'bash-language-server', 'out', 'cli.js'),
  );
  copyTree('lsp');
  log('已复制 bash-language-server');

  requireArtifact(join(provisionRoot, 'bin', shellcheckExeName));
  copyFileSync(join(provisionRoot, 'bin', shellcheckExeName), join(stageRoot, shellcheckExeName));
  log('已复制 shellcheck');

  const shfmtSrc = join(provisionRoot, 'bin', shfmtExeName);
  if (existsSync(shfmtSrc)) {
    copyFileSync(shfmtSrc, join(stageRoot, shfmtExeName));
    log('已复制 shfmt');
  } else {
    log('WARN 未见 shfmt 产物（非致命，运行时退回系统/WSL）');
  }

  log('OK 资源 staging 完成（纯复制）');
}

main();
