/**
 * T-2.2 特征化测试：workbench façade 快照
 * 目的：拆分前锁定 useWorkbench 对外可观察行为，作为 T-2.6 的安全网。
 * 约束：MUST NOT 依赖真实 Tauri / CodeMirror / xterm。
 */

import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type EffectScope, effectScope } from 'vue';
import { WORKBENCH_TAB_LIMITS } from '@/constants/workbench';
import { __resetTerminalEventBusForTesting } from '@/services/terminal/eventBus';
import { __resetTerminalRunOrchestratorForTesting } from '@/services/terminal/runOrchestrator';
import { useAppStore } from '@/store/app';
import { useEditorStore } from '@/store/editor';
import { useTerminalRegistryStore } from '@/terminal/registry';
import { useWorkbench } from '../useWorkbench';

// ─────────────────────────────────────────────
// Mock 变量（vi.hoisted 保证提升前可访问）
// ─────────────────────────────────────────────
const {
  mockTauriService,
  mockDialogConfirm,
  mockMessages,
  mockAppWindow,
  mockSessionStore,
  mockWindowService,
  capturedTerminalEventListeners,
  capturedTerminalEventListenerSets,
  mockListen,
} = vi.hoisted(() => ({
  capturedTerminalEventListeners: new Map<string, (event: { payload: unknown }) => void>(),
  capturedTerminalEventListenerSets: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  mockTauriService: {
    detectEnvironment: vi.fn(),
    getGitRepositoryStatus: vi.fn(),
    getGitDiffPreview: vi.fn(),
    listWorkspaceEntries: vi.fn(),
    loadScript: vi.fn(),
    saveScript: vi.fn(),
    pickOpenPath: vi.fn(),
    pickOpenFolderPath: vi.fn(),
    pickSavePath: vi.fn(),
    dispatchScriptToTerminal: vi.fn(),
    ensureTerminalSession: vi.fn(),
    writeTerminalInput: vi.fn(),
    resizeTerminalSession: vi.fn(),
    cancelTerminalRun: vi.fn(),
  },
  mockDialogConfirm: vi.fn<[], Promise<'confirm' | 'cancel' | 'dismiss'>>(),
  mockMessages: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
  mockAppWindow: { close: vi.fn(() => Promise.resolve()) },
  mockSessionStore: {
    saveSession: vi.fn(() => Promise.resolve()),
  },
  mockWindowService: {
    setWindowBackground: vi.fn(() => Promise.resolve()),
    applyWindowStage: vi.fn(() => Promise.resolve()),
  },
  mockListen: vi.fn(async (eventName: string, handler: unknown) => {
    const typedHandler = handler as (event: { payload: unknown }) => void;
    const handlers = capturedTerminalEventListenerSets.get(eventName) ?? new Set();
    handlers.add(typedHandler);
    capturedTerminalEventListenerSets.set(eventName, handlers);
    capturedTerminalEventListeners.set(eventName, (event) => {
      for (const item of handlers) {
        item(event);
      }
    });
    return () => {
      handlers.delete(typedHandler);
      if (handlers.size === 0) {
        capturedTerminalEventListenerSets.delete(eventName);
        capturedTerminalEventListeners.delete(eventName);
      }
    };
  }),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: mockTauriService,
}));

vi.mock('@/services/ipc/window.service', () => mockWindowService);

vi.mock('@/services/session/store', () => ({
  saveSession: mockSessionStore.saveSession,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}));

// ─────────────────────────────────────────────
// Mock：useDialog（覆盖事件系统）
// ─────────────────────────────────────────────
vi.mock('@/composables/useDialog', () => ({
  useDialog: () => ({ confirm: mockDialogConfirm }),
  dismissDialog: vi.fn(),
}));

// ─────────────────────────────────────────────
// Mock：useMessage（避免 jsdom CustomEvent 噪音）
// ─────────────────────────────────────────────
vi.mock('@/composables/useMessage', () => ({
  useMessage: () => mockMessages,
}));

// ─────────────────────────────────────────────
// Mock：desktop-runtime（始终返回 true）
// ─────────────────────────────────────────────
vi.mock('@/utils/platform/desktop-runtime', () => ({
  waitForDesktopRuntime: vi.fn(() => Promise.resolve(true)),
  desktopRuntimeReady: { value: true },
}));

// ─────────────────────────────────────────────
// Mock：Tauri window（避免真实窗口操作）
// ─────────────────────────────────────────────
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => mockAppWindow),
}));

