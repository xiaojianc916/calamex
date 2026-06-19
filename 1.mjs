#!/usr/bin/env node
/**
 * fix-round2.mjs — 第二轮审查修复
 * #14: useShellWorkbenchView.ts gitChangeSummary 空值防御
 * #15: useWorkspacePathSuggestions.ts import 提升到文件顶部
 *
 * 用法: node fix-round2.mjs
 * 前置: 在项目根目录 D:\com.xiaojianc\my_desktop_app 下运行
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

// ── #14: useShellWorkbenchView.ts — gitChangeSummary 空值防御 ──────────
const wbViewPath = join(ROOT, 'src/composables/useShellWorkbenchView.ts');
let wbViewContent = readFileSync(wbViewPath, 'utf-8');

const wbViewOld = `  const gitChangeSummary = computed(() => {
    const files = gitStore.status.files;`;
const wbViewNew = `  const gitChangeSummary = computed(() => {
    const files = gitStore.status.files ?? [];`;

if (wbViewContent.includes(wbViewOld)) {
  wbViewContent = wbViewContent.replace(wbViewOld, wbViewNew);
  writeFileSync(wbViewPath, wbViewContent, 'utf-8');
  console.log('✅ #14 useShellWorkbenchView.ts: gitChangeSummary 空值防御已添加');
} else {
  console.log('⏭️  #14 useShellWorkbenchView.ts: 模式未匹配（可能已修复）');
}

// ── #15: useWorkspacePathSuggestions.ts — import 提升到顶部 ─────────────
const wsPathPath = join(ROOT, 'src/composables/useWorkspacePathSuggestions.ts');
let wsPathContent = readFileSync(wsPathPath, 'utf-8');

// 检查 import 是否在 export 之后
const lateImportLine = `\nimport { joinFileSystemPath } from '@/utils/file/path';\n`;
if (wsPathContent.includes(lateImportLine)) {
  // 删除中间的 import 行
  wsPathContent = wsPathContent.replace(lateImportLine, '\n');

  // 在文件最前面添加（在第一个 export 之前）
  // 找到第一个 export 的位置
  const firstExportIndex = wsPathContent.indexOf('export const getBoundedCacheValue');
  if (firstExportIndex > 0) {
    const before = wsPathContent.slice(0, firstExportIndex);
    const after = wsPathContent.slice(firstExportIndex);
    // 确保前面有任何前导注释的话保持不变，import 加在空行之后
    wsPathContent = `${before}import { joinFileSystemPath } from '@/utils/file/path';\n\n${after}`;
  }

  writeFileSync(wsPathPath, wsPathContent, 'utf-8');
  console.log('✅ #15 useWorkspacePathSuggestions.ts: import 已提升到文件顶部');
} else {
  console.log('⏭️  #15 useWorkspacePathSuggestions.ts: 模式未匹配（可能已修复）');
}

console.log('\n完成。请运行 pnpm biome check --write && pnpm typecheck 验证。');