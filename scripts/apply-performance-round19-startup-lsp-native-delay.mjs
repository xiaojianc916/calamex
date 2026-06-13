#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

const fail = (filePath, message) => {
  throw new Error(`[${filePath}] ${message}`);
};

const read = (filePath) => readFileSync(resolve(root, filePath), 'utf8');
const write = (filePath, source) => writeFileSync(resolve(root, filePath), source, 'utf8');

const replaceOnce = (source, filePath, oldText, newText, label) => {
  if (source.includes(newText.trim())) {
    return source;
  }

  const count = source.split(oldText).length - 1;
  if (count !== 1) {
    fail(filePath, `${label}: expected 1 match, got ${count}`);
  }

  return source.replace(oldText, newText);
};

const insertAfterOnce = (source, filePath, anchor, insertion, label) => {
  if (source.includes(insertion.trim())) {
    return source;
  }

  const count = source.split(anchor).length - 1;
  if (count !== 1) {
    fail(filePath, `${label}: expected 1 anchor match, got ${count}`);
  }

  return source.replace(anchor, `${anchor}${insertion}`);
};

// ---------------------------------------------------------------------------
// src/composables/useLsp.ts
// ---------------------------------------------------------------------------

{
  const filePath = 'src/composables/useLsp.ts';
  let source = read(filePath);

  source = insertAfterOnce(
    source,
    filePath,
    `const STABILITY_RESET_MS = 30_000;
`,
    `// 启动期 LSP 属于 P2 后台任务：诊断/补全很重要，但不应该抢首屏、session restore、编辑器 mount。
const STARTUP_LSP_INITIAL_DELAY_MS = 1600;
`,
    'add startup lsp delay constant',
  );

  source = replaceOnce(
    source,
    filePath,
    `  const stopWatch = watch(
    rootRef,
    (newRoot) => {
      void setWorkspaceRoot(newRoot);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    // 组件销毁不再停止 LSP；只取消这个 composable 实例的 root 监听。
    stopWatch();
  });`,
    `  let pendingInitialLspTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let hasScheduledInitialLspStart = false;

  const clearPendingInitialLspStart = (): void => {
    if (pendingInitialLspTimer === null) {
      return;
    }

    globalThis.clearTimeout(pendingInitialLspTimer);
    pendingInitialLspTimer = null;
  };

  const applyWorkspaceRootForLsp = (newRoot: string | null): void => {
    if (!newRoot) {
      clearPendingInitialLspStart();
      void setWorkspaceRoot(null);
      return;
    }

    // 首次启动时延后 LSP：让首帧、窗口显示、session restore、active document mount 先完成。
    // 后续工作区切换不再延后，避免用户主动切换后诊断长时间不可用。
    if (!hasScheduledInitialLspStart && activeWorkspaceRoot === null && status.value === 'idle') {
      hasScheduledInitialLspStart = true;
      clearPendingInitialLspStart();
      pendingInitialLspTimer = globalThis.setTimeout(() => {
        pendingInitialLspTimer = null;
        void setWorkspaceRoot(rootRef.value);
      }, STARTUP_LSP_INITIAL_DELAY_MS);
      return;
    }

    hasScheduledInitialLspStart = true;
    clearPendingInitialLspStart();
    void setWorkspaceRoot(newRoot);
  };

  const stopWatch = watch(
    rootRef,
    (newRoot) => {
      applyWorkspaceRootForLsp(newRoot);
    },
    { immediate: true },
  );

  onScopeDispose(() => {
    // 组件销毁不再停止 LSP；只取消这个 composable 实例的 root 监听。
    clearPendingInitialLspStart();
    stopWatch();
  });`,
    'defer initial lsp startup',
  );

  write(filePath, source);
}

// ---------------------------------------------------------------------------
// src/layouts/AppShellLayout.vue
// ---------------------------------------------------------------------------

{
  const filePath = 'src/layouts/AppShellLayout.vue';
  let source = read(filePath);

  source = insertAfterOnce(
    source,
    filePath,
    `let isLayoutUnmounted = false;
let unlistenWindowResized: (() => void) | null = null;
`,
    `let windowStateSyncTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
`,
    'add native window sync timer',
  );

  source = replaceOnce(
    source,
    filePath,
    `onMounted(async () => {
  isLayoutUnmounted = false;
  const appWindow = await getAppWindow();
  if (!appWindow || isLayoutUnmounted) {
    return;
  }

  await syncWindowState();
  const unlisten = await appWindow.onResized(() => {
    void syncWindowState();
  });

  if (isLayoutUnmounted) {
    unlisten();
    return;
  }

  unlistenWindowResized = unlisten;
});`,
    `const bindNativeWindowStateListeners = async (): Promise<void> => {
  const appWindow = await getAppWindow();
  if (!appWindow || isLayoutUnmounted) {
    return;
  }

  await syncWindowState();
  const unlisten = await appWindow.onResized(() => {
    void syncWindowState();
  });

  if (isLayoutUnmounted) {
    unlisten();
    return;
  }

  unlistenWindowResized = unlisten;
};

onMounted(() => {
  isLayoutUnmounted = false;
  // 原生窗口状态同步不是首帧必需：延后 import('@tauri-apps/api/window') 与 IPC，
  // 避免 AppShellLayout mount 时和工作台首屏争抢主线程/桥接资源。
  windowStateSyncTimer = globalThis.setTimeout(() => {
    windowStateSyncTimer = null;
    void bindNativeWindowStateListeners();
  }, 1600);
});`,
    'defer native window state listener binding',
  );

  source = replaceOnce(
    source,
    filePath,
    `onBeforeUnmount(() => {
  isLayoutUnmounted = true;
  unlistenWindowResized?.();
  unlistenWindowResized = null;
});`,
    `onBeforeUnmount(() => {
  isLayoutUnmounted = true;
  if (windowStateSyncTimer !== null) {
    globalThis.clearTimeout(windowStateSyncTimer);
    windowStateSyncTimer = null;
  }
  unlistenWindowResized?.();
  unlistenWindowResized = null;
});`,
    'clear deferred native window timer on unmount',
  );

  write(filePath, source);
}

console.log('Applied round19 startup LSP/native window delay optimization.');
console.log('');
console.log('Touched:');
console.log(' - src/composables/useLsp.ts');
console.log(' - src/layouts/AppShellLayout.vue');
console.log('');
console.log('What changed:');
console.log(' - Initial LSP startup is delayed so it does not compete with first paint/session restore/editor mount.');
console.log(' - Workspace switches after startup still apply immediately.');
console.log(' - Native window maximized-state sync and resize listener binding are delayed after startup.');
console.log(' - No UI behavior is removed; diagnostics and native window state simply initialize slightly later.');
console.log('');
console.log('Next:');
console.log('  pnpm lint');
console.log('  pnpm typecheck');
console.log('  pnpm test');
console.log('');
console.log('Experience check:');
console.log('  pnpm dev');
console.log('  Watch startup logs and verify diagnostics/LSP becomes active shortly after the workbench appears.');
console.log('');
console.log('Rollback:');
console.log('  git checkout -- src/composables/useLsp.ts src/layouts/AppShellLayout.vue');