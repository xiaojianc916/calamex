import type { Event, UnlistenFn } from '@tauri-apps/api/event';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTerminalEventBus,
  type ITerminalEventBus,
  type TTerminalListen,
} from '@/services/terminal/eventBus';
import { useTerminalFacade } from '@/services/terminal/facade';
import { createTerminalShadowCompareStore } from '@/services/terminal/shadowCompare';
import { useTerminalRuntimeStore } from '@/services/terminal/state';
import type { ITauriService } from '@/types/tauri';
import type {
  ITerminalDataEvent,
  ITerminalExitEvent,
  ITerminalRunCompletedPayload,
  ITerminalRunStartedPayload,
  ITerminalSessionStateChangedPayload,
} from '@/types/terminal';

type TTerminalFacadeTauri = Pick<
  ITauriService,
  | 'ensureTerminalSession'
  | 'dispatchScriptToTerminal'
  | 'cancelTerminalRun'
  | 'writeTerminalInput'
  | 'resizeTerminalSession'
>;

class FakeTerminalEventBus implements ITerminalEventBus {
  readonly start = vi.fn(() => Promise.resolve());
  readonly stop = vi.fn();

  private readonly dataHandlers = new Set<(payload: ITerminalDataEvent) => void>();
  private readonly runStartedHandlers = new Set<(payload: ITerminalRunStartedPayload) => void>();
  private readonly runCompletedHandlers = new Set<
    (payload: ITerminalRunCompletedPayload) => void
  >();
  private readonly interactiveReadyHandlers = new Set<() => void>();
  private readonly interactiveExitedHandlers = new Set<(payload: ITerminalExitEvent) => void>();
  private readonly sessionStateChangedHandlers = new Set<
    (payload: ITerminalSessionStateChangedPayload) => void
  >();

  onTerminalData(handler: (payload: ITerminalDataEvent) => void): UnlistenFn {
    this.dataHandlers.add(handler);
    return () => {
      this.dataHandlers.delete(handler);
    };
  }

  onRunStarted(handler: (payload: ITerminalRunStartedPayload) => void): UnlistenFn {
    this.runStartedHandlers.add(handler);
    return () => {
      this.runStartedHandlers.delete(handler);
    };
  }

  onRunCompleted(handler: (payload: ITerminalRunCompletedPayload) => void): UnlistenFn {
    this.runCompletedHandlers.add(handler);
    return () => {
      this.runCompletedHandlers.delete(handler);
    };
  }

  onInteractiveReady(handler: () => void): UnlistenFn {
    this.interactiveReadyHandlers.add(handler);
    return () => {
      this.interactiveReadyHandlers.delete(handler);
    };
  }

  onInteractiveExited(handler: (payload: ITerminalExitEvent) => void): UnlistenFn {
    this.interactiveExitedHandlers.add(handler);
    return () => {
      this.interactiveExitedHandlers.delete(handler);
    };
  }

  onSessionStateChanged(
    handler: (payload: ITerminalSessionStateChangedPayload) => void,
  ): UnlistenFn {
    this.sessionStateChangedHandlers.add(handler);
    return () => {
      this.sessionStateChangedHandlers.delete(handler);
    };
  }

  emitRunStarted(payload: ITerminalRunStartedPayload): void {
    for (const handler of this.runStartedHandlers) {
      handler(payload);
    }
  }

  emitRunCompleted(payload: ITerminalRunCompletedPayload): void {
    for (const handler of this.runCompletedHandlers) {
      handler(payload);
    }
  }

  emitInteractiveReady(): void {
    for (const handler of this.interactiveReadyHandlers) {
      handler();
    }
  }

  emitInteractiveExited(payload: ITerminalExitEvent): void {
    for (const handler of this.interactiveExitedHandlers) {
      handler(payload);
    }
  }

  emitSessionStateChanged(payload: ITerminalSessionStateChangedPayload): void {
    for (const handler of this.sessionStateChangedHandlers) {
      handler(payload);
    }
  }
}