// ─────────────────────────────────────────────
// Mock：window-close 工具
// ─────────────────────────────────────────────
vi.mock('@/utils/window/window-close', () => ({
  allowNextProgrammaticWindowClose: vi.fn(),
  clearProgrammaticWindowCloseAllowance: vi.fn(),
}));

// ─────────────────────────────────────────────
// Mock：shfmt（格式化 wasm，动态导入）
// ─────────────────────────────────────────────
vi.mock('@/utils/terminal/shfmt', () => ({
  formatShellScript: vi.fn((source: string) => Promise.resolve(source)),
}));

const createEmptyGitStatusPayload = () => ({
  available: false,
  message: null,
  repositoryRootPath: null,
  repositoryName: null,
  gitDirPath: null,
  headBranchName: null,
  headShortName: null,
  headShortOid: null,
  isDetached: false,
  isClean: true,
  ahead: 0,
  behind: 0,
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  conflictedCount: 0,
  files: [],
  lastCommit: null,
});

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
};

const createScriptPayload = (path: string, content = '#!/bin/bash\necho ok') => ({
  path,
  name: path.split('/').pop() ?? 'script.sh',
  content,
  encoding: 'utf-8' as const,
  lineCount: content.split('\n').length,
  charCount: content.length,
});

// ─────────────────────────────────────────────
// 测试套件
// ─────────────────────────────────────────────
describe('useWorkbench 特征化快照', () => {
  let scope: EffectScope;
  let workbench: ReturnType<typeof useWorkbench>;
  let editorStore: ReturnType<typeof useEditorStore>;
  let appStore: ReturnType<typeof useAppStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    capturedTerminalEventListeners.clear();
    capturedTerminalEventListenerSets.clear();
    // 终端事件总线和运行编排器都是跨测试单例。一起重置，确保每个用例都会
    // 用当前 mockListen 重新注册监听，避免前一个用例的 singleton 污染本用例。
    __resetTerminalEventBusForTesting();
    __resetTerminalRunOrchestratorForTesting();

    scope = effectScope();
    scope.run(() => {
      workbench = useWorkbench();
    });

    editorStore = useEditorStore();
    appStore = useAppStore();

    // 关闭 formatOnSave，隔离 shfmt 动态导入
    appStore.settings.editor.formatOnSave = false;

    vi.clearAllMocks();
    mockTauriService.ensureTerminalSession.mockResolvedValue({
      sessionId: 'main-terminal',
      cwd: '/home',
    });
  });

  afterEach(() => {
    scope.stop();
    __resetTerminalRunOrchestratorForTesting();
  });

  // ── 1. canRun / canSave 计算属性 ──
  describe('canRun / canSave 计算属性', () => {
    it('无活动文档时 canRun 为 false', () => {
      expect(workbench.canRun.value).toBe(false);
    });

    it('无活动文档时 canSave 为 false', () => {
      expect(workbench.canSave.value).toBe(false);
    });

    it('文档内容为空时 canRun 为 false', () => {
      editorStore.createDocumentTab({ content: '' });
      expect(workbench.canRun.value).toBe(false);
    });

    it('有内容但无可用环境时 canRun 为 false', () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: false, executors: [], recommended: 'wsl' });
      expect(workbench.canRun.value).toBe(false);
    });

    it('有文本文档时 canSave 为 true', () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      expect(workbench.canSave.value).toBe(true);
    });

    it('有内容且有可用环境时 canRun 为 true', () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });
      expect(workbench.canRun.value).toBe(true);
    });

    it('当前文件不是 .sh / .bash 脚本时 canRun 为 false', () => {
      editorStore.createDocumentTab({
        name: 'notes.txt',
        content: '#!/bin/bash\necho hi',
      });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });
      expect(workbench.canRun.value).toBe(false);
    });
  });

  // ── 2. createNewDocument ──
  describe('createNewDocument()', () => {
    it('调用后文档数量增加 1', () => {
      expect(editorStore.documents.length).toBe(0);
      workbench.createNewDocument();
      expect(editorStore.documents.length).toBe(1);
    });

    it('新文档以默认 shebang 开头', () => {
      workbench.createNewDocument();
      const doc = editorStore.documents[0];
      expect(doc?.content.startsWith('#!/usr/bin/env bash')).toBe(true);
    });

    it('严格模式默认开启时包含 set -euo pipefail', () => {
      workbench.createNewDocument();
      const doc = editorStore.documents[0];
      expect(doc?.content).toContain('set -euo pipefail');
    });

    it('标签页达到上限时阻止继续新建并提示', () => {
      for (let index = 0; index < WORKBENCH_TAB_LIMITS.maxOpenTabs; index += 1) {
        editorStore.openDocumentTab({
          path: `/tmp/${index}.sh`,
          name: `${index}.sh`,
          content: '#!/bin/bash\necho test',
          encoding: 'utf-8',
          lineCount: 2,
          charCount: 20,
        });
      }

      workbench.createNewDocument();

      expect(editorStore.documents.length).toBe(WORKBENCH_TAB_LIMITS.maxOpenTabs);
      expect(mockMessages.warning).toHaveBeenCalled();
    });
  });

  describe('restoreSession()', () => {
    it('工作区失效时重置并提示 warning', async () => {
      editorStore.sessionSnapshot = {
        ...editorStore.sessionSnapshot,
        workspaceRoot: '/invalid/workspace',
        openTabs: [],
        activeTabPath: null,
      };

      mockTauriService.listWorkspaceEntries.mockRejectedValueOnce(new Error('invalid root'));

      await workbench.restoreSession();

      expect(editorStore.workspaceRootPath).toBeNull();
      expect(mockMessages.warning).toHaveBeenCalled();
    });

    it('部分文件失效时只恢复可用标签并回退激活项', async () => {
      editorStore.sessionSnapshot = {
        ...editorStore.sessionSnapshot,
        workspaceRoot: null,
        openTabs: [
          { path: '/tmp/alive.sh', pinned: false, order: 0 },
          { path: '/tmp/missing.sh', pinned: false, order: 1 },
        ],
        activeTabPath: '/tmp/missing.sh',
      };

      mockTauriService.loadScript.mockImplementation((path: string) => {
        if (path === '/tmp/alive.sh') {
          return Promise.resolve(createScriptPayload(path, '#!/bin/bash\necho alive'));
        }
        return Promise.reject(new Error('not found'));
      });

      await workbench.restoreSession();

      expect(editorStore.documents.length).toBe(1);
      expect(editorStore.document.path).toBe('/tmp/alive.sh');
      expect(mockMessages.info).toHaveBeenCalled();
    });

    it('旧会话中的图片标签会按图片文档恢复', async () => {
      editorStore.sessionSnapshot = {
        ...editorStore.sessionSnapshot,
        workspaceRoot: null,
        openTabs: [{ path: '/tmp/logo.png', pinned: false, order: 0 }],
        activeTabPath: '/tmp/logo.png',
      };

      await workbench.restoreSession();

      expect(editorStore.documents.length).toBe(1);
      expect(editorStore.document.kind).toBe('image');
      expect(editorStore.document.path).toBe('/tmp/logo.png');
      expect(mockTauriService.loadScript).not.toHaveBeenCalled();
    });

    it('恢复工作区会保留标签顺序并激活旧会话中的活动标签', async () => {
      editorStore.sessionSnapshot = {
        ...editorStore.sessionSnapshot,
        workspaceRoot: '/workspace',
        openTabs: [
          { path: '/workspace/a.sh', pinned: false, order: 0 },
          { path: '/workspace/b.sh', pinned: false, order: 1 },
        ],
        activeTabPath: '/workspace/b.sh',
      };

      mockTauriService.listWorkspaceEntries.mockResolvedValueOnce({
        rootPath: '/workspace',
        rootName: 'workspace',
        entries: [],
      });
      mockTauriService.loadScript.mockImplementation((path: string) =>
        Promise.resolve(createScriptPayload(path)),
      );

      await workbench.restoreSession();

      expect(editorStore.workspaceRootPath).toBe('/workspace');
      expect(editorStore.documents.map((document) => document.path)).toEqual([
        '/workspace/a.sh',
        '/workspace/b.sh',
      ]);
      expect(editorStore.document.path).toBe('/workspace/b.sh');
    });
  });

  describe('initialize()', () => {
    it('无启动工作区时只检测环境不打开文件或目录', async () => {
      mockTauriService.detectEnvironment.mockResolvedValueOnce({
        hasAny: true,
        executors: [],
        recommended: 'wsl',
      });

      const result = await workbench.initialize();

      expect(result.startupWorkspaceDirectory).toBeNull();
      expect(editorStore.workspaceRootPath).toBeNull();
      expect(editorStore.documents).toHaveLength(0);
      expect(mockTauriService.listWorkspaceEntries).not.toHaveBeenCalled();
      expect(mockTauriService.loadScript).not.toHaveBeenCalled();
    });

    it('执行环境检测未返回时也不会阻塞初始化', async () => {
      vi.useFakeTimers();
      mockTauriService.detectEnvironment.mockReturnValueOnce(new Promise(() => undefined));

      try {
        const result = await workbench.initialize();

        expect(result.startupWorkspaceDirectory).toBeNull();
        expect(mockTauriService.detectEnvironment).not.toHaveBeenCalled();
        expect(editorStore.environment.hasAny).toBe(false);

        await vi.runAllTimersAsync();

        expect(mockTauriService.detectEnvironment).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('requestCloseDocument()', () => {
    it('关闭干净文档时不显示对话框', async () => {
      workbench.createNewDocument();
      const doc = editorStore.documents[0]!;

      await workbench.requestCloseDocument(doc.id);

      expect(mockDialogConfirm).not.toHaveBeenCalled();
      expect(editorStore.documents.length).toBe(0);
    });

    it('关闭脏文档时显示对话框', async () => {
      workbench.createNewDocument();
      const doc = editorStore.documents[0]!;
      editorStore.updateDocumentContent(doc.id, `${doc.content}\n# dirty`);

      mockDialogConfirm.mockResolvedValueOnce('cancel' as 'confirm' | 'cancel' | 'dismiss');
      await workbench.requestCloseDocument(doc.id);

      expect(mockDialogConfirm).toHaveBeenCalledOnce();
      expect(editorStore.documents.length).toBe(0);
    });

    it('脏文档对话框选取消时不关闭', async () => {
      workbench.createNewDocument();
      const doc = editorStore.documents[0]!;
      editorStore.updateDocumentContent(doc.id, `${doc.content}\n# dirty`);

      mockDialogConfirm.mockResolvedValueOnce('dismiss' as 'confirm' | 'cancel' | 'dismiss');
      await workbench.requestCloseDocument(doc.id);

      expect(editorStore.documents.length).toBe(1);
    });
  });

  describe('openFolder()', () => {
    it('切换工作区前选取消时保留当前文档与工作区', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      const doc = editorStore.documents[0]!;
      editorStore.updateDocumentContent(doc.id, `${doc.content}\n# dirty`);

      mockTauriService.pickOpenFolderPath.mockResolvedValueOnce('/next-workspace');
      mockDialogConfirm.mockResolvedValueOnce('dismiss' as 'confirm' | 'cancel' | 'dismiss');

      await workbench.openFolder();

      expect(editorStore.documents.length).toBe(1);
      expect(editorStore.workspaceRootPath).toBeNull();
      expect(mockTauriService.saveScript).not.toHaveBeenCalled();
    });

    it('切换工作区前保存脏文档后再切换目录', async () => {
      editorStore.openDocumentTab({
        path: '/workspace/current.sh',
        name: 'current.sh',
        content: '#!/bin/bash\necho before',
        encoding: 'utf-8',
      });
      const doc = editorStore.documents[0]!;
      editorStore.updateDocumentContent(doc.id, '#!/bin/bash\necho updated');

      mockTauriService.pickOpenFolderPath.mockResolvedValueOnce('/next-workspace');
      mockDialogConfirm.mockResolvedValueOnce('confirm' as 'confirm' | 'cancel' | 'dismiss');
      mockTauriService.saveScript.mockResolvedValueOnce({
        path: '/workspace/current.sh',
        name: 'current.sh',
        content: '#!/bin/bash\necho updated',
        encoding: 'utf-8',
        lineCount: 2,
        charCount: 23,
      });
      mockTauriService.getGitRepositoryStatus.mockResolvedValueOnce(createEmptyGitStatusPayload());

      await workbench.openFolder();
      await Promise.resolve();

      expect(mockTauriService.saveScript).toHaveBeenCalledOnce();
      expect(editorStore.workspaceRootPath).toBe('/next-workspace');
    });
  });

  describe('openDocumentByPath()', () => {
    it('工作区切换后忽略旧文件读取结果，避免旧标签回灌', async () => {
      editorStore.setWorkspaceRootPath('/workspace-a');
      const deferred = createDeferred<ReturnType<typeof createScriptPayload>>();
      mockTauriService.loadScript.mockReturnValueOnce(deferred.promise);

      const opening = workbench.openDocumentByPath('/workspace-a/old.sh');
      expect(mockTauriService.loadScript).toHaveBeenCalledWith(
        '/workspace-a/old.sh',
        '/workspace-a',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );

      editorStore.setWorkspaceRootPath('/workspace-b');
      deferred.resolve(createScriptPayload('/workspace-a/old.sh'));
      await opening;

      expect(editorStore.documents).toHaveLength(0);
      expect(mockMessages.success).not.toHaveBeenCalledWith('已打开 old.sh');
    });

    it('连续打开文件时取消前一个未完成读取，只保留最新文件', async () => {
      editorStore.setWorkspaceRootPath('/workspace');
      const first = createDeferred<ReturnType<typeof createScriptPayload>>();
      const second = createDeferred<ReturnType<typeof createScriptPayload>>();
      mockTauriService.loadScript
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);

      const firstOpening = workbench.openDocumentByPath('/workspace/first.sh');
      const firstSignal = mockTauriService.loadScript.mock.calls[0]?.[2]?.signal as AbortSignal;

      const secondOpening = workbench.openDocumentByPath('/workspace/second.sh');
      expect(firstSignal.aborted).toBe(true);

      first.resolve(createScriptPayload('/workspace/first.sh'));
      second.resolve(createScriptPayload('/workspace/second.sh'));
      await Promise.all([firstOpening, secondOpening]);

      expect(editorStore.documents.map((document) => document.path)).toEqual([
        '/workspace/second.sh',
      ]);
      expect(editorStore.document.path).toBe('/workspace/second.sh');
    });
  });

  // ── 4. saveDocument ──
  describe('saveDocument()', () => {
    it('已有路径时调用 tauriService.saveScript 并返回 true', async () => {
      editorStore.openDocumentTab({
        path: '/home/test/script.sh',
        name: 'script.sh',
        content: '#!/bin/bash\necho hi',
        encoding: 'utf-8',
      });
      const doc = editorStore.documents[0]!;
      editorStore.updateDocumentContent(doc.id, '#!/bin/bash\necho updated');

      mockTauriService.saveScript.mockResolvedValueOnce({
        path: '/home/test/script.sh',
        name: 'script.sh',
        content: '#!/bin/bash\necho updated',
        encoding: 'utf-8',
        isDirty: false,
      });

      const result = await workbench.saveDocument(doc.id);

      expect(mockTauriService.saveScript).toHaveBeenCalledOnce();
      expect(result).toBe(true);
    });
  });

  // ── 5. runScript ──
  describe('runScript()', () => {
    it('canRun=false 时发出 warning 且 isRunning 保持 false', async () => {
      await workbench.runScript();
      expect(mockMessages.warning).toHaveBeenCalledOnce();
      expect(editorStore.isRunning).toBe(false);
    });

    it('当前文件不是脚本文件时不会派发运行', async () => {
      editorStore.createDocumentTab({
        name: 'notes.txt',
        content: '#!/bin/bash\necho hi',
      });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      await workbench.runScript();

      expect(workbench.canRun.value).toBe(false);
      expect(mockMessages.warning).toHaveBeenCalledWith(
        '当前文件不是脚本文件，仅支持运行 .sh / .bash 脚本。',
      );
      expect(mockTauriService.dispatchScriptToTerminal).not.toHaveBeenCalled();
      expect(editorStore.isRunning).toBe(false);
    });

    it('canRun=true 时 dispatch 后 isRunning 为 true', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      mockTauriService.dispatchScriptToTerminal.mockResolvedValueOnce({
        sessionId: 'main-terminal',
        cwd: '/home',
        commandLine: 'bash /tmp/script.sh',
        usedTempFile: true,
        startedAt: new Date().toISOString(),
      });

      await workbench.runScript();

      expect(editorStore.isRunning).toBe(true);
      expect(mockTauriService.dispatchScriptToTerminal).toHaveBeenCalledOnce();
    });

    it('派发脚本时携带工作区根目录，确保 run cwd 不继承交互终端当前目录', async () => {
      editorStore.workspaceRootPath = '/workspace';
      editorStore.openDocumentTab({
        path: '/workspace/scripts/hello.sh',
        name: 'hello.sh',
        content: '#!/bin/bash\necho hi',
        encoding: 'utf-8',
      });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      mockTauriService.dispatchScriptToTerminal.mockResolvedValueOnce({
        sessionId: 'main-terminal',
        cwd: '/workspace',
        commandLine: 'bash /workspace/scripts/hello.sh',
        usedTempFile: false,
        startedAt: new Date().toISOString(),
      });

      await workbench.runScript();

      expect(mockTauriService.dispatchScriptToTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          path: '/workspace/scripts/hello.sh',
          workspaceRootPath: '/workspace',
        }),
      );
    });

    it('派发前先确保终端事件监听已注册，避免遗漏完成事件', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      const terminalRegistryStore = useTerminalRegistryStore();
      const registerEventListeners = vi.fn(() => Promise.resolve());
      terminalRegistryStore.set('main-terminal', {
        registerEventListeners,
      } as never);

      mockTauriService.dispatchScriptToTerminal.mockResolvedValueOnce({
        sessionId: 'main-terminal',
        cwd: '/home',
        commandLine: 'bash /tmp/script.sh',
        usedTempFile: true,
        startedAt: new Date().toISOString(),
      });

      await workbench.runScript();

      expect(registerEventListeners).toHaveBeenCalledOnce();
      expect(mockTauriService.dispatchScriptToTerminal).toHaveBeenCalledOnce();
    });

    it('直接收到 terminal:run-completed 事件时也能收口运行态，不依赖 UI 转发链', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      let capturedRunId = '';
      mockTauriService.dispatchScriptToTerminal.mockImplementation((req: { runId: string }) => {
        capturedRunId = req.runId;
        return Promise.resolve({
          sessionId: 'main-terminal',
          cwd: '/home',
          commandLine: 'bash /tmp/script.sh',
          usedTempFile: true,
          startedAt: new Date().toISOString(),
        });
      });

      await workbench.runScript();

      const runCompletedHandler = capturedTerminalEventListeners.get('terminal:run-completed');
      expect(runCompletedHandler).toBeDefined();

      runCompletedHandler?.({
        payload: {
          sessionId: 'main-terminal',
          runId: capturedRunId,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
        },
      });

      expect(editorStore.isRunning).toBe(false);
      expect(editorStore.pendingTerminalRunId).toBeNull();
      expect(editorStore.runHistory.length).toBe(1);
      expect(editorStore.lastRunResult?.exitCode).toBe(0);
    });

    it('run-completed 成功后忽略迟到失败收口，避免运行日志误判失败', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      let capturedRunId = '';
      mockTauriService.dispatchScriptToTerminal.mockImplementation((req: { runId: string }) => {
        capturedRunId = req.runId;
        return Promise.resolve({
          sessionId: 'main-terminal',
          cwd: '/home',
          commandLine: 'bash /tmp/script.sh',
          usedTempFile: true,
          startedAt: new Date().toISOString(),
        });
      });

      await workbench.runScript();

      const runCompletedHandler = capturedTerminalEventListeners.get('terminal:run-completed');
      const exitHandler = capturedTerminalEventListeners.get('terminal:interactive-exited');
      expect(runCompletedHandler).toBeDefined();
      expect(exitHandler).toBeDefined();

      runCompletedHandler?.({
        payload: {
          sessionId: 'main-terminal',
          runId: capturedRunId,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
        },
      });
      exitHandler?.({
        payload: {
          sessionId: 'main-terminal',
          exitCode: -1,
        },
      });

      const finalLogs = editorStore.runLogs.filter(
        (item) =>
          item.runId === capturedRunId &&
          (item.code === 'terminal-run/completed' || item.code === 'terminal-run/failed'),
      );

      expect(editorStore.lastRunResult?.success).toBe(true);
      expect(editorStore.lastRunResult?.exitCode).toBe(0);
      expect(editorStore.runHistory.length).toBe(1);
      expect(finalLogs.map((item) => item.code)).toEqual(['terminal-run/completed']);
    });

    it('child wait 事件流通过 terminal:run-chunk / terminal:run-completed 收口运行态', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      let capturedRunId = '';
      mockTauriService.dispatchScriptToTerminal.mockImplementation((req: { runId: string }) => {
        capturedRunId = req.runId;
        return Promise.resolve({
          sessionId: 'main-terminal',
          cwd: '/home',
          commandLine: "/bin/bash '/tmp/script-123.tmp.sh'",
          usedTempFile: true,
          startedAt: new Date().toISOString(),
        });
      });

      await workbench.runScript();

      const runCompletedHandler = capturedTerminalEventListeners.get('terminal:run-completed');
      expect(runCompletedHandler).toBeDefined();

      runCompletedHandler?.({
        payload: {
          sessionId: 'main-terminal',
          runId: capturedRunId,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
        },
      });

      expect(editorStore.isRunning).toBe(false);
      expect(editorStore.lastRunResult?.stdout ?? '').not.toContain('script-123.tmp.sh');
    });

    it('收到 terminal:interactive-exited 事件时会兜底收口，并允许下一次重新创建终端会话', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      let firstRunId = '';
      mockTauriService.dispatchScriptToTerminal.mockImplementationOnce((req: { runId: string }) => {
        firstRunId = req.runId;
        return Promise.resolve({
          sessionId: 'main-terminal',
          cwd: '/home',
          commandLine: 'bash /tmp/script.sh',
          usedTempFile: true,
          startedAt: new Date().toISOString(),
        });
      });

      await workbench.runScript();

      const exitHandler = capturedTerminalEventListeners.get('terminal:interactive-exited');
      expect(exitHandler).toBeDefined();

      exitHandler?.({
        payload: {
          sessionId: 'main-terminal',
          exitCode: 130,
        },
      });

      expect(editorStore.isRunning).toBe(false);
      expect(editorStore.pendingTerminalRunId).toBeNull();
      expect(editorStore.lastRunResult?.runId).toBe(firstRunId);
      expect(editorStore.lastRunResult?.exitCode).toBe(130);

      mockTauriService.dispatchScriptToTerminal.mockResolvedValueOnce({
        sessionId: 'main-terminal',
        cwd: '/home',
        commandLine: 'bash /tmp/script.sh',
        usedTempFile: true,
        startedAt: new Date().toISOString(),
      });

      await workbench.runScript();

      expect(mockTauriService.ensureTerminalSession).toHaveBeenCalledTimes(2);
    });

    it('运行中重复触发时不重复派发脚本', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });
      editorStore.isRunning = true;

      await workbench.runScript();

      expect(mockMessages.warning).toHaveBeenCalledWith(
        '已有脚本正在运行，请等待完成或先停止当前运行。',
      );
      expect(mockTauriService.dispatchScriptToTerminal).not.toHaveBeenCalled();
      expect(editorStore.isRunning).toBe(true);
    });

    it('作用域销毁时保留应用级运行态，由编排器显式重置时清理', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      mockTauriService.dispatchScriptToTerminal.mockResolvedValueOnce({
        sessionId: 'main-terminal',
        cwd: '/home',
        commandLine: 'bash /tmp/script.sh',
        usedTempFile: true,
        startedAt: new Date().toISOString(),
      });

      await workbench.runScript();

      expect(editorStore.isRunning).toBe(true);
      expect(editorStore.pendingTerminalRunId).not.toBeNull();

      scope.stop();

      expect(editorStore.isRunning).toBe(true);
      expect(editorStore.pendingTerminalRunId).not.toBeNull();

      __resetTerminalRunOrchestratorForTesting();

      expect(editorStore.isRunning).toBe(false);
      expect(editorStore.pendingTerminalRunId).toBeNull();
      expect(editorStore.activeRunSummary).toBeNull();
    });
  });

  // ── 6. handleIntegratedTerminalRunCompleted ──
  describe('handleIntegratedTerminalRunCompleted()', () => {
    it('runId 匹配时清除 isRunning 并写入运行历史', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      let capturedRunId = '';
      mockTauriService.dispatchScriptToTerminal.mockImplementation((req: { runId: string }) => {
        capturedRunId = req.runId;
        return Promise.resolve({
          sessionId: 'main-terminal',
          cwd: '/home',
          commandLine: 'bash /tmp/script.sh',
          usedTempFile: true,
          startedAt: new Date().toISOString(),
        });
      });

      await workbench.runScript();

      const finishedAt = new Date().toISOString();
      workbench.handleIntegratedTerminalRunCompleted({
        sessionId: 'main-terminal',
        runId: capturedRunId,
        exitCode: 0,
        finishedAt,
      });

      expect(editorStore.isRunning).toBe(false);
      expect(editorStore.runHistory.length).toBe(1);
      expect(editorStore.runHistory[0]?.exitCode).toBe(0);
    });

    it('完成事件缺失 runId 时回退到当前活跃运行进行收口', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      mockTauriService.dispatchScriptToTerminal.mockResolvedValueOnce({
        sessionId: 'main-terminal',
        cwd: '/home',
        commandLine: 'bash /tmp/script.sh',
        usedTempFile: true,
        startedAt: new Date().toISOString(),
      });

      await workbench.runScript();

      expect(editorStore.isRunning).toBe(true);
      expect(editorStore.pendingTerminalRunId).not.toBeNull();

      workbench.handleIntegratedTerminalRunCompleted({
        sessionId: 'main-terminal',
        runId: '',
        exitCode: 0,
        finishedAt: new Date().toISOString(),
      });

      expect(editorStore.isRunning).toBe(false);
      expect(editorStore.pendingTerminalRunId).toBeNull();
      expect(editorStore.runHistory.length).toBe(1);
      expect(editorStore.lastRunResult?.exitCode).toBe(0);
    });

    it('runId 不匹配当前运行时不误清新的运行态', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      mockTauriService.dispatchScriptToTerminal.mockResolvedValueOnce({
        sessionId: 'main-terminal',
        cwd: '/home',
        commandLine: 'bash /tmp/script.sh',
        usedTempFile: true,
        startedAt: new Date().toISOString(),
      });

      await workbench.runScript();

      workbench.handleIntegratedTerminalRunCompleted({
        sessionId: 'main-terminal',
        runId: 'another-run-id',
        exitCode: 0,
        finishedAt: new Date().toISOString(),
      });

      expect(editorStore.isRunning).toBe(true);
      expect(editorStore.pendingTerminalRunId).not.toBeNull();
      expect(editorStore.runHistory.length).toBe(0);
    });

    it('重复完成事件保持幂等，不重复追加运行历史', async () => {
      editorStore.createDocumentTab({ content: '#!/bin/bash\necho hi' });
      editorStore.setEnvironment({ hasAny: true, executors: [], recommended: 'wsl' });

      let capturedRunId = '';
      mockTauriService.dispatchScriptToTerminal.mockImplementation((req: { runId: string }) => {
        capturedRunId = req.runId;
        return Promise.resolve({
          sessionId: 'main-terminal',
          cwd: '/home',
          commandLine: 'bash /tmp/script.sh',
          usedTempFile: true,
          startedAt: new Date().toISOString(),
        });
      });

      await workbench.runScript();

      const payload = {
        sessionId: 'main-terminal',
        runId: capturedRunId,
        exitCode: 0,
        finishedAt: new Date().toISOString(),
      };

      workbench.handleIntegratedTerminalRunCompleted(payload);
      workbench.handleIntegratedTerminalRunCompleted(payload);

      expect(editorStore.isRunning).toBe(false);
      expect(editorStore.runHistory.length).toBe(1);
    });
  });

  // ── 7. toggleTheme ──
  describe('toggleTheme()', () => {
    it('从 dark 切换为 light', () => {
      appStore.applyTheme('dark');
      workbench.toggleTheme();
      expect(appStore.settings.appearance.themePreference).toBe('light');
    });

    it('从 light 切换为 dark', () => {
      appStore.applyTheme('light');
      workbench.toggleTheme();
      expect(appStore.settings.appearance.themePreference).toBe('dark');
    });
  });

  // ── 8. requestCloseApplication ──
  describe('requestCloseApplication()', () => {
    it('无脏文档时直接关闭窗口', async () => {
      await workbench.requestCloseApplication();
      expect(mockAppWindow.close).toHaveBeenCalledOnce();
    });

    it('有脏文档且选取消时不关闭窗口', async () => {
      workbench.createNewDocument();
      const doc = editorStore.documents[0]!;
      editorStore.updateDocumentContent(doc.id, `${doc.content}\n# dirty`);

      mockDialogConfirm.mockResolvedValueOnce('dismiss' as 'confirm' | 'cancel' | 'dismiss');
      await workbench.requestCloseApplication();

      expect(mockAppWindow.close).not.toHaveBeenCalled();
    });

    it('另存为选择器报错时不中断关闭流程并给出错误提示', async () => {
      workbench.createNewDocument();
      const doc = editorStore.documents[0]!;
      editorStore.updateDocumentContent(doc.id, `${doc.content}\n# dirty`);

      mockDialogConfirm.mockResolvedValueOnce('confirm' as 'confirm' | 'cancel' | 'dismiss');
      mockTauriService.pickSavePath.mockRejectedValueOnce(new Error('dialog load failed'));

      await expect(workbench.requestCloseApplication()).resolves.toBeUndefined();

      expect(mockAppWindow.close).not.toHaveBeenCalled();
      expect(mockMessages.error).toHaveBeenCalled();
    });
  });
});
