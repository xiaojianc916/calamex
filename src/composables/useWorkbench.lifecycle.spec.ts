import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EffectScope, effectScope } from 'vue';
import { useEditorStore } from '@/store/editor';
import type { IExecutionEnvironment } from '@/types/editor';
import { useWorkbench } from './useWorkbench';

const mockMessages = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}));

const mockTauriService = vi.hoisted(() => ({
  detectEnvironment: vi.fn<[{ signal?: AbortSignal }?], Promise<IExecutionEnvironment>>(),
}));

vi.mock('@/composables/useMessage', () => ({
  useMessage: () => mockMessages,
}));

vi.mock('@/utils/desktop-runtime', () => ({
  waitForDesktopRuntime: vi.fn(() => Promise.resolve(true)),
  desktopRuntimeReady: { value: true },
}));

vi.mock('@/services/tauri', () => ({
  tauriService: mockTauriService,
}));

vi.mock('@/composables/useTheme', () => ({
  useTheme: vi.fn(),
}));

vi.mock('@/composables/useWindowResizeState', () => ({
  useWindowResizeState: vi.fn(),
}));

vi.mock('@/composables/useDocumentPersistence', () => ({
  useDocumentPersistence: () => ({
    buildDefaultScriptContent: vi.fn(() => '#!/usr/bin/env bash\n'),
    formatDocumentWithShfmt: vi.fn(),
    formatWorkspaceFileByPath: vi.fn(),
    saveDocument: vi.fn(),
    saveDocumentAs: vi.fn(),
    saveDirtyDocuments: vi.fn(),
  }),
}));

vi.mock('@/composables/useDocumentLifecycle', () => ({
  useDocumentLifecycle: () => ({
    ensureDirtyDocumentsHandled: vi.fn(() => Promise.resolve(true)),
    requestCloseDocument: vi.fn(),
    requestCloseWorkspace: vi.fn(),
    requestCloseApplication: vi.fn(),
  }),
}));

vi.mock('@/composables/useTerminalRun', () => ({
  useTerminalRun: () => ({
    runScript: vi.fn(),
    appendTerminalOutput: vi.fn(),
    handleIntegratedTerminalRunCompleted: vi.fn(),
  }),
}));

vi.mock('@/composables/useWorkbenchDocumentIO', () => ({
  useWorkbenchDocumentIO: () => ({
    createNewDocument: vi.fn(),
    restoreSession: vi.fn(),
    openDocument: vi.fn(),
    openFolder: vi.fn(),
    openDocumentByPath: vi.fn(),
    openGitDiffPreview: vi.fn(),
    openGitDiffPreviewPayload: vi.fn(),
    ensureDocumentBufferLoaded: vi.fn(),
  }),
}));

vi.mock('@/services/session/store', () => ({
  saveSession: vi.fn(() => Promise.resolve()),
}));

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('useWorkbench lifecycle', () => {
  let scope: EffectScope;
  let editorStore: ReturnType<typeof useEditorStore>;

  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    vi.clearAllMocks();
    editorStore = useEditorStore();
  });

  afterEach(() => {
    scope?.stop();
    vi.useRealTimers();
  });

  it('作用域销毁时取消启动期执行环境检测，避免旧结果回灌', async () => {
    const deferred = createDeferred<IExecutionEnvironment>();
    mockTauriService.detectEnvironment.mockReturnValueOnce(deferred.promise);
    let workbench!: ReturnType<typeof useWorkbench>;

    scope = effectScope();
    scope.run(() => {
      workbench = useWorkbench();
    });

    await workbench.initialize();
    await vi.runOnlyPendingTimersAsync();
    await flush();

    const options = mockTauriService.detectEnvironment.mock.calls[0]?.[0];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal?.aborted).toBe(false);

    scope.stop();
    expect(options?.signal?.aborted).toBe(true);

    deferred.resolve({ hasAny: true, executors: [], recommended: 'wsl' });
    await flush();

    expect(editorStore.environment.hasAny).toBe(false);
    expect(mockMessages.error).not.toHaveBeenCalled();
  });
});