const createTauriMock = (): TTerminalFacadeTauri => ({
  ensureTerminalSession: vi.fn(() =>
    Promise.resolve({
      sessionId: 'main-terminal',
      cwd: '~',
      shellLabel: 'WSL2',
      created: true,
      initialOutput: null,
    }),
  ),
  dispatchScriptToTerminal: vi.fn((payload) =>
    Promise.resolve({
      sessionId: payload.sessionId,
      cwd: '/workspace',
      commandLine: '/bin/bash /tmp/demo.sh',
      usedTempFile: true,
      startedAt: '2026-04-25T00:00:00.000Z',
    }),
  ),
  cancelTerminalRun: vi.fn(() => Promise.resolve()),
  writeTerminalInput: vi.fn(() => Promise.resolve()),
  resizeTerminalSession: vi.fn(() => Promise.resolve()),
});

describe('terminal facade suite 1', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('terminal facade case 1', async () => {
    const tauri = createTauriMock();
    const eventBus = new FakeTerminalEventBus();
    const facade = useTerminalFacade({ tauri, eventBus });

    await facade.ensureView();
    const runtimeStore = useTerminalRuntimeStore();
    const handle = await facade.dispatchScript({
      sessionId: 'main-terminal',
      path: null,
      workspaceRootPath: null,
      content: 'echo hi',
      isDirty: true,
      runId: 'run-1',
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'booting',
      to: 'idle_interactive',
      atMs: 1777104000000,
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'idle_interactive',
      to: 'switching_to_run',
      atMs: 1777104000100,
    });
    eventBus.emitRunStarted({
      sessionId: 'main-terminal',
      runId: 'run-1',
      startedAtMs: 1777104000200,
      pid: 4242,
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'switching_to_run',
      to: 'running',
      atMs: 1777104000200,
    });

    expect(handle).toMatchObject({
      runId: 'run-1',
      sessionId: 'main-terminal',
      commandLine: '/bin/bash /tmp/demo.sh',
    });
    expect(runtimeStore.getSessionState('main-terminal')).toBe('running');
    expect(facade.activeRun.value?.runId).toBe('run-1');
  });

  it('terminal facade case 2', () => {
    const facade = useTerminalFacade({
      tauri: createTauriMock(),
      eventBus: new FakeTerminalEventBus(),
    });

    expect(facade.routeInput('idle_interactive', null)).toBe('main-terminal');
    expect(
      facade.routeInput('running', {
        runId: 'run-1',
        sessionId: 'run-session-1',
        cwd: '/workspace',
        commandLine: 'bash demo.sh',
        usedTempFile: false,
        startedAt: '2026-04-25T00:00:00.000Z',
      }),
    ).toBe('run-session-1');
    expect(facade.routeInput('switching_to_run', null)).toBeNull();
  });

  it('terminal facade case 3', async () => {
    const eventBus = new FakeTerminalEventBus();
    const facade = useTerminalFacade({ tauri: createTauriMock(), eventBus });

    await facade.ensureView();
    const runtimeStore = useTerminalRuntimeStore();
    await facade.dispatchScript({
      sessionId: 'main-terminal',
      path: null,
      workspaceRootPath: null,
      content: 'echo hi',
      isDirty: true,
      runId: 'run-1',
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'booting',
      to: 'idle_interactive',
      atMs: 1777104000000,
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'idle_interactive',
      to: 'switching_to_run',
      atMs: 1777104000100,
    });
    eventBus.emitRunStarted({
      sessionId: 'main-terminal',
      runId: 'run-1',
      startedAtMs: 1777104000200,
      pid: 4242,
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'switching_to_run',
      to: 'running',
      atMs: 1777104000200,
    });

    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'running',
      to: 'switching_to_idle',
      atMs: 1777104001000,
    });
    eventBus.emitRunCompleted({
      sessionId: 'main-terminal',
      runId: 'run-1',
      exitCode: 0,
      finishedAt: '2026-04-25T00:00:01.000Z',
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'switching_to_idle',
      to: 'idle_interactive',
      atMs: 1777104001001,
    });

    expect(runtimeStore.getSessionState('main-terminal')).toBe('idle_interactive');
    expect(facade.activeRun.value).toBeNull();
  });

  it('terminal facade case 4', async () => {
    const eventBus = new FakeTerminalEventBus();
    const tauri = createTauriMock();
    const dispatchControl: {
      resolve:
        | ((value: Awaited<ReturnType<TTerminalFacadeTauri['dispatchScriptToTerminal']>>) => void)
        | null;
    } = { resolve: null };
    tauri.dispatchScriptToTerminal = vi.fn(
      (payload) =>
        new Promise((resolve) => {
          dispatchControl.resolve = resolve;
          void payload;
        }),
    );
    const facade = useTerminalFacade({ tauri, eventBus });

    await facade.ensureView();
    const runtimeStore = useTerminalRuntimeStore();
    const dispatchPromise = facade.dispatchScript({
      sessionId: 'main-terminal',
      path: null,
      workspaceRootPath: null,
      content: 'echo fast',
      isDirty: true,
      runId: 'run-fast',
    });
    await Promise.resolve();

    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'idle_interactive',
      to: 'switching_to_run',
      atMs: 1777104000100,
    });
    eventBus.emitRunCompleted({
      sessionId: 'main-terminal',
      runId: 'run-fast',
      exitCode: 0,
      finishedAt: '2026-04-25T00:00:01.000Z',
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'switching_to_run',
      to: 'idle_interactive',
      atMs: 1777104001000,
    });
    if (!dispatchControl.resolve) {
      throw new Error('dispatchScriptToTerminal 未进入等待返回状态。');
    }
    dispatchControl.resolve({
      sessionId: 'main-terminal',
      cwd: '/workspace',
      commandLine: '/bin/bash /tmp/fast.sh',
      usedTempFile: true,
      startedAt: '2026-04-25T00:00:00.000Z',
    });

    await dispatchPromise;

    expect(runtimeStore.getSessionState('main-terminal')).toBe('idle_interactive');
    expect(facade.activeRun.value).toBeNull();
  });

  it('terminal facade case 6', () => {
    const shadowCompare = createTerminalShadowCompareStore();
    shadowCompare.start('run-1', 'legacy', 100);
    shadowCompare.start('run-1', 'shadow', 110);
    shadowCompare.appendOutput('run-1', 'legacy', 'hello\n');
    shadowCompare.appendOutput('run-1', 'shadow', 'hello\n');
    shadowCompare.pushState('run-1', 'legacy', 'running');
    shadowCompare.pushState('run-1', 'shadow', 'running');
    shadowCompare.complete('run-1', 'legacy', 140);
    shadowCompare.complete('run-1', 'shadow', 145);

    expect(shadowCompare.compare('run-1')).toMatchObject({
      outputEqual: true,
      byteDiff: 0,
      durationDeltaMs: -5,
      stateSequenceEqual: true,
    });
  });

  it('terminal facade case 7', () => {
    const shadowCompare = createTerminalShadowCompareStore();

    for (let index = 0; index < 50; index += 1) {
      const runId = `shadow-run-${index}`;
      const output = `Hello SH Editor #${index}\n`;
      shadowCompare.start(runId, 'legacy', 1000 + index);
      shadowCompare.start(runId, 'shadow', 1000 + index);
      shadowCompare.pushState(runId, 'legacy', 'switching_to_run');
      shadowCompare.pushState(runId, 'shadow', 'switching_to_run');
      shadowCompare.pushState(runId, 'legacy', 'running');
      shadowCompare.pushState(runId, 'shadow', 'running');
      shadowCompare.appendOutput(runId, 'legacy', output);
      shadowCompare.appendOutput(runId, 'shadow', output);
      shadowCompare.pushState(runId, 'legacy', 'idle_interactive');
      shadowCompare.pushState(runId, 'shadow', 'idle_interactive');
      shadowCompare.complete(runId, 'legacy', 1200 + index);
      shadowCompare.complete(runId, 'shadow', 1200 + index);
    }

    expect(shadowCompare.listComparisons()).toHaveLength(50);
    for (const comparison of shadowCompare.listComparisons()) {
      expect(comparison).toMatchObject({
        outputEqual: true,
        byteDiff: 0,
        durationDeltaMs: 0,
        stateSequenceEqual: true,
      });
    }
  });

  it('per-session 状态事件按会话存储,交互退出后清除', async () => {
    const tauri = createTauriMock();
    const eventBus = new FakeTerminalEventBus();
    const facade = useTerminalFacade({ tauri, eventBus });

    await facade.ensureView();
    const runtimeStore = useTerminalRuntimeStore();

    eventBus.emitSessionStateChanged({
      sessionId: 'session-A',
      from: 'booting',
      to: 'idle_interactive',
      atMs: 1777104000000,
    });
    eventBus.emitSessionStateChanged({
      sessionId: 'session-B',
      from: 'idle_interactive',
      to: 'running',
      atMs: 1777104000100,
    });

    expect(runtimeStore.getSessionState('session-A')).toBe('idle_interactive');
    expect(runtimeStore.getSessionState('session-B')).toBe('running');

    // 会话 A 退出 → 仅清除 A 的镜像态,B 不受影响。
    eventBus.emitInteractiveExited({ sessionId: 'session-A', exitCode: 0 });
    expect(runtimeStore.getSessionState('session-A')).toBeNull();
    expect(runtimeStore.getSessionState('session-B')).toBe('running');
  });

  it('clears switching input retry timer on dispose', async () => {
    vi.useFakeTimers();
    const eventBus = new FakeTerminalEventBus();
    const tauri = createTauriMock();
    const facade = useTerminalFacade({ tauri, eventBus });

    await facade.ensureView();
    eventBus.emitSessionStateChanged({
      sessionId: 'main-terminal',
      from: 'idle_interactive',
      to: 'switching_to_run',
      atMs: 1777104000100,
    });
    await facade.writeInputForCurrentState(new TextEncoder().encode('queued-input'));

    facade.dispose();
    vi.advanceTimersByTime(50);
    expect(tauri.writeTerminalInput).not.toHaveBeenCalled();
  });
});

