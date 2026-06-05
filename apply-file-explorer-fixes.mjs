#!/usr/bin/env node
/**
 * apply-file-explorer-fixes.mjs
 * 套用「文件」资源管理器精读修复补丁：A1–A3 + B1/B5/B6/B11
 *
 * 用法：
 *   node apply-file-explorer-fixes.mjs [项目根目录] [--dry]
 *   默认根目录：D:\com.xiaojianc\my_desktop_app
 *   --dry 只预演不写入
 *
 * 特性：
 *   - 缩进容错：按目标块首行的公共缩进自动对齐查找/替换
 *   - 唯一性校验：匹配 0 处或多处都会报错并跳过该文件
 *   - 写入前生成 .bak 备份
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const raw = String.raw;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry');
const ROOT = args.find((a) => !a.startsWith('--')) ?? 'D:\\com.xiaojianc\\my_desktop_app';

// ---- 缩进容错的块匹配器 ----------------------------------------------------
function findMatches(contentLines, findLines) {
    const matches = [];
    const first = findLines[0];
    for (let i = 0; i + findLines.length <= contentLines.length; i++) {
        const cFirst = contentLines[i];
        if (!cFirst.endsWith(first)) continue;
        const pad = cFirst.slice(0, cFirst.length - first.length);
        if (!/^\s*$/.test(pad)) continue;
        let ok = true;
        for (let j = 0; j < findLines.length; j++) {
            const fl = findLines[j];
            const cl = contentLines[i + j];
            if (fl.trim() === '') {
                if (cl.trim() !== '') { ok = false; break; }
            } else if (cl !== pad + fl) {
                ok = false;
                break;
            }
        }
        if (ok) matches.push({ i, pad });
    }
    return matches;
}

function applyBlockEdit(content, find, replace, id) {
    const f = find.replace(/^\n/, '').replace(/\n$/, '');
    const contentLines = content.split('\n');
    const findLines = f.split('\n');
    const matches = findMatches(contentLines, findLines);
    if (matches.length === 0) throw new Error('未找到匹配');
    if (matches.length > 1) throw new Error(`匹配不唯一（${matches.length} 处）`);
    const { i, pad } = matches[0];
    let replLines;
    if (replace === '') {
        replLines = [];
    } else {
        const r = replace.replace(/^\n/, '').replace(/\n$/, '');
        replLines = r.split('\n').map((line) => (line.trim() === '' ? '' : pad + line));
    }
    contentLines.splice(i, findLines.length, ...replLines);
    return contentLines.join('\n');
}

// ---- A1：workspace.ts 整文件重写 ------------------------------------------
const fullRewrites = {
    'src/utils/workspace.ts': `import type { IWorkspaceDirectoryPayload } from '@/types/editor';

export type TListWorkspaceEntries = (
  path?: string,
  rootPath?: string,
) => Promise<IWorkspaceDirectoryPayload>;

const EMPTY_WORKSPACE_KEY = '__empty_workspace__';

export const resolveWorkspaceKey = (workspaceRootPath: string | null): string =>
  workspaceRootPath ?? EMPTY_WORKSPACE_KEY;

const resolvePreloadedWorkspaceRoot = (
  workspaceRootPath: string | null,
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null,
): IWorkspaceDirectoryPayload | null => {
  if (!workspaceRootPath || !preloadedWorkspaceRoot) {
    return null;
  }

  return preloadedWorkspaceRoot.rootPath === workspaceRootPath ? preloadedWorkspaceRoot : null;
};

export const resolveWorkspaceRootPayload = async (
  workspaceRootPath: string,
  preloadedWorkspaceRoot: IWorkspaceDirectoryPayload | null,
  listWorkspaceEntries: TListWorkspaceEntries,
): Promise<IWorkspaceDirectoryPayload> => {
  const matchedPreloadedRoot = resolvePreloadedWorkspaceRoot(
    workspaceRootPath,
    preloadedWorkspaceRoot,
  );
  if (matchedPreloadedRoot) {
    return matchedPreloadedRoot;
  }

  return listWorkspaceEntries(undefined, workspaceRootPath);
};

export const isWorkspaceRootAccessible = async (
  workspaceRootPath: string,
  listWorkspaceEntries: TListWorkspaceEntries,
): Promise<boolean> => {
  try {
    await listWorkspaceEntries(undefined, workspaceRootPath);
    return true;
  } catch {
    return false;
  }
};
`,
};

// ---- 块编辑（按文件分组，顺序套用）----------------------------------------
const edits = {
    'src/components/workbench/WorkspaceTreeNode.vue': [
        {
            id: 'N1 移除导入',
            find: `import { areFileSystemPathsEqual } from '@/utils/path';
import { filterWorkspaceEntriesByQuery } from '@/utils/workspace';`,
            replace: `import { areFileSystemPathsEqual } from '@/utils/path';`,
        },
        {
            id: 'N2 移除 searchQuery prop',
            find: `contextMenuPath?: string | null;
searchQuery?: string;
rootPath: string;`,
            replace: `contextMenuPath?: string | null;
rootPath: string;`,
        },
        {
            id: 'N3 rows 去掉 normalizedQuery',
            find: `const rows = computed<TWorkspaceTreeRow[]>(() => {
  const result: TWorkspaceTreeRow[] = [];
  const normalizedQuery = (props.searchQuery ?? '').trim().toLowerCase();
  const draft = props.inlineCreateDraft;`,
            replace: `const rows = computed<TWorkspaceTreeRow[]>(() => {
  const result: TWorkspaceTreeRow[] = [];
  const draft = props.inlineCreateDraft;`,
        },
        {
            id: 'N4 rows 去掉过滤遍历',
            find: `const visibleChildren = normalizedQuery
  ? filterWorkspaceEntriesByQuery(rawChildren, normalizedQuery, props.childrenMap)
  : rawChildren;

for (const child of visibleChildren) {
  walk(child, level + 1);
}`,
            replace: `for (const child of rawChildren) {
  walk(child, level + 1);
}`,
        },
        {
            id: 'N5 rawChildren 空判断',
            find: `if (visibleChildren.length === 0 && !showInlineCreate && !isLoading) {`,
            replace: `if (rawChildren.length === 0 && !showInlineCreate && !isLoading) {`,
        },
    ],
    'src/components/workbench/AppSidebar.vue': [
        {
            id: 'A1 workspace 导入',
            find: `import {
  collectWorkspaceExpandedPathsByQuery,
  resolveWorkspaceKey,
  resolveWorkspaceRootPayload,
} from '@/utils/workspace';`,
            replace: `import { resolveWorkspaceKey, resolveWorkspaceRootPayload } from '@/utils/workspace';`,
        },
        {
            id: 'A2 path 导入(getRelativeFileSystemPath)',
            find: `import { formatFileSystemPathForDisplay, getPathBaseName } from '@/utils/path';`,
            replace: `import {
  formatFileSystemPathForDisplay,
  getPathBaseName,
  getRelativeFileSystemPath,
} from '@/utils/path';`,
        },
        {
            id: 'A3 删除 explorerSearchQuery ref',
            find: `const explorerSearchQuery = ref('');`,
            replace: '',
        },
        {
            id: 'A4 删除 normalized/hasExplorerSearch',
            find: `const normalizedExplorerSearchQuery = computed(() =>
  explorerSearchQuery.value.trim().toLowerCase(),
);
const hasExplorerSearch = computed(() => normalizedExplorerSearchQuery.value.length > 0);`,
            replace: '',
        },
        {
            id: 'A5 删除 searchExpandedPaths/effective',
            find: `const searchExpandedPaths = computed(() => {
  if (!root.value || !hasExplorerSearch.value) {
    return new Set<string>();
  }

  const nextExpandedPaths = collectWorkspaceExpandedPathsByQuery(
    childrenMap[root.value.rootPath] ?? root.value.entries,
    normalizedExplorerSearchQuery.value,
    childrenMap,
  );
  nextExpandedPaths.add(root.value.rootPath);
  return nextExpandedPaths;
});

const effectiveExplorerExpandedPaths = computed(() => {
  const nextExpandedPaths = new Set(manualExpandedPaths.value);

  searchExpandedPaths.value.forEach((path) => {
    nextExpandedPaths.add(path);
  });

  return nextExpandedPaths;
});`,
            replace: '',
        },
        {
            id: 'A6 模板 expanded-paths 改绑',
            find: `:expanded-paths="effectiveExplorerExpandedPaths"`,
            replace: `:expanded-paths="manualExpandedPaths"`,
        },
        {
            id: 'A7 模板移除 search-query',
            find: `:context-menu-path="explorerContextMenuHighlightPath"
:search-query="explorerSearchQuery"
:inline-create-draft="inlineCreateDraft"`,
            replace: `:context-menu-path="explorerContextMenuHighlightPath"
:inline-create-draft="inlineCreateDraft"`,
        },
        {
            id: 'A8 toggleExplorerPath 去搜索守卫',
            find: `const toggleExplorerPath = async (path: string): Promise<void> => {
  if (hasExplorerSearch.value && searchExpandedPaths.value.has(path)) {
    return;
  }

  if (effectiveExplorerExpandedPaths.value.has(path)) {`,
            replace: `const toggleExplorerPath = async (path: string): Promise<void> => {
  if (manualExpandedPaths.value.has(path)) {`,
        },
        {
            id: 'A9 watch 删除 query 重置',
            find: `() => {
  explorerSearchQuery.value = '';
  closeInlineCreateDraft();`,
            replace: `() => {
  closeInlineCreateDraft();`,
        },
        {
            id: 'A10 refreshDirectoryAfterMutation 温和刷新',
            find: `const refreshDirectoryAfterMutation = async (path: string | null): Promise<void> => {
  if (!root.value || !path) {
    await handleRefreshExplorer();
    return;
  }

  if (path === root.value.rootPath) {
    await handleRefreshExplorer();
    return;
  }

  await loadDirectoryEntries(path);
};`,
            replace: `const refreshDirectoryAfterMutation = async (path: string | null): Promise<void> => {
  if (!root.value || !path) {
    await handleRefreshExplorer();
    return;
  }

  // 根目录变更同样只刷新该目录的直接子项，避免整树重载导致展开态坍缩。
  await loadDirectoryEntries(path);
};`,
        },
        {
            id: 'A11 新增 pruneWorkspaceSubtreeState',
            find: raw`const resolveParentPathForMutation = (path: string): string | null => {
  const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSlashIndex <= 0) {
    return null;
  }

  return path.slice(0, lastSlashIndex);
};`,
            replace: raw`const resolveParentPathForMutation = (path: string): string | null => {
  const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (lastSlashIndex <= 0) {
    return null;
  }

  return path.slice(0, lastSlashIndex);
};

// 删除/重命名后清理目标子树在 childrenMap / loadingPaths / 展开集合中的残留，
// 避免孤儿堆积、持久化展开集合膨胀，以及重命名后旧路径残留。
const pruneWorkspaceSubtreeState = (path: string): void => {
  // getRelativeFileSystemPath 对「相等」返回 ''，对「后代」返回相对路径，否则返回 null。
  const isUnder = (candidate: string): boolean =>
    getRelativeFileSystemPath(candidate, path) !== null;

  Object.keys(childrenMap).forEach((key) => {
    if (isUnder(key)) {
      delete childrenMap[key];
    }
  });
  Object.keys(loadingPaths).forEach((key) => {
    if (isUnder(key)) {
      delete loadingPaths[key];
    }
  });

  let mutated = false;
  const nextExpandedPaths = new Set<string>();
  manualExpandedPaths.value.forEach((expanded) => {
    if (isUnder(expanded)) {
      mutated = true;
    } else {
      nextExpandedPaths.add(expanded);
    }
  });
  if (mutated) {
    manualExpandedPaths.value = nextExpandedPaths;
    emitExplorerStateChange();
  }
};`,
        },
        {
            id: 'A12 删除后 prune',
            find: `await tauriService.deleteWorkspacePath({
  path: target.path,
  rootPath: root.value.rootPath,
});
await refreshDirectoryAfterMutation(resolveParentPathForMutation(target.path));
message.success('已移动到回收站');`,
            replace: `await tauriService.deleteWorkspacePath({
  path: target.path,
  rootPath: root.value.rootPath,
});
pruneWorkspaceSubtreeState(target.path);
await refreshDirectoryAfterMutation(resolveParentPathForMutation(target.path));
message.success('已移动到回收站');`,
        },
        {
            id: 'A13 重命名后 prune',
            find: `await tauriService.renameWorkspacePath({
  path: target.path,
  rootPath: root.value.rootPath,
  newName,
});
await refreshDirectoryAfterMutation(resolveParentPathForMutation(target.path));
message.success('已重命名');`,
            replace: `await tauriService.renameWorkspacePath({
  path: target.path,
  rootPath: root.value.rootPath,
  newName,
});
pruneWorkspaceSubtreeState(target.path);
await refreshDirectoryAfterMutation(resolveParentPathForMutation(target.path));
message.success('已重命名');`,
        },
        {
            id: 'B1 去掉 rootRequestId 二次自增',
            find: `): void => {
  rootRequestId += 1;
  rootLoading.value = false;
  loadError.value = '';
  root.value = payload;`,
            replace: `): void => {
  rootLoading.value = false;
  loadError.value = '';
  root.value = payload;`,
        },
        {
            id: 'B5 confirmInlineCreate 固化快照',
            find: `  const name = inlineCreateDraft.value.trim();
  if (!name) {
    closeInlineCreateDraft();
    return;
  }

  isInlineCreateSubmitting.value = true;

  try {
    const payload = await tauriService.createWorkspacePath({
      parentPath: inlineCreateDraft.parentPath,
      rootPath: root.value.rootPath,
      name,
      kind: inlineCreateDraft.kind,
    });

    await refreshDirectoryAfterMutation(inlineCreateDraft.parentPath);
    message.success(inlineCreateDraft.kind === 'file' ? '已创建文件' : '已创建文件夹');
    closeInlineCreateDraft();
    if (payload.kind === 'file') {
      handleOpenFile(payload.path);
    }
  } catch (error) {
    isInlineCreateSubmitting.value = false;
    message.error(
      toErrorMessage(error, inlineCreateDraft.kind === 'file' ? '创建文件失败' : '创建文件夹失败'),
    );
  }
};`,
            replace: `  const name = inlineCreateDraft.value.trim();
  if (!name) {
    closeInlineCreateDraft();
    return;
  }

  // 在 await 前固化草稿快照，避免提交期间 draft 被改动导致刷新/打开错对象。
  const parentPath = inlineCreateDraft.parentPath;
  const kind = inlineCreateDraft.kind;
  const rootPath = root.value.rootPath;

  isInlineCreateSubmitting.value = true;

  try {
    const payload = await tauriService.createWorkspacePath({
      parentPath,
      rootPath,
      name,
      kind,
    });

    await refreshDirectoryAfterMutation(parentPath);
    message.success(kind === 'file' ? '已创建文件' : '已创建文件夹');
    closeInlineCreateDraft();
    if (payload.kind === 'file') {
      handleOpenFile(payload.path);
    }
  } catch (error) {
    isInlineCreateSubmitting.value = false;
    message.error(toErrorMessage(error, kind === 'file' ? '创建文件失败' : '创建文件夹失败'));
  }
};`,
        },
        {
            id: 'B6 stopWorkspaceWatching 条件化',
            find: `function stopWorkspaceFileWatcher(): void {
  fsEventUnlisten?.();
  fsEventUnlisten = null;
  isFsWatcherStarting = false;
  pendingFsReloadDirs.clear();
  void tauriService.stopWorkspaceWatching();
}`,
            replace: `function stopWorkspaceFileWatcher(): void {
  // 记录是否确实启动过监听（含正在建立），避免在从未监听时发无谓的停止 IPC。
  const wasWatching = fsEventUnlisten !== null || isFsWatcherStarting;
  fsEventUnlisten?.();
  fsEventUnlisten = null;
  isFsWatcherStarting = false;
  pendingFsReloadDirs.clear();
  if (wasWatching) {
    void tauriService.stopWorkspaceWatching();
  }
}`,
        },
        {
            id: 'B11 confirmInlineRename 无活动守卫',
            find: `const confirmInlineRename = (): void => {
  if (isInlineRenamePriming.value) {
    return;
  }

  const value = inlineRenameDraft.value.trim();
  inlineRenameDraft.path = null;
  inlineRenameDraft.value = '';
  const resolver = resolveInlineRename;
  resolveInlineRename = null;
  resolver?.(value || null);
};`,
            replace: `const confirmInlineRename = (): void => {
  // 聚焦/选区初始化期间（priming）忽略 blur 触发的确认，避免一打开就被收掉。
  if (isInlineRenamePriming.value) {
    return;
  }
  // 没有进行中的重命名时直接忽略：Enter / blur / 卸载 blur 可能重复触发，
  // 此守卫确保只有首次确认会消费草稿并 resolve。
  if (!resolveInlineRename) {
    return;
  }

  const value = inlineRenameDraft.value.trim();
  inlineRenameDraft.path = null;
  inlineRenameDraft.value = '';
  const resolver = resolveInlineRename;
  resolveInlineRename = null;
  resolver(value || null);
};`,
        },
    ],
};

// ---- 执行 ------------------------------------------------------------------
let hadError = false;

for (const [rel, content] of Object.entries(fullRewrites)) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
        console.error(`✗ 缺失文件: ${rel}`);
        hadError = true;
        continue;
    }
    const original = readFileSync(abs, 'utf8');
    if (original === content) {
        console.log(`• ${rel} 已是目标内容，跳过`);
        continue;
    }
    if (dryRun) {
        console.log(`(dry) 将整文件重写: ${rel}`);
        continue;
    }
    writeFileSync(`${abs}.bak`, original, 'utf8');
    writeFileSync(abs, content, 'utf8');
    console.log(`✓ 整文件重写: ${rel}（备份 ${rel}.bak）`);
}

for (const [rel, fileEdits] of Object.entries(edits)) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
        console.error(`✗ 缺失文件: ${rel}`);
        hadError = true;
        continue;
    }
    const original = readFileSync(abs, 'utf8');
    let content = original;
    const applied = [];
    const failed = [];
    for (const e of fileEdits) {
        try {
            content = applyBlockEdit(content, e.find, e.replace, e.id);
            applied.push(e.id);
        } catch (err) {
            failed.push(`${e.id} -> ${err.message}`);
        }
    }
    if (failed.length) {
        hadError = true;
        console.error(`✗ ${rel} 有未套用项，跳过写入：`);
        for (const m of failed) console.error(`    - ${m}`);
        if (applied.length) console.error(`    （内存中已成功但不写入：${applied.length} 项）`);
        continue;
    }
    if (content === original) {
        console.log(`• ${rel} 无变化`);
        continue;
    }
    if (dryRun) {
        console.log(`(dry) 将套用 ${applied.length} 处: ${rel}`);
        for (const id of applied) console.log(`    + ${id}`);
        continue;
    }
    writeFileSync(`${abs}.bak`, original, 'utf8');
    writeFileSync(abs, content, 'utf8');
    console.log(`✓ ${rel}: 套用 ${applied.length} 处（备份 ${rel}.bak）`);
    for (const id of applied) console.log(`    + ${id}`);
}

console.log(
    hadError
        ? '\n⚠ 存在失败项：请检查日志，对照补丁页手动核对未命中的块（可能本地已被改动）。'
        : '\n✅ 全部套用完成。建议执行：pnpm tsc --noEmit && pnpm test',
);
process.exit(hadError ? 1 : 0);