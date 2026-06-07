#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const target = path.join(root, 'src/components/workbench/AppSidebar.vue');
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check') || !apply;

if (!fs.existsSync(target)) {
  console.error(`[patch] 找不到文件: ${target}`);
  process.exit(1);
}

let source = fs.readFileSync(target, 'utf8');
const original = source;
const warnings = [];
const logs = [];

const watcherNew = `interface FsChange {
  path: string;
  kind: 'created' | 'modified' | 'removed' | 'renamed';
}
interface WorkspaceFsEvent {
  changes: FsChange[];
  rootPath: string;
}
type TWorkspaceWatcherLifecycle = {
  id: number;
  rootPath: string;
};

let fsEventUnlisten: (() => void) | null = null;
let isFsWatcherStarting = false;
let workspaceWatcherLifecycleId = 0;
let activeWorkspaceWatcherLifecycle: TWorkspaceWatcherLifecycle | null = null;
const pendingFsReloadDirs = new Set<string>();

const beginWorkspaceWatcherLifecycle = (rootPath: string): TWorkspaceWatcherLifecycle => {
  const lifecycle = {
    id: workspaceWatcherLifecycleId + 1,
    rootPath,
  };
  workspaceWatcherLifecycleId = lifecycle.id;
  activeWorkspaceWatcherLifecycle = lifecycle;
  return lifecycle;
};

const isWorkspaceWatcherLifecycleCurrent = (
  lifecycle: TWorkspaceWatcherLifecycle,
): boolean =>
  activeWorkspaceWatcherLifecycle?.id === lifecycle.id &&
  areFileSystemPathsEqual(activeWorkspaceWatcherLifecycle.rootPath, lifecycle.rootPath) &&
  areFileSystemPathsEqual(root.value?.rootPath ?? null, lifecycle.rootPath);

const invalidateWorkspaceWatcherLifecycle = (): boolean => {
  const wasWatching =
    fsEventUnlisten !== null ||
    isFsWatcherStarting ||
    activeWorkspaceWatcherLifecycle !== null;

  workspaceWatcherLifecycleId += 1;
  activeWorkspaceWatcherLifecycle = null;
  isFsWatcherStarting = false;
  pendingFsReloadDirs.clear();

  const unlisten = fsEventUnlisten;
  fsEventUnlisten = null;
  unlisten?.();

  return wasWatching;
};

const flushPendingFsReloads = useDebounceFn(
  async (lifecycle: TWorkspaceWatcherLifecycle): Promise<void> => {
    if (!isWorkspaceWatcherLifecycleCurrent(lifecycle)) {
      return;
    }

    const dirs = [...pendingFsReloadDirs];
    pendingFsReloadDirs.clear();

    for (const dir of dirs) {
      if (!isWorkspaceWatcherLifecycleCurrent(lifecycle)) {
        return;
      }
      if (childrenMap[dir] === undefined) {
        continue;
      }
      await loadDirectoryEntries(dir);
    }
  },
  80,
);

const refreshGitStatusAfterFsEvent = useDebounceFn(
  async (lifecycle: TWorkspaceWatcherLifecycle): Promise<void> => {
    if (!isWorkspaceWatcherLifecycleCurrent(lifecycle)) {
      return;
    }

    try {
      await gitStore.refreshRepositoryStatus(lifecycle.rootPath);
    } catch (error) {
      if (isWorkspaceWatcherLifecycleCurrent(lifecycle)) {
        console.warn('[AppSidebar] Failed to refresh Git status after workspace file change.', error);
      }
    }
  },
  120,
);

function stopWorkspaceFileWatcher(): void {
  const wasWatching = invalidateWorkspaceWatcherLifecycle();
  if (wasWatching) {
    void tauriService.stopWorkspaceWatching();
  }
}

async function startWorkspaceFileWatcher(): Promise<void> {
  const rootPath = root.value?.rootPath;
  if (!rootPath) return;
  if (fsEventUnlisten || isFsWatcherStarting) return;

  const lifecycle = beginWorkspaceWatcherLifecycle(rootPath);
  isFsWatcherStarting = true;

  try {
    const unlisten = await events.workspaceFsEvent.listen((e) => {
      handleFileSystemEvent(e.payload);
    });

    if (!isWorkspaceWatcherLifecycleCurrent(lifecycle)) {
      unlisten();
      return;
    }

    fsEventUnlisten = unlisten;

    try {
      await tauriService.startWorkspaceWatching(lifecycle.rootPath);
    } catch (error) {
      if (!isWorkspaceWatcherLifecycleCurrent(lifecycle)) {
        return;
      }

      console.warn('[AppSidebar] Failed to start workspace file watcher.', error);
      fsEventUnlisten?.();
      fsEventUnlisten = null;
      activeWorkspaceWatcherLifecycle = null;
    }
  } finally {
    if (activeWorkspaceWatcherLifecycle?.id === lifecycle.id) {
      isFsWatcherStarting = false;
    }
  }
}

function handleFileSystemEvent(payload: WorkspaceFsEvent): void {
  const lifecycle = activeWorkspaceWatcherLifecycle;
  if (!lifecycle || !isWorkspaceWatcherLifecycleCurrent(lifecycle)) return;
  if (!areFileSystemPathsEqual(payload.rootPath, lifecycle.rootPath)) return;

  for (const change of payload.changes) {
    if (change.kind === 'removed' || change.kind === 'renamed') {
      pruneWorkspaceSubtreeState(change.path);
    }

    const parent = resolveParentPathForMutation(change.path);
    if (parent && getRelativeFileSystemPath(parent, lifecycle.rootPath) !== null) {
      pendingFsReloadDirs.add(parent);
    }
  }

  void flushPendingFsReloads(lifecycle);
  void refreshGitStatusAfterFsEvent(lifecycle);
}`;