describe('terminal facade suite 2', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('terminal facade case 9', async () => {
    const handlers = new Map<string, (event: Event<unknown>) => void>();
    const listenMock: TTerminalListen = vi.fn(async (eventName, handler) => {
      handlers.set(eventName, handler as (event: Event<unknown>) => void);
      return () => {
        handlers.delete(eventName);
      };
    });
    const eventBus = createTerminalEventBus(listenMock);
    const runStartedHandler = vi.fn();
    const interactiveReadyHandler = vi.fn();
    const interactiveExitedHandler = vi.fn();

    eventBus.onRunStarted(runStartedHandler);
    eventBus.onInteractiveReady(interactiveReadyHandler);
    eventBus.onInteractiveExited(interactiveExitedHandler);
    await eventBus.start();

    handlers.get('terminal:run-started')?.({
      event: 'terminal:run-started',
      id: 2,
      payload: {
        sessionId: 'main-terminal',
        runId: 'run-2',
        startedAtMs: 1777104000000,
        pid: 4242,
      },
    });
    handlers.get('terminal:interactive-ready')?.({
      event: 'terminal:interactive-ready',
      id: 4,
      payload: undefined,
    });
    handlers.get('terminal:interactive-exited')?.({
      event: 'terminal:interactive-exited',
      id: 5,
      payload: {
        sessionId: 'main-terminal',
        exitCode: 0,
      },
    });

    expect(runStartedHandler).toHaveBeenCalledWith({
      sessionId: 'main-terminal',
      runId: 'run-2',
      startedAtMs: 1777104000000,
      pid: 4242,
    });
    expect(interactiveReadyHandler).toHaveBeenCalledOnce();
    expect(interactiveExitedHandler).toHaveBeenCalledWith({
      sessionId: 'main-terminal',
      exitCode: 0,
    });
  });

  it('terminal facade case 10', async () => {
    const handlers = new Map<string, (event: Event<unknown>) => void>();
    const listenMock: TTerminalListen = vi.fn(async (eventName, handler) => {
      handlers.set(eventName, handler as (event: Event<unknown>) => void);
      return () => {
        handlers.delete(eventName);
      };
    });
    const eventBus = createTerminalEventBus(listenMock);
    const sessionStateChangedHandler = vi.fn();

    eventBus.onSessionStateChanged(sessionStateChangedHandler);
    await eventBus.start();

    handlers.get('terminal:session-state-changed')?.({
      event: 'terminal:session-state-changed',
      id: 6,
      payload: {
        sessionId: 'main-terminal',
        from: 'switching_to_run',
        to: 'running',
        atMs: 1777104000002,
      },
    });

    expect(sessionStateChangedHandler).toHaveBeenCalledWith({
      sessionId: 'main-terminal',
      from: 'switching_to_run',
      to: 'running',
      atMs: 1777104000002,
    });
  });
});
