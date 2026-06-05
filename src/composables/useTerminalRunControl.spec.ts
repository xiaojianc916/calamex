import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cancelTerminalRun } = vi.hoisted(() => ({
  cancelTerminalRun: vi.fn(),
}));

vi.mock('@/services/tauri', () => ({
  tauriService: {
    cancelTerminalRun,
  },
}));

import { useTerminalRunControl } from '@/composables/useTerminalRunControl';
import { useEditorStore } from '@/store/editor';

describe('useTerminalRunControl', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    cancelTerminalRun.mockReset();
    cancelTerminalRun.mockResolvedValue(undefined);
  });

  it('存在 runId 时请求后端优雅取消并复位运行态', async () => {
    const store = useEditorStore();
    store.isRunning = true;
    store.setPendingTerminalRunId('run-1');

    const { stopRun, isRunning } = useTerminalRunControl();
    await stopRun();

    expect(cancelTerminalRun).toHaveBeenCalledWith({ runId: 'run-1', mode: 'graceful' });
    expect(isRunning.value).toBe(false);
    expect(store.pendingTerminalRunId).toBeNull();
    expect(store.activeRunSummary).toBeNull();
  });

  it('后端找不到运行（完成事件丢失）时仍强制复位前端运行态', async () => {
    cancelTerminalRun.mockRejectedValue(new Error('未找到正在运行的脚本：run-1'));
    const store = useEditorStore();
    store.isRunning = true;
    store.setPendingTerminalRunId('run-1');

    const { stopRun } = useTerminalRunControl();
    await stopRun();

    expect(cancelTerminalRun).toHaveBeenCalledTimes(1);
    expect(store.isRunning).toBe(false);
    expect(store.pendingTerminalRunId).toBeNull();
  });

  it('卡死场景：isRunning 为真但无任何 runId 时不请求后端取消但仍复位', async () => {
    const store = useEditorStore();
    store.isRunning = true;

    const { stopRun, canStopRun } = useTerminalRunControl();
    expect(canStopRun.value).toBe(true);

    await stopRun();

    expect(cancelTerminalRun).not.toHaveBeenCalled();
    expect(store.isRunning).toBe(false);
    expect(canStopRun.value).toBe(false);
  });
});
