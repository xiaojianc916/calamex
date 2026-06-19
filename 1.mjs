#!/usr/bin/env node
/**
 * Calamex 代码优化脚本 — 自动化安全修改
 *
 * 处理项:
 *   🟡 #10: git.ts — 修复 requestIdleCallback 返回值类型 cast
 *   🟠 #6: tauri.git.ts — 浅层度量函数添加注释
 *
 * 不处理（需手动谨慎迁移）:
 *   🔴 #1: syncDocumentState → Object.assign（改动面广）
 *   🔴 #2: commitStatsCache 双重缓存消除（需验证 vue-query）
 *   🔴 #3: trimThreads 优化（需验证不变量）
 *   🟠 #4: findDocumentByPath 预计算（需改 IEditorDocument 类型）
 *   🟠 #5: useBrowserContextMenu 事件注册时机（需组件验证）
 *   🟠 #7: manualChunks 优化（构建时无运行时影响）
 *   🟠 #8: documents watcher 优化（改动 watch 语义）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

const ok = (msg) => console.log(`  ✅ ${msg}`);
const skip = (msg) => console.log(`  ⏭️  ${msg}`);
const fail = (msg) => console.error(`  ❌ ${msg}`);

console.log('\n🔧 Calamex 代码优化脚本');
console.log(DRY_RUN ? '   (DRY-RUN 模式)\n' : '\n');

let totalModified = 0;

// ── #10: git.ts — 修复 requestIdleCallback 类型 cast ──────────
console.log('── #10: git.ts requestIdleCallback 类型修复 ──');
{
  const gitStorePath = join(__dirname, 'src', 'store', 'git.ts');
  if (!existsSync(gitStorePath)) {
    fail(`文件不存在: ${gitStorePath}`);
  } else {
    let content = readFileSync(gitStorePath, 'utf-8');
    const oldCast =
      '      // 保存 idleId 以便 clearCommitStatsBackgroundQueue 取消。\n' +
      '      // 不支持 cancelIdleCallback 的环境（旧 WebView2）退化为 no-op。\n' +
      '      commitStatsTimer = idleId as unknown as ReturnType<typeof setTimeout>;\n' +
      '      return;';

    const newCast =
      '      // 保存 idleId 以便 clearCommitStatsBackgroundQueue 取消。\n' +
      '      // 使用 union type 正确保存 idle callback handle；\n' +
      '      // 不支持 cancelIdleCallback 的环境（旧 WebView2）退化为 no-op。\n' +
      '      commitStatsTimer = { kind: \'idle\', id: idleId } as unknown as TCommitStatsTimer;\n' +
      '      return;';

    if (!content.includes(oldCast)) {
      skip('#10: 未找到目标 cast 行（可能已修复）');
    } else {
      if (DRY_RUN) {
        console.log('  [DRY-RUN] #10: 将修复类型 cast');
      } else {
        content = content.replace(oldCast, newCast);
        writeFileSync(gitStorePath, content, 'utf-8');
        ok('#10: 已修复 idle callback 类型 cast');
      }
      totalModified++;
    }
  }
}

// ── #6: tauri.git.ts — 度量函数注释 ─────────────────────
console.log('\n── #6: tauri.git.ts 度量函数注释 ──');
{
  const gitMetricsPath = join(__dirname, 'src', 'services', 'tauri.git.ts');
  if (!existsSync(gitMetricsPath)) {
    fail(`文件不存在: ${gitMetricsPath}`);
  } else {
    let content = readFileSync(gitMetricsPath, 'utf-8');
    const marker =
      '// NOTE: 浅层字段遍历度量替代 JSON.stringify，避免对大 payload 的序列化开销。';
    const target = 'const measureGitCommitDetailOutput = (output: unknown) => {';

    if (content.includes(marker)) {
      skip('#6: 已有标记');
    } else if (!content.includes(target)) {
      skip('#6: 未找到目标函数');
    } else {
      if (DRY_RUN) {
        console.log('  [DRY-RUN] #6: 将添加注释');
      } else {
        content = content.replace(target, `${marker}\n${target}`);
        writeFileSync(gitMetricsPath, content, 'utf-8');
        ok('#6: 已添加注释标记');
      }
      totalModified++;
    }
  }
}

// ── 总结 ─────────────────────────────────────────────
console.log('\n' + '═'.repeat(50));
console.log(`  共修改 ${totalModified} 个文件${DRY_RUN ? ' (DRY-RUN)' : ''}`);
console.log('═'.repeat(50));

// ── 需手动处理的项目 ─────────────────────────────────
console.log('\n📋 需手动处理的高优先级项（不可自动化）：\n');
console.log('  🔴 #1: editor.ts syncDocumentState → Object.assign 批量赋值');
console.log('     → 用 Object.assign(target, {}) 替代逐行赋值，减少 trigger 次数');
console.log('     → 验证: pnpm typecheck && pnpm test\n');
console.log('  🔴 #2: git.ts commitStatsCache → 移除 ref 镜像');
console.log('     → getCommitStats 改为直接 queryClient.getQueryData');
console.log('     → 验证: pnpm typecheck && pnpm test\n');
console.log('  🔴 #3: aiConversation.ts trimThreads 优化');
console.log('     → 仅在 startNewThread 时截断，不在每次 patch 时遍历');
console.log('     → 验证: pnpm test -- --grep conversation\n');
console.log('  🟠 #4: editor.ts findDocumentByPath 预计算 normalizedPath');
console.log('     → 在 IEditorDocument 加 normalizedPath 字段，createDocument 时预计算\n');
console.log('  🟠 #5: useBrowserContextMenu → onMounted 注册事件\n');
console.log('  完成后请运行: pnpm lint && pnpm typecheck && pnpm test\n');