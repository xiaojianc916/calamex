import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PropType } from 'vue';
import { defineComponent } from 'vue';

const {
  initializeMock,
  restoreSessionMock,
  appendLogMock,
  saveDocumentMock,
  setAiPanelWidthMock,
  setTerminalPanelHeightMock,
  setWorkbenchPrimaryModeMock,
  setWorkbenchSessionStateMock,
  appStoreState,
  sessionSnapshotState,
  waitForDesktopRuntimeMock,
  shortcutState,
} = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  restoreSessionMock: vi.fn(),
  appendLogMock: vi.fn(),
  saveDocumentMock: vi.fn(),
  setAiPanelWidthMock: vi.fn((value: number) => {
    appStoreState.aiPanelWidth = value;
  }),
  setTerminalPanelHeightMock: vi.fn((value: number) => {
    appStoreState.terminalPanelHeight = value;
  }),
  setWorkbenchPrimaryModeMock: vi.fn((value: 'editor' | 'ai') => {
    appStoreState.workbenchPrimaryMode = value;
  }),
  setWorkbenchSessionStateMock: vi.fn(
    (patch: {
      activeSidebarView?: 'explorer' | 'search' | 'source-control' | 'run' | 'ai' | 'extensions';
      explorerExpandedPaths?: string[];
      explorerSelectedPath?: string | null;
      isTerminalVisible?: boolean;
    }) => {
      sessionSnapshotState.workbench = {
        ...sessionSnapshotState.workbench,
        ...patch,
      };
    },
  ),
  appStoreState: {
    aiPanelWidth: 450,
    terminalPanelHeight: 236,
    workbenchPrimaryMode: 'editor' as 'editor' | 'ai',
  },
  sessionSnapshotState: {
    schemaVersion: 1 as const,
    workspaceRoot: null as string | null,
    openTabs: [] as Array<{
      path: string;
      pinned: boolean;
      order: number;
      kind?: 'text' | 'image';
    }>,
    activeTabPath: null as string | null,
    viewStates: [],
    workbench: {
      activeSidebarView: 'explorer' as
        | 'explorer'
        | 'search'
        | 'source-control'
        | 'run'
        | 'ai'
        | 'extensions',
      explorerExpandedPaths: [] as string[],
      explorerSelectedPath: null as string | null,
      isTerminalVisible: true,
    },
    recentWorkspaces: [],
    recentFiles: [],
    savedAt: '2026-05-07T00:00:00.000Z',
  },
  waitForDesktopRuntimeMock: vi.fn(),
  shortcutState: {
    canSave: false,
    isDesktopRuntime: true,
  },
}));

vi.mock('@/app/composables/useWorkbench', () => ({
  useWorkbench: () => ({
    appStore: {
      theme: 'dark',
      settings: {
        editor: {},
        terminal: {},
      },
      get aiPanelWidth() {
        return appStoreState.aiPanelWidth;
      },
      get terminalPanelHeight() {
        return appStoreState.terminalPanelHeight;
      },
      get workbenchPrimaryMode() {
        return appStoreState.workbenchPrimaryMode;
      },
      setAiPanelWidth: setAiPanelWidthMock,
      setTerminalPanelHeight: setTerminalPanelHeightMock,
      setWorkbenchPrimaryMode: setWorkbenchPrimaryModeMock,
    },
    editorStore: {
      hasActiveDocument: false,
      document: {
        id: 'document-1',
        name: 'demo.sh',
        path: null,
        kind: 'text',
        content: '',
        encoding: 'utf-8',
        isDirty: false,
        charCount: 0,
      },
      selectedExecutor: 'wsl',
      runHistory: [],
      runLogs: [],
      lastRunResult: null,
      isRunning: false,
      activeSelectionSummary: null,
      workspaceRootPath: null,
      activeRunSummary: null,
      documents: [],
      sessionSnapshot: sessionSnapshotState,
      cursorLine: 1,
      cursorColumn: 1,
      setCursorPosition: vi.fn(),
      setActiveSelectionSummary: vi.fn(),
      clearLogs: vi.fn(),
      appendLog: appendLogMock,
      setWorkbenchSessionState: setWorkbenchSessionStateMock,
    },
    isDesktopRuntime: {
      get value() {
        return shortcutState.isDesktopRuntime;
      },
    },
    canRun: false,
    canSave: {
      get value() {
        return shortcutState.canSave;
      },
    },
    commandTemplates: [],
    commentTemplates: [],
    initialize: initializeMock,
    restoreSession: restoreSessionMock,
    createNewDocument: vi.fn(),
    openDocument: vi.fn(),
    openFolder: vi.fn(),
    openDocumentByPath: vi.fn(),
    formatDocumentWithShfmt: vi.fn(),
    saveDocument: saveDocumentMock,
    saveDocumentAs: vi.fn(),
    requestCloseDocument: vi.fn(),
    requestCloseWorkspace: vi.fn(),
    requestCloseApplication: vi.fn(),
    activateDocument: vi.fn(),
    runScript: vi.fn(),
    handleIntegratedTerminalRunCompleted: vi.fn(),
    updateContent: vi.fn(),
    updateEncoding: vi.fn(),
    toggleTheme: vi.fn(),
    notifyTemplateInserted: vi.fn(),
  }),
}));

