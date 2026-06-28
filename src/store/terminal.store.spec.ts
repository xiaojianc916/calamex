import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalRuntimeStore } from '@/store/terminal';
import type { ITerminalRunHandle } from '@/types/terminal';

const createHandle = (
  overrides: Partial<ITerminalRunHandle> & Pick<ITerminalRunHandle, 'runId' | 'sessionId'>,
): ITerminalRunHandle => ({
  cwd: '/workspace',
  commandLine: '/bin/bash /tmp/demo.sh',
  usedTempFile: true,
  startedAt: '2026-06-23T00:00:00.000Z',
  startedAtMs: 1777104000000,
  pid: 4242,
  ...overrides,
});

describe('useTerminalRuntimeStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('初始为 booting 且无活动运行', () => {
    const store = useTerminalRuntimeStore();
    expect(store.state).toBe('booting');
    expect(store.activeRun).toBeNull();
    expect(store.isRunning).toBe(false);
  });

  it('markRunStarted 写入活动运行，全局派生自 per-session 镜像', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(createHandle({ runId: 'run-1', sessionId: 'session-A' }));
    expect(store.activeRun?.runId).toBe('run-1');
    expect(store.getSessionActiveRun('session-A')?.runId).toBe('run-1');
    expect(store.sessionActiveRuns.size).toBe(1);
  });

  it('并发多会话运行互不覆盖，全局指向最近启动的会话', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(createHandle({ runId: 'run-a', sessionId: 'session-A' }));
    store.markRunStarted(createHandle({ runId: 'run-b', sessionId: 'session-B' }));

    // 两个会话各自保留自己的运行——这正是去重要修的「最后一个覆盖」隐患。
    expect(store.getSessionActiveRun('session-A')?.runId).toBe('run-a');
    expect(store.getSessionActiveRun('session-B')?.runId).toBe('run-b');
    expect(store.activeRun?.runId).toBe('run-b');
  });

  it('markRunStarted 同 runId 再次到达时合并句柄，不新增镜像', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(
      createHandle({ runId: 'run-1', sessionId: 'session-A', cwd: '', commandLine: '' }),
    );
    store.markRunStarted(
      createHandle({
        runId: 'run-1',
        sessionId: 'session-A',
        cwd: '/repo',
        commandLine: 'bash x.sh',
      }),
    );
    expect(store.sessionActiveRuns.size).toBe(1);
    expect(store.activeRun?.cwd).toBe('/repo');
    expect(store.activeRun?.commandLine).toBe('bash x.sh');
  });

  it('updateActiveRun 仅在 runId 匹配时合并，否则不动', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(createHandle({ runId: 'run-1', sessionId: 'session-A', pid: null }));
    store.updateActiveRun(createHandle({ runId: 'run-1', sessionId: 'session-A', pid: 9001 }));
    expect(store.activeRun?.pid).toBe(9001);

    store.updateActiveRun(createHandle({ runId: 'run-x', sessionId: 'session-A', pid: 1 }));
    expect(store.activeRun?.runId).toBe('run-1');
    expect(store.activeRun?.pid).toBe(9001);
  });

  it('markRunCompleted 清除匹配运行并使全局回落为空', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(createHandle({ runId: 'run-1', sessionId: 'session-A' }));
    store.markRunCompleted('run-1', 0, '2026-06-23T00:00:01.000Z');
    expect(store.activeRun).toBeNull();
    expect(store.getSessionActiveRun('session-A')).toBeNull();
    expect(store.diagnostics.lastExitCode).toBe(0);
  });

  it('markRunCompleted 只清除匹配会话，其余并发运行不受影响', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(createHandle({ runId: 'run-a', sessionId: 'session-A' }));
    store.markRunStarted(createHandle({ runId: 'run-b', sessionId: 'session-B' }));
    store.markRunCompleted('run-a', 0, '2026-06-23T00:00:01.000Z');
    // 全局指向 run-b（最近），完成的是 run-a → 全局不变。
    expect(store.activeRun?.runId).toBe('run-b');
    expect(store.getSessionActiveRun('session-A')).toBeNull();
    expect(store.getSessionActiveRun('session-B')?.runId).toBe('run-b');
  });

  it('markRunDispatchFailed 清除匹配运行', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(createHandle({ runId: 'run-1', sessionId: 'session-A' }));
    store.markRunDispatchFailed('run-1');
    expect(store.activeRun).toBeNull();
    expect(store.getSessionActiveRun('session-A')).toBeNull();
  });

  it('clearSessionState 清掉会话态与活动运行镜像，全局随之回落', () => {
    const store = useTerminalRuntimeStore();
    store.applySessionStateChanged({
      sessionId: 'session-A',
      from: 'idle_interactive',
      to: 'running',
      atMs: 1,
    });
    store.markRunStarted(createHandle({ runId: 'run-1', sessionId: 'session-A' }));
    store.clearSessionState('session-A');
    expect(store.getSessionState('session-A')).toBeNull();
    expect(store.getSessionActiveRun('session-A')).toBeNull();
    expect(store.activeRun).toBeNull();
  });

  it('applySessionStateChanged / getSessionState 按会话隔离记录', () => {
    const store = useTerminalRuntimeStore();
    store.applySessionStateChanged({
      sessionId: 'session-A',
      from: 'booting',
      to: 'idle_interactive',
      atMs: 1,
    });
    store.applySessionStateChanged({
      sessionId: 'session-B',
      from: 'idle_interactive',
      to: 'running',
      atMs: 2,
    });
    expect(store.getSessionState('session-A')).toBe('idle_interactive');
    expect(store.getSessionState('session-B')).toBe('running');
  });

  it('applyStateChanged 驱动全局 state 与 isRunning', () => {
    const store = useTerminalRuntimeStore();
    store.applyStateChanged({ from: 'switching_to_run', to: 'running', atMs: 1 });
    expect(store.state).toBe('running');
    expect(store.isRunning).toBe(true);
    store.applyStateChanged({ from: 'running', to: 'idle_interactive', atMs: 2 });
    expect(store.isRunning).toBe(false);
    expect(store.interactiveReady).toBe(true);
  });

  it('reset 清空运行态、会话镜像与全局指针', () => {
    const store = useTerminalRuntimeStore();
    store.markRunStarted(createHandle({ runId: 'run-1', sessionId: 'session-A' }));
    store.applyStateChanged({ from: 'switching_to_run', to: 'running', atMs: 1 });
    store.reset();
    expect(store.state).toBe('booting');
    expect(store.activeRun).toBeNull();
    expect(store.sessionActiveRuns.size).toBe(0);
    expect(store.sessionStates.size).toBe(0);
    expect(store.isRunning).toBe(false);
  });
});
