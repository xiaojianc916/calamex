// scripts/disable-all-vapor-flags.mjs
// 用法：node scripts/disable-all-vapor-flags.mjs
//
// 作用：
// - 一次性移除 src/**/*.vue 里的 vapor 标记
// - 删除之前脚本插入的空 <script setup vapor lang="ts"></script>
// - 把 src/app/main.ts 里可能残留的 createVaporApp 改回 createApp
// - 不改 Vue 版本
// - 不改 package.json
// - 不改 pnpm-lock.yaml
//
// 原因：当前 vue@3.6.0-beta.16 不导出 defineVaporComponent，任何 Vapor SFC 被 import 都会炸。

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const repoRoot = process.cwd();
const srcRoot = resolve(repoRoot, 'src');
const mainEntry = resolve(repoRoot, 'src/app/main.ts');

const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'target']);

const toPosixPath = (path) => path.replaceAll('\\', '/');

const walkVueFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }

    const absolutePath = join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkVueFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && extname(entry.name) === '.vue') {
      files.push(absolutePath);
    }
  }

  return files;
};

const removeInjectedEmptyVaporScript = (content) =>
  content.replace(
    /^<script\s+setup\s+vapor\s+lang=(["'])ts\1>\s*<\/script>\s*\r?\n\r?\n/i,
    '',
  );

const removeVaporFromScriptTags = (content) =>
  content.replace(/<script\b[^>]*>/gi, (tag) => {
    if (!/\bvapor\b/.test(tag)) {
      return tag;
    }

    return tag
      .replace(/\s+vapor(?=[\s>])/g, '')
      .replace(/\s+>/g, '>')
      .replace(/<script\s+/, '<script ');
  });

const patchVueFile = async (absolutePath) => {
  const original = await readFile(absolutePath, 'utf8');

  let next = original;
  next = removeInjectedEmptyVaporScript(next);
  next = removeVaporFromScriptTags(next);

  if (next === original) {
    return false;
  }

  await writeFile(absolutePath, next, 'utf8');
  return true;
};

const patchMainEntry = async () => {
  if (!existsSync(mainEntry)) {
    return false;
  }

  const original = await readFile(mainEntry, 'utf8');

  if (!original.includes('createVaporApp')) {
    return false;
  }

  const next = original.replaceAll('createVaporApp', 'createApp');
  await writeFile(mainEntry, next, 'utf8');

  return true;
};

const main = async () => {
  const changed = [];

  for (const file of await walkVueFiles(srcRoot)) {
    const didChange = await patchVueFile(file);

    if (didChange) {
      changed.push(toPosixPath(relative(repoRoot, file)));
    }
  }

  const mainChanged = await patchMainEntry();

  if (mainChanged) {
    changed.push('src/app/main.ts');
  }

  console.log(`已彻底禁用 Vapor 标记，修改文件数：${changed.length}`);

  if (changed.length > 0) {
    console.log('\nchanged:');
    for (const file of changed) {
      console.log(`- ${file}`);
    }
  }

  console.log('\n确认没有残留：');
  console.log('rg "\\bvapor\\b|defineVaporComponent|createVaporApp" src');

  console.log('\n验证：');
  console.log('pnpm test');
  console.log('pnpm typecheck');
  console.log('pnpm build');

  console.log('\n结论：');
  console.log('当前 vue@3.6.0-beta.16 不导出 defineVaporComponent，不能启用 <script setup vapor>。');
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});