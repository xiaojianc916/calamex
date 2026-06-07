import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type { BridgeStateEvent } from '@/services/editor/lsp-bridge';
import { __resetLspLifecycleForTesting, useLsp } from './useLsp';

const lspBridgeMock = vi.hoisted(() => {
  const listeners = new Set<(event: BridgeStateEvent) => void>();
  return {
    listeners,
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    isStarted: vi.fn(() => false),
    onStateChange: vi.fn((listener: (event: BridgeStateEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emit(event: BridgeStateEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
});

vi.mock('@/services/editor/lsp-bridge', () => ({
  lspBridge: lspBridgeMock,
}));

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('useLsp lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    lspBridgeMock.listeners.clear();
    lspBridgeMock.start.mockResolvedValue(undefined);
    lspBridgeMock.stop.mockResolvedValue(undefined);
    __resetLspLifecycleForTesting();
  });

  afterEach(() => {
    __resetLspLifecycleForTesting();
    vi.useRealTimers();
  });

  it('作用域销毁时不停止 LSP，避免切屏重建导致服务退出', async () => {
    const root = ref('D:/repo');
    const scope = effectScope();
    let lsp!: ReturnType<typeof useLsp>;

    scope.run(() => {
      lsp = useLsp(root);
    });
    await flush();

    expect(lspBridgeMock.start).toHaveBeenCalledWith('D:/repo');
    expect(lsp.status.value).toBe('running');
    lspBridgeMock.stop.mockClear();

    scope.stop();
    await flush();

    expect(lspBridgeMock.stop).not.toHaveBeenCalled();
    expect(lsp.status.value).toBe('running');
  });

  it('工作区切换时旧启动结果不会覆盖新生命周期', async () => {
    const firstStart = new Promise<void>((resolve) => setTimeout(resolve, 50));
    lspBridgeMock.start.mockReturnValueOnce(firstStart).mockResolvedValueOnce(undefined);
    const root = ref('D:/repo-a');
    const scope = effectScope();
    let lsp!: ReturnType<typeof useLsp>;

    scope.run(() => {
      lsp = useLsp(root);
    });
    await flush();
    expect(lsp.status.value).toBe('starting');

    root.value = 'D:/repo-b';
    await flush();
    await vi.advanceTimersByTimeAsync(50);
    await flush();

    expect(lspBridgeMock.start).toHaveBeenLastCalledWith('D:/repo-b');
    expect(lsp.status.value).toBe('running');
    scope.stop();
  });

  it('崩溃自动重启在工作区变更后失效，不会启动旧 root', async () => {
    const root = ref('D:/repo-a');
    const scope = effectScope();

    scope.run(() => {
      useLsp(root);
    });
    await flush();

    lspBridgeMock.emit({ type: 'crashed', exitStatus: '1' });
    root.value = null;
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(lspBridgeMock.start).toHaveBeenCalledTimes(1);
    expect(lspBridgeMock.stop).toHaveBeenCalled();
    scope.stop();
  });

  it('稳定运行后会重置自动重启计数，避免历史崩溃影响后续健康实例', async () => {
    const root = ref('D:/repo');
    const scope = effectScope();

    scope.run(() => {
      useLsp(root);
    });
    await flush();

    lspBridgeMock.emit({ type: 'crashed', exitStatus: '1' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    lspBridgeMock.emit({ type: 'started' });

    await vi.advanceTimersByTimeAsync(30_000);
    lspBridgeMock.emit({ type: 'crashed', exitStatus: '2' });
    await vi.advanceTimersByTimeAsync(1000);
    await flush();

    expect(lspBridgeMock.start).toHaveBeenCalledTimes(3);
    scope.stop();
  });
});