vi.mock('@/domains/git/state/git', () => ({
  useGitStore: () => ({
    status: {
      headBranchName: null,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
    },
  }),
}));

vi.mock('@/utils/platform/desktop-runtime', () => ({
  waitForDesktopRuntime: waitForDesktopRuntimeMock,
}));

import { useShellWorkbenchView } from '@/app/composables/useShellWorkbenchView';

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
};

const TestHost = defineComponent({
  props: {
    onReady: {
      type: Function as PropType<() => void>,
      required: true,
    },
  },
  setup(props) {
    const {
      editorViewportRef,
      handleSelectSidebarView,
      handleAiPanelWidthChange,
      handleTerminalHeightChange,
      isSidebarVisible,
      isTerminalVisible,
      activeSidebarView,
      aiPanelWidth,
      isEditorMode,
      isAiMode,
      terminalHeight,
      openEditorMode,
      openTerminal,
      startupExplorerExpandedPaths,
      startupExplorerSelectedPath,
      visibleWorkspaceRootPath,
    } = useShellWorkbenchView(props.onReady);
    return {
      editorViewportRef,
      handleSelectSidebarView,
      handleAiPanelWidthChange,
      handleTerminalHeightChange,
      isSidebarVisible,
      isTerminalVisible,
      activeSidebarView,
      aiPanelWidth,
      isEditorMode,
      isAiMode,
      terminalHeight,
      openEditorMode,
      openTerminal,
      startupExplorerExpandedPaths,
      startupExplorerSelectedPath,
      visibleWorkspaceRootPath,
    };
  },
  template: '<div ref="editorViewportRef"></div>',
});

