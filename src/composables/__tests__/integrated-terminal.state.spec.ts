/**
 * T-2.2 特征化测试：终端状态机快照
 * 目的：拆分前锁定 useIntegratedTerminal 状态转移行为，作为 T-2.3 的安全网。
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { useEditorStore } from '@/store/editor';
import { useTerminalRunRoutingStore } from '@/store/terminalRunRouting';
import {
  normalizeTerminalAnsiForTheme,
  stripInjectedRunSeparatorForTerminalData,
} from '@/terminal/session';
import type { TThemeMode } from '@/types/app';
import type { ITerminalSettings } from '@/types/settings';
import type { ITerminalStatusChangePayload } from '@/types/terminal';
import {
  useIntegratedTerminal,
  useIntegratedTerminalControls,
  useIntegratedTerminalStatus,
} from '../useIntegratedTerminal';

// ─────────────────────────────────────────────
// Mock 变量（vi.hoisted 保证提升前可访问）
const { capturedListeners, mockFitAddonInstance, mockTerminalInstance, mockTauriService } =
  vi.hoisted(() => {
    const capturedListeners = new Map<string, (event: { payload: unknown }) => void>();
    const mockFitAddonInstance = {
      fit: vi.fn(),
      dispose: vi.fn(),
    };

    const mockTerminalInstance = {
      open: vi.fn(),
      dispose: vi.fn(),
      // write 立即调用回调，避免死锁
      write: vi.fn((_data: string, cb?: () => void) => {
        cb?.();
      }),
      writeln: vi.fn((_data: string, cb?: () => void) => {
        cb?.();
      }),
      clear: vi.fn(),
      reset: vi.fn(),
      focus: vi.fn(),
      loadAddon: vi.fn(),
      getSelection: vi.fn(() => ''),
      onData: vi.fn(),
      onScroll: vi.fn(),
      onResize: vi.fn(),
      onSelectionChange: vi.fn(),
      scrollToBottom: vi.fn(),
      refresh: vi.fn(),
      clearTextureAtlas: vi.fn(),
      buffer: {
        active: {
          baseY: 0,
          cursorX: 0,
          cursorY: 0,
          viewportY: 0,
          length: 0,
          getLine: vi.fn(() => null),
        },
      },
      rows: 28,
      cols: 120,
      options: {} as Record<string, unknown>,
      element: null as HTMLElement | null,
    };

    const mockTauriService = {
      ensureTerminalSession: vi.fn(),
      writeTerminalInput: vi.fn(),
      resizeTerminalSession: vi.fn(),
      closeTerminalSession: vi.fn(),
      cancelTerminalRun: vi.fn(),
    };

    return { capturedListeners, mockFitAddonInstance, mockTerminalInstance, mockTauriService };
  });

// ─────────────────────────────────────────────
// Mock：@tauri-apps/api/event（捕获监听器）
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (eventName: string, handler: unknown) => {
    capturedListeners.set(eventName, handler as (event: { payload: unknown }) => void);
    return () => {
      capturedListeners.delete(eventName);
    };
  }),
}));

// ─────────────────────────────────────────────
// Mock：xterm
// ─────────────────────────────────────────────
vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(function Terminal(options: Record<string, unknown>) {
    mockTerminalInstance.options = { ...options };
    return mockTerminalInstance;
  }),
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function FitAddon() {
    return mockFitAddonInstance;
  }),
}));

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function WebglAddon() {
    return {
      dispose: vi.fn(),
      clearTextureAtlas: vi.fn(),
      onContextLoss: vi.fn(() => ({ dispose: vi.fn() })),
    };
  }),
}));

// ─────────────────────────────────────────────
// Mock：Tauri 服务层
vi.mock('@/services/tauri', () => ({
  tauriService: mockTauriService,
}));

// ─────────────────────────────────────────────
// Mock：desktop-runtime（始终就绪）
// ─────────────────────────────────────────────
vi.mock('@/utils/desktop-runtime', () => ({
  waitForDesktopRuntime: vi.fn(() => Promise.resolve(true)),
  desktopRuntimeReady: { value: true },
}));

// ─────────────────────────────────────────────
// Mock：clipboard（避免 jsdom 剪切板 API 错误）
vi.mock('@/utils/clipboard', () => ({
  writeClipboardText: vi.fn(() => Promise.resolve()),
}));

// ─────────────────────────────────────────────
// 默认终端设置
// ─────────────────────────────────────────────
const DEFAULT_TERMINAL_SETTINGS: ITerminalSettings = {
  defaultShell: '/bin/bash',
  shellArgs: '-il',
  workingDirectory: 'workspace-root',
  inheritEnvironment: true,
  fontFamily: '',
  fontSize: 13,
  lineHeight: '1.4',
  cursorStyle: 'bar',
  cursorBlink: true,
  scrollback: 1000,
  trimFinalNewlineOnCopy: true,
  copyOnSelect: false,
  rightClickBehavior: 'paste',
  bellMode: 'off',
  clickableLinks: true,
};

// ─────────────────────────────────────────────
// 测试组件工厂
// ─────────────────────────────────────────────
const createTestComponent = (
  statusChanges: ITerminalStatusChangePayload[],
  sessionId = 'main-terminal',
  initialTheme: TThemeMode = 'dark',
) =>
  defineComponent({
    setup() {
      const settings = ref<ITerminalSettings>(DEFAULT_TERMINAL_SETTINGS);
      const visible = ref(true);
      const theme = ref<TThemeMode>(initialTheme);

      const result = useIntegratedTerminal({
        settings,
        visible,
        theme,
        sessionId,
        onStatusChange: (p: ITerminalStatusChangePayload) => statusChanges.push(p),
      });

      return { ...result };
    },
    template: '<div ref="hostRef" style="width:800px;height:400px"></div>',
  });

// ─────────────────────────────────────────────
// 测试套件
// ─────────────────────────────────────────────
describe('suite 1', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    capturedListeners.clear();
    vi.clearAllMocks();
    mockFitAddonInstance.fit.mockReset();
    mockFitAddonInstance.dispose.mockClear();

    // 默认：ensureTerminalSession 成功
    mockTauriService.ensureTerminalSession.mockResolvedValue({
      sessionId: 'main-terminal',
      cwd: '/home/test',
      shellLabel: 'bash',
      created: true,
      initialOutput: null,
    });
    mockTauriService.writeTerminalInput.mockResolvedValue(undefined);
    mockTauriService.resizeTerminalSession.mockResolvedValue(undefined);
    mockTauriService.closeTerminalSession.mockResolvedValue(undefined);
    mockTauriService.cancelTerminalRun.mockResolvedValue(undefined);
    mockTerminalInstance.buffer.active.baseY = 0;
    mockTerminalInstance.buffer.active.cursorX = 0;
    mockTerminalInstance.buffer.active.cursorY = 0;
    mockTerminalInstance.buffer.active.viewportY = 0;
    mockTerminalInstance.buffer.active.length = 0;
    mockTerminalInstance.buffer.active.getLine.mockReturnValue(null);
    mockTerminalInstance.rows = 28;
    mockTerminalInstance.cols = 120;
    mockTerminalInstance.options = {};
  });

  // ── 1. 导出钩子的结果 ──
  describe('suite 2', () => {
    it('case 1', () => {
      const result = useIntegratedTerminalStatus();
      expect(result).toHaveProperty('status');
      expect(result).toHaveProperty('statusMessage');
    });

    it('浅色终端主题使用白色背景与指定文字色', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges, 'main-terminal', 'light'), {
        attachTo: document.body,
      });

      await flushPromises();

      expect(mockTerminalInstance.options.theme).toMatchObject({
        background: '#ffffff',
        foreground: '#1a1c1f',
        cursor: '#000000',
      });

      wrapper.unmount();
    });

    it('浅色终端写入前移除强制白字与黑底 ANSI', () => {
      expect(normalizeTerminalAnsiForTheme('\x1b[37m[test@Predator]$\x1b[40m ', 'light')).toBe(
        '\x1b[39m[test@Predator]$\x1b[49m ',
      );
      expect(normalizeTerminalAnsiForTheme('\x1b[1;97;100m提示\x1b[0m', 'light')).toBe(
        '\x1b[1;39;49m提示\x1b[0m',
      );
      expect(normalizeTerminalAnsiForTheme('\x1b[38;5;37m保留索引色', 'light')).toBe(
        '\x1b[38;5;37m保留索引色',
      );
      expect(normalizeTerminalAnsiForTheme('\x1b[37m深色保留', 'dark')).toBe('\x1b[37m深色保留');
    });

    it('复用已有终端实例时重新应用浅色主题', async () => {
      const pinia = createPinia();
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const firstWrapper = mount(createTestComponent(statusChanges, 'main-terminal', 'dark'), {
        global: { plugins: [pinia] },
        attachTo: document.body,
      });

      await flushPromises();
      firstWrapper.unmount();
      await flushPromises();

      const secondWrapper = mount(createTestComponent(statusChanges, 'main-terminal', 'light'), {
        global: { plugins: [pinia] },
        attachTo: document.body,
      });

      await flushPromises();

      expect(mockTerminalInstance.options.theme).toMatchObject({
        background: '#ffffff',
        foreground: '#1a1c1f',
        cursor: '#000000',
        cursorAccent: '#ffffff',
      });
      expect(mockTerminalInstance.refresh).toHaveBeenCalled();

      secondWrapper.unmount();
    });
  });

  describe('suite 3', () => {
    it('case 2', () => {
      const controls = useIntegratedTerminalControls();
      expect(controls).toHaveProperty('status');
      expect(controls).toHaveProperty('statusMessage');
      expect(controls).toHaveProperty('session');
      expect(controls).toHaveProperty('retry');
      expect(controls).toHaveProperty('clearScreen');
      expect(controls).toHaveProperty('interrupt');
      expect(controls).toHaveProperty('sendCommand');
    });

    it('case 3', async () => {
      const editorStore = useEditorStore();
      editorStore.isRunning = true;
      editorStore.setPendingTerminalRunId('run-1');

      const controls = useIntegratedTerminalControls();
      await controls.interrupt();

      expect(mockTauriService.cancelTerminalRun).toHaveBeenCalledWith({
        runId: 'run-1',
        mode: 'graceful',
      });
      expect(mockTauriService.writeTerminalInput).not.toHaveBeenCalled();
    });

    it('case 4', async () => {
      mockTauriService.cancelTerminalRun.mockRejectedValueOnce(
        new Error('当前运行路径不支持带外取消；请等待脚本自行结束。'),
      );

      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });
      await flushPromises();

      const editorStore = useEditorStore();
      editorStore.isRunning = true;
      editorStore.setPendingTerminalRunId('run-1');

      const controls = useIntegratedTerminalControls();
      await controls.interrupt();

      expect(mockTauriService.cancelTerminalRun).toHaveBeenCalledWith({
        runId: 'run-1',
        mode: 'graceful',
      });
      expect(mockTauriService.writeTerminalInput).toHaveBeenCalledWith({
        sessionId: 'main-terminal',
        data: '\u0003',
      });

      wrapper.unmount();
    });
  });

  // ── 2. 状态转移：connecting → ready ──
  describe('suite 4', () => {
    it('case 5', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      // 确认就绪
      const { status } = useIntegratedTerminalStatus();
      expect(status.value).toBe('ready');

      wrapper.unmount();
    });

    it('case 6', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const states = statusChanges.map((c) => c.state);
      expect(states).toContain('connecting');
      expect(states).toContain('ready');
      expect(states.indexOf('connecting')).toBeLessThan(states.indexOf('ready'));

      wrapper.unmount();
    });

    it('case 7', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      expect(mockTauriService.ensureTerminalSession).toHaveBeenCalledOnce();
      expect(mockTauriService.ensureTerminalSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'main-terminal' }),
      );

      wrapper.unmount();
    });

    it('case 8', async () => {
      mockTauriService.ensureTerminalSession
        .mockResolvedValueOnce({
          sessionId: 'main-terminal',
          cwd: '/home/test',
          shellLabel: 'bash',
          created: false,
          initialOutput: 'To run a command as administrator (user "root"), use "sudo <command>".\n',
        })
        .mockResolvedValueOnce({
          sessionId: 'main-terminal',
          cwd: '/home/test',
          shellLabel: 'bash',
          created: true,
          initialOutput: null,
        });

      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      expect(mockTauriService.closeTerminalSession).toHaveBeenCalledOnce();
      expect(mockTauriService.closeTerminalSession).toHaveBeenCalledWith({
        sessionId: 'main-terminal',
      });
      expect(mockTauriService.ensureTerminalSession).toHaveBeenCalledTimes(2);
      expect(mockTerminalInstance.write).not.toHaveBeenCalledWith(
        expect.stringContaining('To run a command as administrator'),
        expect.any(Function),
      );

      wrapper.unmount();
    });

    it('case 9', async () => {
      const pinia = createPinia();
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const firstWrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [pinia] },
        attachTo: document.body,
      });

      await flushPromises();
      firstWrapper.unmount();
      await flushPromises();

      const secondWrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [pinia] },
        attachTo: document.body,
      });

      await flushPromises();

      expect(mockTauriService.ensureTerminalSession).toHaveBeenCalledOnce();

      secondWrapper.unmount();
    });
  });

  // ── 3. 状态转移：connecting → error ──
  describe('suite 5', () => {
    it('case 10', async () => {
      mockTauriService.ensureTerminalSession.mockRejectedValue(new Error('connection refused'));

      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      // 确认状态
      const { status } = useIntegratedTerminalStatus();
      expect(status.value).toBe('error');

      wrapper.unmount();
    });
  });

  // ── 4. 状态转移：ready → closed（terminal:interactive-exited 事件）──
  describe('suite 6', () => {
    it('case 11', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      // 确认就绪
      const { status } = useIntegratedTerminalStatus();
      expect(status.value).toBe('ready');

      // 触发退出事件
      const exitHandler = capturedListeners.get('terminal:interactive-exited');
      expect(exitHandler).toBeDefined();
      exitHandler?.({ payload: { sessionId: 'main-terminal', exitCode: 0 } });

      expect(status.value).toBe('closed');

      wrapper.unmount();
    });

    it('case 12', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      // 触发其他会话的退出事件
      const exitHandler = capturedListeners.get('terminal:interactive-exited');
      exitHandler?.({ payload: { sessionId: 'OTHER-SESSION', exitCode: 0 } });

      // 确认状态未变
      const { status } = useIntegratedTerminalStatus();
      expect(status.value).toBe('ready'); // 保持不变

      wrapper.unmount();
    });
  });

  // ── 5. 事件监听注册 ──
  describe('suite 7', () => {
    it('case 13', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const { listen } = await import('@tauri-apps/api/event');
      expect(vi.mocked(listen)).toHaveBeenCalledWith('terminal:data', expect.any(Function));
      expect(vi.mocked(listen)).toHaveBeenCalledWith('terminal:run-chunk', expect.any(Function));
      expect(vi.mocked(listen)).toHaveBeenCalledWith(
        'terminal:run-completed',
        expect.any(Function),
      );
      expect(vi.mocked(listen)).toHaveBeenCalledWith(
        'terminal:interactive-exited',
        expect.any(Function),
      );

      wrapper.unmount();
    });
  });

  describe('suite 8', () => {
    it('case 14', async () => {
      const clientWidthSpy = vi
        .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
        .mockReturnValue(800);
      const clientHeightSpy = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockReturnValue(360);

      mockTerminalInstance.buffer.active.baseY = 20;
      mockTerminalInstance.buffer.active.viewportY = 20;
      mockTerminalInstance.buffer.active.length = 28;
      mockTerminalInstance.cols = 120;
      mockTerminalInstance.rows = 20;
      mockFitAddonInstance.fit.mockImplementation(() => {
        mockTerminalInstance.buffer.active.viewportY = 0;
        mockTerminalInstance.cols = 100;
        mockTerminalInstance.rows = 10;

        const scrollHandler = mockTerminalInstance.onScroll.mock.calls[0]?.[0] as
          | (() => void)
          | undefined;
        scrollHandler?.();

        const resizeHandler = mockTerminalInstance.onResize.mock.calls[0]?.[0] as
          | ((size: { cols: number; rows: number }) => void)
          | undefined;
        resizeHandler?.({ cols: 100, rows: 10 });
      });

      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 80));

      expect(mockFitAddonInstance.fit).toHaveBeenCalled();
      expect(mockTerminalInstance.scrollToBottom).toHaveBeenCalled();

      wrapper.unmount();
      clientWidthSpy.mockRestore();
      clientHeightSpy.mockRestore();
    });

    it('case 15', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();
      mockTerminalInstance.write.mockClear();

      const resizeHandler = mockTerminalInstance.onResize.mock.calls[0]?.[0] as
        | ((size: { cols: number; rows: number }) => void)
        | undefined;
      resizeHandler?.({ cols: 100, rows: 10 });

      const dataHandler = capturedListeners.get('terminal:data');
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          source: 'interactive',
          seq: 41,
          data: '\x1b[?25l\x1b[m\x1b[HTo run a command as administrator (user "root"), use "sudo <command>".\x1b[K\r\nSee "man sudo_root" for details.\x1b[K\r\n\x1b[K\x1b[37m\r[test@Predator]$\x1b[K\x1b[1C',
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          source: 'interactive',
          seq: 42,
          data: 'normal output after resize\r\n',
        },
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 32));

      const written = mockTerminalInstance.write.mock.calls.map((call) => call[0]).join('');
      expect(written).not.toContain('To run a command as administrator');
      expect(written).not.toContain('[test@Predator]$');
      expect(written).toContain('normal output after resize');

      wrapper.unmount();
    });

    it('case 16', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();
      const dataHandler = capturedListeners.get('terminal:data');
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          source: 'interactive',
          seq: 51,
          data: '\x1b[?1049h',
        },
      });
      await flushPromises();
      mockTerminalInstance.write.mockClear();

      const resizeHandler = mockTerminalInstance.onResize.mock.calls[0]?.[0] as
        | ((size: { cols: number; rows: number }) => void)
        | undefined;
      resizeHandler?.({ cols: 101, rows: 11 });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          source: 'interactive',
          seq: 52,
          data: '\x1b[?25l\x1b[Hvim repaint\x1b[K',
        },
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 32));

      const written = mockTerminalInstance.write.mock.calls.map((call) => call[0]).join('');
      expect(written).toContain('vim repaint');

      wrapper.unmount();
    });
  });

  // ── 6. 终端数据事件 ──
  describe('suite 9', () => {
    it('case 17', () => {
      expect(
        stripInjectedRunSeparatorForTerminalData(
          '──── run #7 · exit 0 · 1.2s ────\r\n[test@Predator ~]$ ',
        ),
      ).toBe('[test@Predator ~]$ ');

      expect(
        stripInjectedRunSeparatorForTerminalData(
          '\r\n──── run #8 · exit 42 · 0.2s ────\r\n[test@Predator ~]$ ',
        ),
      ).toBe('\r\n[test@Predator ~]$ ');
    });

    it('case 18', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const dataHandler = capturedListeners.get('terminal:data');
      expect(dataHandler).toBeDefined();

      // 调用匹配 sessionId 的数据事件应无异常
      expect(() => {
        dataHandler?.({ payload: { sessionId: 'main-terminal', data: 'hello\n' } });
      }).not.toThrow();

      wrapper.unmount();
    });

    it('case 19', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 380));

      expect(mockTauriService.writeTerminalInput).not.toHaveBeenCalledWith({
        sessionId: 'main-terminal',
        data: '\n',
      });

      wrapper.unmount();
    });

    it('case 20', async () => {
      mockTerminalInstance.write.mockClear();
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const dataHandler = capturedListeners.get('terminal:data');
      const runChunkHandler = capturedListeners.get('terminal:run-chunk');
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: 'Hello SH Editor\r\n',
          source: 'run',
        },
      });
      runChunkHandler?.({
        payload: {
          sessionId: 'main-terminal',
          runId: 'run-visual-order',
          data: 'Hello SH Editor\r\n',
          seq: 1,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '──── run #1 · exit 0 · 0.3s ────\r\n[test@Predator ~]$ ',
          source: 'injected_separator',
        },
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 32));

      const written = mockTerminalInstance.write.mock.calls.map((call) => call[0]).join('');
      expect(written.indexOf('Hello SH Editor')).toBeGreaterThanOrEqual(0);
      expect(written.indexOf('──── run #1')).toBeGreaterThan(written.indexOf('Hello SH Editor'));
      expect(written.match(/Hello SH Editor/g)).toHaveLength(1);

      wrapper.unmount();
    });

    it('case 21', async () => {
      mockTerminalInstance.write.mockClear();
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const editorStore = useEditorStore();
      const runRoutingStore = useTerminalRunRoutingStore();
      runRoutingStore.setActiveRunSessionId('main-terminal');
      editorStore.setPendingTerminalRunId('run-suppress-interactive');
      await flushPromises();
      mockTerminalInstance.write.mockClear();

      const dataHandler = capturedListeners.get('terminal:data');
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '\x1b[?25l\x1b[m\x1b[HTo run a command as administrator\r\n[test@Predator]$',
          source: 'interactive',
          seq: 301,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '\r\nHello SH Editor\n',
          source: 'run',
          seq: 302,
          runId: 'run-suppress-interactive',
          runSeq: 1,
        },
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 32));

      const written = mockTerminalInstance.write.mock.calls.map((call) => call[0]).join('');
      expect(written).not.toContain('To run a command as administrator');
      expect(written).toContain('Hello SH Editor');

      wrapper.unmount();
    });

    it('case 22', async () => {
      mockTerminalInstance.write.mockClear();
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const dataHandler = capturedListeners.get('terminal:data');
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '──── run #1 · exit 0 · 0.3s ────\r\n[test@Predator ~]$ ',
          source: 'injected_separator',
          seq: 203,
          runId: 'run-visual-order',
          runSeq: 3,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '\r\nHello SH Editor\r\n',
          source: 'run',
          seq: 202,
          runId: 'run-visual-order',
          runSeq: 1,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '\x1b[m',
          source: 'injected_reset',
          seq: 204,
          runId: 'run-visual-order',
          runSeq: 2,
        },
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 32));

      const written = mockTerminalInstance.write.mock.calls.map((call) => call[0]).join('');
      expect(written.indexOf('Hello SH Editor')).toBeGreaterThanOrEqual(0);
      expect(written.indexOf('──── run #1')).toBeGreaterThan(written.indexOf('Hello SH Editor'));

      wrapper.unmount();
    });

    it('case 23', async () => {
      mockTerminalInstance.write.mockClear();
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const dataHandler = capturedListeners.get('terminal:data');
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '──── run #old · exit 0 · 0.1s ────\r\n[test@Predator ~]$ ',
          source: 'injected_separator',
          seq: 900,
          runId: 'old-run-before-listener',
          runSeq: 3,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '──── run #new · exit 0 · 0.3s ────\r\n[test@Predator ~]$ ',
          source: 'injected_separator',
          seq: 903,
          runId: 'new-run',
          runSeq: 3,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '\r\nHello SH Editor\r\n',
          source: 'run',
          seq: 901,
          runId: 'new-run',
          runSeq: 1,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '\x1b[m',
          source: 'injected_reset',
          seq: 902,
          runId: 'new-run',
          runSeq: 2,
        },
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 32));

      const written = mockTerminalInstance.write.mock.calls.map((call) => call[0]).join('');
      expect(written).toContain('Hello SH Editor');
      expect(written).toContain('──── run #new');
      expect(written.indexOf('──── run #new')).toBeGreaterThan(written.indexOf('Hello SH Editor'));

      wrapper.unmount();
    });

    it('case 24', async () => {
      mockTerminalInstance.write.mockClear();
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const dataHandler = capturedListeners.get('terminal:data');
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '\x1b[m',
          source: 'injected_reset',
          seq: 1001,
          runId: 'silent-run',
          runSeq: 1,
        },
      });
      dataHandler?.({
        payload: {
          sessionId: 'main-terminal',
          data: '──── run #2 · exit 0 · 0.1s ────\r\n[test@Predator ~]$ ',
          source: 'injected_separator',
          seq: 1002,
          runId: 'silent-run',
          runSeq: 2,
        },
      });

      await flushPromises();
      await new Promise((resolve) => window.setTimeout(resolve, 32));

      const written = mockTerminalInstance.write.mock.calls.map((call) => call[0]).join('');
      expect(written).toContain('──── run #2');
      expect(written).toContain('[test@Predator ~]$ ');

      wrapper.unmount();
    });

    it('case 25', async () => {
      mockTerminalInstance.write.mockClear();

      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      const writeCallsBefore = mockTerminalInstance.write.mock.calls.length;

      const dataHandler = capturedListeners.get('terminal:data');
      dataHandler?.({ payload: { sessionId: 'OTHER-SESSION', data: 'ignored' } });

      await flushPromises();

      expect(mockTerminalInstance.write.mock.calls.length).toBe(writeCallsBefore);

      wrapper.unmount();
    });
  });

  // ── 7. 卸载清理 ──
  describe('suite 10', () => {
    it('case 26', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();

      expect(capturedListeners.has('terminal:interactive-exited')).toBe(true);

      wrapper.unmount();
      await flushPromises();

      expect(capturedListeners.has('terminal:interactive-exited')).toBe(false);
    });

    it('case 27', async () => {
      const statusChanges: ITerminalStatusChangePayload[] = [];
      const wrapper = mount(createTestComponent(statusChanges), {
        global: { plugins: [createPinia()] },
        attachTo: document.body,
      });

      await flushPromises();
      wrapper.unmount();
      await flushPromises();

      expect(capturedListeners.has('terminal:data')).toBe(false);
    });
  });
});
