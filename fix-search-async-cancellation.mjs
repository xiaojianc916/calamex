#!/usr/bin/env node
/**
 * fix-search-async-cancellation.mjs
 *
 * 继续修搜索/替换核心异步竞态：
 *
 * 1. useWorkspaceSearch.ts
 *    - onScopeDispose 时不只清流式 buffer，还要 cancelPendingSearch()
 *    - 否则 searchTimer / activeAbortController / searchRequestId / streamingSearchId 没有统一失效
 *
 * 2. useWorkspaceReplacement.ts
 *    - previewReplacementToSearch 成功路径也要判断 abortController.signal.aborted
 *    - refreshReplacementPreviewAfterLineApply 成功路径也要判断 abortController.signal.aborted
 *
 * 用法：
 *   node fix-search-async-cancellation.mjs
 *   node fix-search-async-cancellation.mjs --apply
 *
 * 不生成备份文件。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');

const abs = (file) => join(root, file);
const read = (file) => readFileSync(abs(file), 'utf8');
const write = (file, content) => {
  if (apply) {
    writeFileSync(abs(file), content, 'utf8');
  }
};

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

const ensureFile = (file) => {
  if (!existsSync(abs(file))) {
    fail(`缺少文件：${file}`);
  }
};

const normalizeLf = (text) => text.replace(/\r\n/g, '\n');

const replaceOnce = (content, oldText, newText, label) => {
  const count = content.split(oldText).length - 1;
  if (count !== 1) {
    fail(`${label}：期望匹配 1 次，实际 ${count} 次`);
  }
  return content.replace(oldText, newText);
};

const patchWorkspaceSearchDispose = () => {
  const file = 'src/components/workbench/sidebar/search/useWorkspaceSearch.ts';
  ensureFile(file);

  let content = normalizeLf(read(file));

  const oldBlock = `  onScopeDispose(() => {
    clearPendingStreamResults();
    disposeSearchStream?.();
    disposeSearchStream = null;
  });
`;

  const newBlock = `  onScopeDispose(() => {
    cancelPendingSearch();
    disposeSearchStream?.();
    disposeSearchStream = null;
  });
`;

  if (content.includes(newBlock)) {
    console.log(`• 已存在，跳过：${file}: dispose 取消 in-flight 搜索`);
  } else {
    content = replaceOnce(
      content,
      oldBlock,
      newBlock,
      `${file}: dispose 取消 in-flight 搜索`,
    );
  }

  write(file, content);
  return file;
};

const patchWorkspaceReplacementAbortChecks = () => {
  const file = 'src/components/workbench/sidebar/search/useWorkspaceReplacement.ts';
  ensureFile(file);

  let content = normalizeLf(read(file));

  const oldPreviewSuccessGuard = `      if (
        requestId !== replacementPreviewRequestId ||
        !isWorkspaceRootCurrent(request.workspaceRootPath)
      )
        return;
`;

  const newPreviewSuccessGuard = `      if (
        abortController.signal.aborted ||
        requestId !== replacementPreviewRequestId ||
        !isWorkspaceRootCurrent(request.workspaceRootPath)
      )
        return;
`;

  if (content.includes(newPreviewSuccessGuard)) {
    console.log(`• 已存在，跳过：${file}: 替换预览成功路径检查 abort`);
  } else {
    content = replaceOnce(
      content,
      oldPreviewSuccessGuard,
      newPreviewSuccessGuard,
      `${file}: 替换预览成功路径检查 abort`,
    );
  }

  const oldRefreshSuccessGuard = `      if (
        requestId !== replacementPreviewRequestId ||
        !isReplacementApplyLifecycleCurrent(lifecycle)
      )
        return;
`;

  const newRefreshSuccessGuard = `      if (
        abortController.signal.aborted ||
        requestId !== replacementPreviewRequestId ||
        !isReplacementApplyLifecycleCurrent(lifecycle)
      )
        return;
`;

  if (content.includes(newRefreshSuccessGuard)) {
    console.log(`• 已存在，跳过：${file}: 行替换后刷新预览成功路径检查 abort`);
  } else {
    content = replaceOnce(
      content,
      oldRefreshSuccessGuard,
      newRefreshSuccessGuard,
      `${file}: 行替换后刷新预览成功路径检查 abort`,
    );
  }

  write(file, content);
  return file;
};

const main = () => {
  const touched = [];

  touched.push(patchWorkspaceSearchDispose());
  touched.push(patchWorkspaceReplacementAbortChecks());

  console.log(`\n模式：${apply ? 'apply，已写入文件' : 'dry-run，只检查匹配，不写入'}\n`);

  console.log('处理的核心源码文件：');
  for (const file of touched) {
    console.log(`- ${file}`);
  }

  if (!apply) {
    console.log('\n确认无误后执行：');
    console.log('  node fix-search-async-cancellation.mjs --apply');
    return;
  }

  console.log('\n已完成。建议继续跑：');
  console.log('  pnpm typecheck');
  console.log('  pnpm test');
};

main();