describe('useShellWorkbenchView', () => {
  beforeEach(() => {
    vi.useRealTimers();
    initializeMock.mockReset();
    restoreSessionMock.mockReset();
    appendLogMock.mockReset();
    saveDocumentMock.mockReset();
    waitForDesktopRuntimeMock.mockReset();
    setAiPanelWidthMock.mockClear();
    setTerminalPanelHeightMock.mockClear();
    setWorkbenchPrimaryModeMock.mockClear();
    setWorkbenchSessionStateMock.mockClear();
    appStoreState.aiPanelWidth = 450;
    appStoreState.terminalPanelHeight = 236;
    appStoreState.workbenchPrimaryMode = 'editor';
    sessionSnapshotState.workspaceRoot = null;
    sessionSnapshotState.openTabs = [];
    sessionSnapshotState.activeTabPath = null;
    sessionSnapshotState.viewStates = [];
    sessionSnapshotState.workbench = {
      activeSidebarView: 'explorer',
      explorerExpandedPaths: [],
      explorerSelectedPath: null,
      isTerminalVisible: true,
    };
    sessionSnapshotState.recentWorkspaces = [];
    sessionSnapshotState.recentFiles = [];
    sessionSnapshotState.savedAt = '2026-05-07T00:00:00.000Z';
    shortcutState.canSave = false;
    shortcutState.isDesktopRuntime = true;

    initializeMock.mockResolvedValue({ startupWorkspaceDirectory: null });
    saveDocumentMock.mockResolvedValue(true);
    waitForDesktopRuntimeMock.mockResolvedValue(false);

    if (typeof window.requestAnimationFrame !== 'function') {
      Object.defineProperty(window, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0),
      });
    }

    if (typeof window.cancelAnimationFrame !== 'function') {
      Object.defineProperty(window, 'cancelAnimationFrame', {
        configurable: true,
        writable: true,
        value: (handle: number) => window.clearTimeout(handle),
      });
    }

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('不会被慢 restoreSession 阻塞 ready 发射', async () => {
    const restoreDeferred = createDeferred();
    restoreSessionMock.mockReturnValue(restoreDeferred.promise);

    const onReady = vi.fn();
    const wrapper = mount(TestHost, {
      props: { onReady },
    });
    await flushPromises();

    expect(initializeMock).toHaveBeenCalledOnce();
    expect(restoreSessionMock).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
    expect(appendLogMock).not.toHaveBeenCalled();

    restoreDeferred.resolve();
    await flushPromises();

    wrapper.unmount();
  });

  it('ready 前直接保留真实工作台状态', async () => {
    const restoreDeferred = createDeferred();
    restoreSessionMock.mockReturnValue(restoreDeferred.promise);
    sessionSnapshotState.workspaceRoot = '/workspace';
    sessionSnapshotState.workbench = {
      activeSidebarView: 'source-control',
      explorerExpandedPaths: ['/workspace', '/workspace/src'],
      explorerSelectedPath: '/workspace/src/a.sh',
      isTerminalVisible: false,
    };

    const onReady = vi.fn();
    const wrapper = mount(TestHost, {
      props: { onReady },
    });
    await flushPromises();

    expect(onReady).toHaveBeenCalledOnce();
    expect(wrapper.vm.visibleWorkspaceRootPath).toBeNull();
    expect(wrapper.vm.startupExplorerExpandedPaths).toEqual(['/workspace', '/workspace/src']);
    expect(wrapper.vm.startupExplorerSelectedPath).toBe('/workspace/src/a.sh');
    expect(wrapper.vm.activeSidebarView).toBe('source-control');
    expect(wrapper.vm.isTerminalVisible).toBe(false);

    restoreDeferred.resolve();
    await flushPromises();

    wrapper.unmount();
  });

  it('在 requestAnimationFrame 不触发时会走超时回退并发出 ready', async () => {
    vi.useFakeTimers();
    restoreSessionMock.mockResolvedValue(undefined);

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    const onReady = vi.fn();
    const wrapper = mount(TestHost, {
      props: { onReady },
    });
    await flushPromises();

    expect(onReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);
    await flushPromises();

    expect(onReady).toHaveBeenCalledOnce();

    wrapper.unmount();
  });

  it('按 Ctrl+S 时保存当前文件并拦截浏览器默认保存', async () => {
    shortcutState.canSave = true;

    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      cancelable: true,
    });

    expect(window.dispatchEvent(event)).toBe(false);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(saveDocumentMock).toHaveBeenCalledOnce();

    wrapper.unmount();
  });

  it('无可保存文件时 Ctrl+S 只拦截默认行为', async () => {
    shortcutState.canSave = false;

    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      cancelable: true,
    });

    expect(window.dispatchEvent(event)).toBe(false);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(saveDocumentMock).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it('重复点击源代码管理会保持左侧边栏显示', async () => {
    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    await wrapper.vm.handleSelectSidebarView('source-control');
    expect(wrapper.vm.activeSidebarView).toBe('source-control');
    expect(wrapper.vm.isSidebarVisible).toBe(true);

    await wrapper.vm.handleSelectSidebarView('source-control');
    expect(wrapper.vm.activeSidebarView).toBe('source-control');
    expect(wrapper.vm.isSidebarVisible).toBe(true);

    wrapper.unmount();
  });

  it('选择 AI 入口会切换到 AI 主界面', async () => {
    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    expect(wrapper.vm.isEditorMode).toBe(true);
    expect(wrapper.vm.isAiMode).toBe(false);

    await wrapper.vm.handleSelectSidebarView('ai');

    expect(wrapper.vm.isEditorMode).toBe(false);
    expect(wrapper.vm.isAiMode).toBe(true);
    expect(wrapper.vm.activeSidebarView).toBe('explorer');

    wrapper.vm.openEditorMode();
    await flushPromises();

    expect(wrapper.vm.isEditorMode).toBe(true);
    expect(wrapper.vm.isAiMode).toBe(false);

    wrapper.unmount();
  });

  it('切到 AI 主界面会保留终端可见状态，且 AI 模式下 openTerminal 不生效', async () => {
    sessionSnapshotState.workbench.isTerminalVisible = false;

    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    expect(wrapper.vm.isTerminalVisible).toBe(false);

    await wrapper.vm.handleSelectSidebarView('ai');

    expect(wrapper.vm.isAiMode).toBe(true);
    expect(wrapper.vm.isTerminalVisible).toBe(false);

    await wrapper.vm.openTerminal();

    expect(wrapper.vm.isTerminalVisible).toBe(false);

    wrapper.vm.openEditorMode();
    await wrapper.vm.openTerminal();

    expect(wrapper.vm.isTerminalVisible).toBe(true);

    wrapper.unmount();
  });

  it('AI 主界面下切换侧栏不会切回编辑区', async () => {
    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    await wrapper.vm.handleSelectSidebarView('ai');
    expect(wrapper.vm.isAiMode).toBe(true);
    expect(wrapper.vm.isEditorMode).toBe(false);

    await wrapper.vm.handleSelectSidebarView('source-control');

    expect(wrapper.vm.activeSidebarView).toBe('source-control');
    expect(wrapper.vm.isAiMode).toBe(true);
    expect(wrapper.vm.isEditorMode).toBe(false);

    wrapper.unmount();
  });

  it('会恢复上次主界面模式，并在切换时写回 store', async () => {
    appStoreState.workbenchPrimaryMode = 'ai';

    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    expect(wrapper.vm.isEditorMode).toBe(false);
    expect(wrapper.vm.isAiMode).toBe(true);
    expect(wrapper.vm.isTerminalVisible).toBe(true);

    wrapper.vm.openEditorMode();
    await flushPromises();

    expect(wrapper.vm.isEditorMode).toBe(true);
    expect(wrapper.vm.isAiMode).toBe(false);
    expect(setWorkbenchPrimaryModeMock).toHaveBeenLastCalledWith('editor');
    expect(appStoreState.workbenchPrimaryMode).toBe('editor');

    await wrapper.vm.handleSelectSidebarView('ai');

    expect(wrapper.vm.isAiMode).toBe(true);
    expect(wrapper.vm.isTerminalVisible).toBe(true);
    expect(setWorkbenchPrimaryModeMock).toHaveBeenLastCalledWith('ai');
    expect(appStoreState.workbenchPrimaryMode).toBe('ai');

    wrapper.unmount();
  });

  it('会恢复上次 AI 面板宽度，并在拖拽后写回 store', async () => {
    appStoreState.aiPanelWidth = 512;

    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    expect(wrapper.vm.aiPanelWidth).toBe(512);

    wrapper.vm.handleAiPanelWidthChange(531);

    expect(wrapper.vm.aiPanelWidth).toBe(531);
    expect(setAiPanelWidthMock).toHaveBeenLastCalledWith(531);
    expect(appStoreState.aiPanelWidth).toBe(531);

    wrapper.unmount();
  });

  it('会恢复上次终端高度，并在拖拽后写回 store', async () => {
    appStoreState.terminalPanelHeight = 318;

    const wrapper = mount(TestHost, {
      props: { onReady: vi.fn() },
    });
    await flushPromises();

    expect(wrapper.vm.terminalHeight).toBe(318);

    wrapper.vm.handleTerminalHeightChange(344);

    expect(wrapper.vm.terminalHeight).toBe(344);
    expect(setTerminalPanelHeightMock).toHaveBeenLastCalledWith(344);
    expect(appStoreState.terminalPanelHeight).toBe(344);

    wrapper.unmount();
  });
});
