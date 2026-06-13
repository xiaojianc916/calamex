#!/usr/bin/env node
/**
 * fix-real-source-quality-issues.mjs
 *
 * 聚焦真实源码问题：
 * 1. src/store/git.ts
 *    - Git commit stats 持久化缓存只写不清，可能长期撑爆 localStorage。
 *    - 增加 prunePersistedGitCommitStatsCaches，并在写入前清理过期/旧版本缓存。
 *
 * 2. src/store/editor.ts
 *    - 未保存草稿采用 400ms 防抖写入，但切换文档/清空工作区/销毁 store 前没有 flush。
 *    - 在关键边界 flush，避免最后一次输入没进入草稿快照。
 *
 * 用法：
 *   node fix-real-source-quality-issues.mjs          # dry-run，只检查匹配
 *   node fix-real-source-quality-issues.mjs --apply  # 写入修改
 *
 * 不生成备份文件。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');

const read = (file) => readFileSync(join(root, file), 'utf8');
const write = (file, content) => {
  if (apply) {
    writeFileSync(join(root, file), content, 'utf8');
  }
};

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

const ensureFile = (file) => {
  if (!existsSync(join(root, file))) {
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

const insertAfterOnce = (content, anchor, insertion, label) => {
  if (content.includes(insertion.trim())) {
    console.log(`• 已存在，跳过：${label}`);
    return content;
  }

  const count = content.split(anchor).length - 1;
  if (count !== 1) {
    fail(`${label}：期望 anchor 匹配 1 次，实际 ${count} 次`);
  }

  return content.replace(anchor, `${anchor}${insertion}`);
};

const patchGitStore = () => {
  const file = 'src/store/git.ts';
  ensureFile(file);

  let content = normalizeLf(read(file));

  const removePersistedGitCommitStatsBlock = `const removePersistedGitCommitStats = (cacheKey: string): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
    storage.removeItem(createGitCommitStatsPersistedCacheKey(cacheKey));
  } catch {
    // Best-effort cache cleanup only.
  }
};

`;

  const pruneGitCommitStatsBlock = `const prunePersistedGitCommitStatsCaches = (): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  const currentVersionPrefix = \`\${GIT_COMMIT_STATS_PERSISTED_CACHE_PREFIX + GIT_COMMIT_STATS_PERSISTED_CACHE_VERSION}.\`;
  const keysToRemove: string[] = [];

  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(GIT_COMMIT_STATS_PERSISTED_CACHE_PREFIX)) {
        continue;
      }

      if (!key.startsWith(currentVersionPrefix)) {
        keysToRemove.push(key);
        continue;
      }

      const rawValue = storage.getItem(key);
      if (!rawValue) {
        keysToRemove.push(key);
        continue;
      }

      try {
        const parsed = JSON.parse(rawValue) as {
          version?: unknown;
          fetchedAt?: unknown;
        };

        if (
          parsed.version !== GIT_COMMIT_STATS_PERSISTED_CACHE_VERSION ||
          typeof parsed.fetchedAt !== 'number' ||
          Date.now() - parsed.fetchedAt > GIT_COMMIT_STATS_PERSISTED_CACHE_MAX_AGE_MS
        ) {
          keysToRemove.push(key);
        }
      } catch {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => {
      storage.removeItem(key);
    });
  } catch {
    // Best-effort cache pruning only.
  }
};

`;

  content = insertAfterOnce(
    content,
    removePersistedGitCommitStatsBlock,
    pruneGitCommitStatsBlock,
    `${file}: 添加 Git commit stats 持久化缓存清理`,
  );

  const oldWriteStart = `const writePersistedGitCommitStats = (
  cacheKey: string,
  payload: TGitCommitStatsPayload,
  fetchedAt: number,
): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  try {
`;

  const newWriteStart = `const writePersistedGitCommitStats = (
  cacheKey: string,
  payload: TGitCommitStatsPayload,
  fetchedAt: number,
): void => {
  const storage = getPullRequestPersistentStorage();
  if (!storage) return;

  prunePersistedGitCommitStatsCaches();

  try {
`;

  if (!content.includes('prunePersistedGitCommitStatsCaches();')) {
    content = replaceOnce(
      content,
      oldWriteStart,
      newWriteStart,
      `${file}: 写入 commit stats 前先清理旧缓存`,
    );
  } else {
    console.log(`• 已存在，跳过：${file}: 写入 commit stats 前先清理旧缓存`);
  }

  write(file, content);
  return file;
};

const patchEditorStore = () => {
  const file = 'src/store/editor.ts';
  ensureFile(file);

  let content = normalizeLf(read(file));

  content = replaceOnce(
    content,
    `import { computed, ref, watch } from 'vue';`,
    `import { computed, onScopeDispose, ref, watch } from 'vue';`,
    `${file}: 引入 onScopeDispose`,
  );

  const flushPendingDraftCaptureBlock = `    const flushPendingDraftCapture = (): void => {
      if (draftCaptureTimer !== null) {
        clearTimeout(draftCaptureTimer);
        draftCaptureTimer = null;
      }
      const documentId = pendingDraftDocumentId;
      pendingDraftDocumentId = null;
      if (documentId !== null) {
        runDraftCapture(documentId);
      }
    };

`;

  const scopeDisposeBlock = `    onScopeDispose(() => {
      flushPendingDraftCapture();
    });

`;

  content = insertAfterOnce(
    content,
    flushPendingDraftCaptureBlock,
    scopeDisposeBlock,
    `${file}: store 销毁前 flush 未保存草稿`,
  );

  const oldSetActiveDocumentStart = `    const setActiveDocument = (documentId: string): void => {
      const targetDocument = documents.value.find((item) => item.id === documentId);
`;

  const newSetActiveDocumentStart = `    const setActiveDocument = (documentId: string): void => {
      flushPendingDraftCapture();
      const targetDocument = documents.value.find((item) => item.id === documentId);
`;

  if (!content.includes(`const setActiveDocument = (documentId: string): void => {\n      flushPendingDraftCapture();`)) {
    content = replaceOnce(
      content,
      oldSetActiveDocumentStart,
      newSetActiveDocumentStart,
      `${file}: 切换 active document 前 flush 草稿`,
    );
  } else {
    console.log(`• 已存在，跳过：${file}: 切换 active document 前 flush 草稿`);
  }

  const oldClearDocumentsStart = `    const clearDocuments = (): void => {
      documents.value = [];
`;

  const newClearDocumentsStart = `    const clearDocuments = (): void => {
      flushPendingDraftCapture();
      documents.value = [];
`;

  if (!content.includes(`const clearDocuments = (): void => {\n      flushPendingDraftCapture();`)) {
    content = replaceOnce(
      content,
      oldClearDocumentsStart,
      newClearDocumentsStart,
      `${file}: 清空文档前 flush 草稿`,
    );
  } else {
    console.log(`• 已存在，跳过：${file}: 清空文档前 flush 草稿`);
  }

  const oldClearWorkspaceSessionStart = `    const clearWorkspaceSession = (): void => {
      clearDocuments();
`;

  const newClearWorkspaceSessionStart = `    const clearWorkspaceSession = (): void => {
      flushPendingDraftCapture();
      clearDocuments();
`;

  if (!content.includes(`const clearWorkspaceSession = (): void => {\n      flushPendingDraftCapture();`)) {
    content = replaceOnce(
      content,
      oldClearWorkspaceSessionStart,
      newClearWorkspaceSessionStart,
      `${file}: 切换工作区前 flush 草稿`,
    );
  } else {
    console.log(`• 已存在，跳过：${file}: 切换工作区前 flush 草稿`);
  }

  write(file, content);
  return file;
};

const main = () => {
  const touched = [];

  touched.push(patchGitStore());
  touched.push(patchEditorStore());

  console.log(`\n模式：${apply ? 'apply，已写入文件' : 'dry-run，只检查匹配，不写入'}\n`);

  console.log('处理的核心源码文件：');
  for (const file of touched) {
    console.log(`- ${file}`);
  }

  if (!apply) {
    console.log('\n确认匹配无误后执行：');
    console.log('  node fix-real-source-quality-issues.mjs --apply');
    return;
  }

  console.log('\n已完成。建议继续跑：');
  console.log('  pnpm lint');
  console.log('  pnpm typecheck');
  console.log('  pnpm test');
};

main();