function replaceOptional(label, regex, replacement) {
  const match = source.match(regex);
  if (!match) {
    warnings.push(`[patch] 跳过可选步骤：${label} 未匹配到。`);
    return;
  }

  if (match[0] === replacement) {
    logs.push(`[patch] 已存在：${label}`);
    return;
  }

  source = source.replace(regex, replacement);
  logs.push(`[patch] 已准备：${label}`);
}

replaceOptional(
  'workspaceRootPath 为空时停止 watcher',
  /  if \(!props\.workspaceRootPath\) \{\n    rootLoading\.value = false;\n    loadError\.value = '';\n    root\.value = null;\n    loadedWorkspaceKey\.value = null;\n    clearTreeState\(\);\n(?:    stopWorkspaceFileWatcher\(\);\n)?    return;\n  \}/,
  `  if (!props.workspaceRootPath) {
    rootLoading.value = false;
    loadError.value = '';
    root.value = null;
    loadedWorkspaceKey.value = null;
    clearTreeState();
    stopWorkspaceFileWatcher();
    return;
  }`,
);

replaceOptional(
  '加载新 root 前停止旧 watcher',
  /  root\.value = null;\n  loadedWorkspaceKey\.value = null;\n  clearTreeState\(\);\n(?:  stopWorkspaceFileWatcher\(\);\n)?  try \{/,
  `  root.value = null;
  loadedWorkspaceKey.value = null;
  clearTreeState();
  stopWorkspaceFileWatcher();
  try {`,
);

const watcherStart = source.indexOf('\ninterface FsChange {');
const mountedStart = watcherStart === -1 ? -1 : source.indexOf('\n\nonMounted(() => {', watcherStart);

if (watcherStart === -1 || mountedStart === -1) {
  console.error('[patch] 未找到 watcher 代码块边界，已停止。');
  console.error('[patch] 请确认 AppSidebar.vue 中仍有 interface FsChange 和 onMounted 这两段。');
  process.exit(1);
}

const currentWatcherBlock = source.slice(watcherStart + 1, mountedStart);

if (currentWatcherBlock.includes('type TWorkspaceWatcherLifecycle')) {
  logs.push('[patch] watcher 生命周期代码已存在，跳过 watcher 主体替换。');
} else {
  source =
    source.slice(0, watcherStart + 1) +
    watcherNew +
    source.slice(mountedStart);
  logs.push('[patch] 已准备：watcher 生命周期主体替换');
}

for (const line of logs) {
  console.log(line);
}
for (const line of warnings) {
  console.warn(line);
}

if (source === original) {
  console.log('[patch] 没有新的变更。可能已经应用过补丁。');
  process.exit(0);
}

if (check) {
  console.log('[patch] 校验通过：可以应用 watcher 生命周期补丁。');
  console.log('[patch] 若要真正写入，请运行: node scripts/patch-app-sidebar-watcher.cjs --apply');
  process.exit(0);
}

const backup = `${target}.bak.${Date.now()}`;
fs.writeFileSync(backup, original, 'utf8');
fs.writeFileSync(target, source, 'utf8');

console.log(`[patch] 已写入: ${target}`);
console.log(`[patch] 已备份: ${backup}`);
console.log('[patch] 建议接着运行:');
console.log('  pnpm vitest src/components/workbench/AppSidebar.spec.ts');
console.log('  pnpm vue-tsc --noEmit');