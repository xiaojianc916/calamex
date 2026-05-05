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
    appStoreState,
    waitForDesktopRuntimeMock,
    shortcutState,
} =
    vi.hoisted(() => ({
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
        appStoreState: {
            aiPanelWidth: 450,
            terminalPanelHeight: 236,
        },
        waitForDesktopRuntimeMock: vi.fn(),
        shortcutState: {
            canSave: false,
            isDesktopRuntime: true,
        },
    }));

vi.mock('@/composables/useWorkbench', () => ({
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
            setAiPanelWidth: setAiPanelWidthMock,
            setTerminalPanelHeight: setTerminalPanelHeightMock,
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
            activeDiagnostics: [],
            selectedExecutor: 'wsl',
            runHistory: [],
            runLogs: [],
            terminalOutputLength: 0,
            terminalOutputVersion: 0,
            getTerminalOutputSnapshot: () => '',
            lastRunResult: null,
            isRunning: false,
            activeScriptAnalysis: { diagnostics: [] },
            activeSelectionSummary: null,
            workspaceRootPath: null,
            activeRunSummary: null,
            cursorLine: 1,
            cursorColumn: 1,
            setCursorPosition: vi.fn(),
            setActiveSelectionSummary: vi.fn(),
            setDocumentAnalysis: vi.fn(),
            clearLogs: vi.fn(),
            appendLog: appendLogMock,
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
        appendTerminalOutput: vi.fn(),
        updateEncoding: vi.fn(),
        toggleTheme: vi.fn(),
        notifyTemplateInserted: vi.fn(),
    }),
}));

vi.mock('@/store/git', () => ({
    useGitStore: () => ({
        status: {
            headBranchName: null,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
        },
    }),
}));

vi.mock('@/utils/desktop-runtime', () => ({
    waitForDesktopRuntime: waitForDesktopRuntimeMock,
}));

import { useShellWorkbenchView } from '@/composables/useShellWorkbenchView';

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
            activeSidebarView,
            aiPanelWidth,
            isEditorMode,
            isAiMode,
            terminalHeight,
            openEditorMode,
        } = useShellWorkbenchView(props.onReady);
        return {
            editorViewportRef,
            handleSelectSidebarView,
            handleAiPanelWidthChange,
            handleTerminalHeightChange,
            isSidebarVisible,
            activeSidebarView,
            aiPanelWidth,
            isEditorMode,
            isAiMode,
            terminalHeight,
            openEditorMode,
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
        appStoreState.aiPanelWidth = 450;
        appStoreState.terminalPanelHeight = 236;
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

        vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
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

    it('重复点击源代码管理会收起左侧边栏', async () => {
        const wrapper = mount(TestHost, {
            props: { onReady: vi.fn() },
        });
        await flushPromises();

        await wrapper.vm.handleSelectSidebarView('source-control');
        expect(wrapper.vm.activeSidebarView).toBe('source-control');
        expect(wrapper.vm.isSidebarVisible).toBe(true);

        await wrapper.vm.handleSelectSidebarView('source-control');
        expect(wrapper.vm.isSidebarVisible).toBe(false);

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
